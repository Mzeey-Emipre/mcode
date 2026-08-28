# Narrative Pipeline Guide

The narrative timeline is the chronological audit trail rendered inside each
assistant turn: tool calls, sub-agents, thoughts, hooks, and the streaming
response. It looks simple. It is not. This guide documents the contracts and
the specific traps we hit so the next person doesn't trip on them.

If you are about to touch any of these files, **read this first**:

- `apps/server/src/features/providers/` (runtime event source and provider projection)
- `apps/server/src/features/agents/conversation/narrative/narrative-store.ts` (write seam: enrichment +
  classification + persistence; owns the per-turn buffers and the
  `agentCallStack`. Also owns the read seam, `load`.)
- `apps/server/src/features/agents/orchestration/agent-service.ts` (turn orchestration; delegates
  the write seam to NarrativeStore and retains turn-level concerns: turn snapshots,
  `turn.persisted` broadcast, and late-hook flushing)
- `apps/server/src/index.ts` (broadcast layer)
- `apps/web/src/stores/threadStore.ts` (validated AgentEvent projection and
  client volatile state lifecycle)
- `apps/web/src/stores/conversation-residency.ts` (selected conversation
  residency, bounded retention, refresh, pagination, and prefetch routing)
- `apps/web/src/components/chat/narrative/*` (renderers)
- `apps/web/src/components/chat/virtual-items.ts` (timeline insertion point)

---

## End-to-end data flow

```
Provider-native event
    │
    ▼
Provider runtime event keeps native evidence separate from AgentEvent data
    │
    ▼
Provider ingress validates, queues, and selects a provider adapter
    │
    ▼
Adapter forwards a provider-neutral AgentEvent or consumes private provider work
    │
    ▼
Turn event pipeline ToolUse handler → narrative-store.ts bufferToolCall
  (writes to the per-turn tool-call buffer for later persist)
    │
    ▼
Turn event pipeline enriches missing parentToolCallId via
  narrativeStore.getCurrentParentToolCallId (agentCallStack fallback)
    │
    ▼
broadcast("agent.event", enrichedEvent)
    │
    ▼
ws-events.ts validates and forwards AgentEvent directly to threadStore.handleAgentEvent
    │
    ▼
threadStore.ts projects the validated event into the resident Thread record
    │
    ▼
buildNarrativeItems groups by parentToolCallId → SubagentRow children
    │
    ▼
virtual-items.ts splits live turn into three slots:
  narrative-flow (timeline) → provisional assistant message (typing bubble slot)
  → narrative-indicator (step/subagent meta below the response)
    │
    ▼
NarrativeFlow + MessageBubble + NarrativeIndicator render live turn
    │
    ▼
PersistedTurnFooter appears after narrative.list RPC resolves
```

Every step has at least one trap. Read on.

Provider-native identity and child evidence stay before the adapter boundary.
The narrative pipeline, WebSocket payload, and renderer receive only
provider-neutral `AgentEvent` data. This keeps child lifecycle persistence
private while preserving normal sub-agent rows in the parent timeline.

### Renderer ownership

`ConversationResidency`, registered by `threadStore`, is the renderer's only
conversation authority. It selects and restores a Thread's persisted
conversation, retains inactive records within the bounded cache, and routes
refresh, pagination, and prefetch work to `ThreadHydrator`. `workspaceStore`
owns rows and selection, not a second conversation cache or restore path.

The server owns durable messages and persisted narrative metadata. The renderer
projects validated `AgentEvent` values into each resident Thread record. This
split preserves the volatile Turn layer through `turn.persisted`; persistence
confirms durable narrative data but does not end the live timeline.

---

## Thought vs final response classification

Multiple layers classify streamed text. Use this precedence when debugging
misclassified preamble or duplicate assistant bodies:

1. **`AssistantMessageBoundary`** (authoritative) — emitted from
   `claude-provider.ts` when an SDK `assistant` message carries text and a
   `stop_reason`. `{end_turn, stop_sequence, max_tokens}` → final response;
   everything else (including `tool_use`) → preamble/thought.
2. **`TextDelta.isFinalResponse`** (stream hint) — best-effort flag set on
   `content_block_delta` when all tools have resolved and at least one tool
   fired this turn. May be absent on tool-free turns; boundary event wins.
3. **Client segment routing** — `threadStore` retracts or closes the open
   thought segment on `session.assistantMessageBoundary`. Final response text
   stays in the thread streaming buffer and renders via a provisional
   assistant message item, not `thoughtSegmentsByThread`.
4. **Persist suffix match** — `narrative-store.ts` `persistNarrative` tags the
   last matching thought row `is_final_response` before DB insert as a safety
   net for older rows or reconnect gaps.

**Don't break this:** dropping the boundary handler or counting thought
segments in `NarrativeIndicator.stepCount` will diverge live counts from
`PersistedTurnFooter` (Trap 6).

---

## Trap 1: `parent_tool_use_id` is the only source of truth for parallel sub-agents

**Symptom.** Four sub-agents dispatched in parallel. Three of them render with
no nested children; one of them has all twelve calls clumped underneath.

**Root cause.** The `agentCallStack` is a LIFO of Agent tool call IDs pushed
in dispatch order. `getCurrentParentToolCallId` returns the top of the stack.
For sequential dispatch this works. For parallel dispatch the stack ends as
`[a1, a2, a3, a4]` and the top is always `a4` — so every child gets
misattributed to `a4`.

**The rule.** The Claude Agent SDK puts `parent_tool_use_id` on every stream
message that originates inside a sub-agent. **That is the authoritative
source.** The agent-call stack is only a fallback for code paths where the
SDK doesn't surface this field (older paths, edge cases).

**Where this is wired:**

- `claude-provider.ts` reads `anyMsg.parent_tool_use_id` and forwards it as
  `parentToolCallId` on the `ToolUse` event.
- `index.ts` checks `if (event.parentToolCallId)` first — if set,
  leave it. Only falls back to `narrativeStore.getCurrentParentToolCallId`
  when the SDK omitted it.
- `narrative-store.ts bufferToolCall` does the same dance for the persistence
  buffer: SDK value wins, stack is a fallback. (AgentService's `bufferToolCall`
  is a thin wrapper that delegates here, then persists TodoWrite task state.)

**Stack fallback contract:** `getCurrentParentToolCallId` does **not** return
`stack[stack.length - 1]`. It only returns a parent when **exactly one** Agent
ID on `agentCallStack` still has `status: "running"` in the in-memory turn
buffer. Otherwise it returns `undefined` so coordinator tool calls after
parallel subagents do not inherit the last subagent as their parent. Nested
agents with two running Agent rows rely on the SDK field (as they should).

**Don't break this:** any new code path that emits `ToolUse` events must
read `parent_tool_use_id` from the SDK message and propagate it as
`parentToolCallId` on the event. If you write to the buffer or broadcast
without it, parallel sub-agents will silently lose nesting.

---

## Trap 2: do NOT clear `agentCallStack` on `textDelta`

**Symptom.** A sub-agent's children stop nesting partway through its run —
new child tool calls appear at the top level instead of under the parent.

**Root cause.** The Claude SDK emits `textDelta` events from sub-agents
while they are still issuing child tool calls. An earlier version of the
agent-service cleared `agentCallStack` on `textDelta` events, reasoning that
"if the agent is producing text, it's wrapping up." That was wrong — a
sub-agent emits text mid-flight, and clearing the stack causes subsequent
child `toolUse` events to lose their fallback parent ID.

**The rule.** `agentCallStack` is only cleared:

1. When a `toolResult` arrives for an Agent call (the agent finished — pop it
   from the stack via `updateBufferedToolCallOutput`).
2. When a final `Message` event arrives (turn over — clear the whole stack).
3. When the session ends.

**Never on `textDelta`. Never on streaming events.** The stack now lives on
`narrative-store.ts`; its `openOrExtendThought` (the textDelta path) never
touches `agentCallStack`. See the explanatory comment in the AgentService
`TextDelta` handler.

---

## Trap 3: client volatile state survives `turn.persisted`

**Symptom.** Agent finishes, the assistant message renders, but the timeline
above it disappears. User reports "we're not seeing logs after the agent
finished."

**Root cause.** The previous design rendered a `ToolCallSummary` block under
each persisted assistant message that lazy-fetched tool call records from
SQLite. We deleted that component when we introduced `TurnFooter`. But the
client store was still clearing volatile state on `turn.persisted` — the
narrative timeline relies on `toolCallsByThread`, `thoughtSegmentsByThread`,
and `hooksByThread` being non-empty. With them cleared, the
`narrative-flow` virtual item stops being emitted.

**The rule.** Volatile narrative state for a thread lives from the first
`session.toolUse` of a turn until the **next** turn begins. Specifically:

| Event                       | Action                                                     |
| --------------------------- | ---------------------------------------------------------- |
| `session.turnStarted` (new) | Clear toolCalls / thoughts / hooks / start fresh           |
| `session.toolUse`           | Append                                                     |
| `session.toolResult`        | Update                                                     |
| `session.thoughtSegment`    | Append                                                     |
| `session.turnComplete`      | Keep everything; mark tool calls `isComplete: true`        |
| `turn.persisted`            | Keep everything — DB write is informational only           |
| Next `sendMessage` call     | Clear toolCalls / thoughts / hooks (belt-and-suspenders)   |

`agentStartTimes[threadId]` follows the same lifecycle as the audit trail —
**do not clear it on `turnComplete`** or `TurnFooter` will lose its
`startTime` reference and the `completedDurationMs` `useMemo` returns null,
making the footer show "—" for duration.

**Don't break this:** any future "cleanup on turn end" code that touches
`toolCallsByThread`, `thoughtSegmentsByThread`, `hooksByThread`, or
`agentStartTimes` must clear at `turnStarted` / `sendMessage` time, not at
`turnComplete` / `turn.persisted` time.

**Known follow-up:** on a full page reload, the volatile state is lost, so
completed-turn audit trails for previously-rendered turns don't reappear.
The fix is to hydrate from `tool_call_records` (and a future
`thought_segments` / `hook_executions` table) when loading messages. Not
done yet.

---

## Trap 4: do NOT mutate the React-owned DOM tree for the typing cursor

**Symptom.** Random `NotFoundError: Failed to execute 'insertBefore' on
'Node': The node before which the new node is to be inserted is not a child
of this node.` crashing the whole `NarrativeFlow` subtree mid-stream. The
visible artifact is that sub-agent rows render but their bodies stay empty,
because the commit phase aborted before reconciling them.

**Root cause.** An earlier version of `DeltaBlock.tsx` tried to inject the
typing cursor inline at the end of the last text node by calling
`target.appendChild(cursor)` inside `useLayoutEffect`. React's fiber tree
still thought the cursor was a direct child of the root `<div>`. When the
markdown content changed mid-stream, React's commit phase called
`insertBefore` on the root's children list — the cursor wasn't where it
expected, so the call threw, and the commit was aborted.

A naive cleanup function that restored the cursor to root on unmount
**did not fix this** — React's mid-render reconciliation can run
`insertBefore` *before* the cleanup gets a chance to fire.

**The rule.** Never `appendChild`, `insertBefore`, `removeChild`, or
`replaceChild` against a node that lives inside a React-managed subtree.
React owns the children list of every element it rendered, and any mutation
that contradicts the fiber tree's expectation throws.

**The fix used in `DeltaBlock.tsx`:** keep the cursor as a permanent sibling
inside the root div (React-managed, never moved). After every render, a
`useLayoutEffect` measures the bounding rect of the END of the last
text-bearing element via `document.createRange()` + `collapse(false)`, and
sets `left` / `top` / `height` inline styles on the cursor (which uses
`position: absolute`). The DOM tree React rendered is left untouched.

**Don't break this:** if you need to overlay something visually inside a
React subtree, either:

1. Position absolutely against a measured rect (this pattern).
2. Use `ReactDOM.createPortal` to render into a node React knows about.
3. Render the overlay element as a sibling at the root level and use CSS
   to position it.

Do not reach for `appendChild` ever again.

---

## Trap 5: `useMemo` cannot contain `Date.now()` for "freeze on completion"

**Symptom.** `TurnFooter` duration displays "—" even though the turn
completed and the timestamps look right.

**Root cause.** An early version of `NarrativeFlow.tsx` computed
`completedDurationMs` inside a `useMemo` using `Date.now()`. Two problems:
(1) `useMemo` is supposed to be pure, and using a non-deterministic source
makes the cache key meaningless; (2) on re-renders triggered by `toolCalls`
or `thoughtSegments` array reference changes (which happen even after the
turn ends, e.g. on reconnect replay), `Date.now()` re-samples and the
duration drifts.

**The rule.** To freeze a wall-clock value at a state transition, use
`useState` + `useEffect`:

```tsx
const [completedAt, setCompletedAt] = useState<number | null>(null);

useEffect(() => {
  if (isAgentRunning) {
    setCompletedAt(null);  // reset on turn restart
  } else if (completedAt == null) {
    setCompletedAt(Date.now());  // snapshot on first not-running render
  }
}, [isAgentRunning, completedAt]);

const completedDurationMs = useMemo<number | null>(() => {
  if (isAgentRunning || startTime == null || completedAt == null) return null;
  return Math.max(0, completedAt - startTime);
}, [isAgentRunning, startTime, completedAt]);
```

The snapshot lives in state (so it survives re-renders), gets set exactly
once when `isAgentRunning` flips false, and resets when a new turn starts.

---

## Trap 6: `topLevel.length` includes Agent calls in the step count

This is **intentional**, not a bug. Documenting it here because reviewers
have flagged it twice as a "double-count."

`NarrativeCounts.steps` counts every top-level tool call — including Agent
calls. `NarrativeCounts.subagents` separately counts top-level Agent calls.
So a turn with 3 Reads and 1 Agent reads as "4 steps · 1 sub-agent" — the
sub-agent is one of the four steps, not a fifth.

The labeling in `TurnFooter` reads correctly as "N steps, of which K were
sub-agents." Don't try to "fix" this by subtracting Agent calls from
`steps`. See the doc comment on `NarrativeCounts.steps`
(`apps/web/src/components/chat/narrative/types.ts`) for the canonical
semantics.

---

## Testing checklist for narrative changes

When you modify any file in the pipeline above, verify all of these manually
before reporting the change done:

- **Single tool call:** sends, completes, shows under timeline, persists.
- **Sequential sub-agents:** parent calls Agent A, A completes, parent calls
  Agent B. Both A's and B's children nest under the right parent.
- **Parallel sub-agents:** parent calls 4 Agents in one assistant turn.
  All four show their own children nested correctly. None of the children
  appear at top level.
- **Nested sub-agents:** Agent A dispatches Agent B. B's children nest under
  B, which nests under A.
- **Thoughts mid-tool-call:** thought rows interleave with tool calls in
  chronological order.
- **Long thought:** clamps to 2 lines with `show more` toggle.
- **Streaming response:** typing cursor sits inline at the end of the last
  word — not on its own line below the last paragraph.
- **Turn completion:** timeline stays visible, `TurnFooter` appears with
  steps/thoughts/sub-agents counts and a stable duration.
- **Next turn:** sending a new message clears the previous trail and starts
  a fresh timeline.
- **Browser console:** no `NotFoundError`, no React warnings.

The unit suite at `apps/web/src/components/chat/narrative/__tests__/`
covers the count derivation but not the full event flow. Manual
verification via the running app is required.

---

## Quick-reference invariants

If you change something and one of these stops being true, you are about to
ship a bug:

1. Every `ToolUse` event broadcast to the client carries `parentToolCallId`
   (either from SDK or from the agentCallStack fallback).
2. `agentCallStack` is mutated only by `bufferToolCall` (push on Agent),
   `updateBufferedToolCallOutput` (pop on Agent result), and the
   `Message`-event clear at end of turn.
3. `toolCallsByThread`, `thoughtSegmentsByThread`, `hooksByThread`, and
   `agentStartTimes` survive `turnComplete` and `turn.persisted`. They are
   cleared only at `turnStarted` / `sendMessage`.
4. No React-rendered DOM node is moved via `appendChild` / `insertBefore` /
   etc.
5. Wall-clock snapshots use `useState` + `useEffect`, not `useMemo`.
6. `NarrativeCounts.steps` is the count of top-level tool calls only — not
   thought segments. Live `narrative-indicator` must use the same definition.
7. Final response text renders as a provisional assistant message item;
   preamble text renders as thought rows inside `narrative-flow`. The
   `AssistantMessageBoundary` event is the authoritative split.
