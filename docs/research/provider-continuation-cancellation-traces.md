# Provider continuation and cancellation traces

## Scope and verdict

This planning note records exact event-order evidence for nested children, late
activity, follow-up turns, interruption, replay, and provider-triggered parent
continuation. It is not a production specification. Each matrix cell is marked
with one evidence status: observed, specified, locally tested, unsupported, not
observed, or blocked.

The durable rule is to preserve Mcode `threadId`, `turnId`, and `eventId`, while
retaining optional native identifiers. Mcode must not fabricate provider IDs.
Provider capability and evidence provenance must travel with every normalized
trace. Turn interruption, child cancellation, and session shutdown are separate
operations.

## Sources and local evidence

Required local sources were read: `CONTEXT.md`, `ARCHITECTURE.md`,
`docs/guides/narrative-pipeline.md`, `docs/guides/provider-architecture.md`,
`docs/guides/ui-components.md`, `docs/guides/performance-audit.md`, and
`docs/guides/db-migrations.md`.

Issue decisions: [#1110](https://github.com/Mzeey-Empire/mcode/issues/1110#issuecomment-5194130424)
and [#1119](https://github.com/Mzeey-Empire/mcode/issues/1119) define the
continuation and trace questions.

Provider references: [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
[Claude CLI usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage),
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python),
[Copilot streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events),
[Copilot custom agents](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents),
[ACP updates](https://agentclientprotocol.com/updates),
[ACP cancellation RFD](https://agentclientprotocol.com/rfds/request-cancellation),
[Cursor parameters](https://docs.cursor.com/en/cli/reference/parameters), and
[Cursor CLI usage](https://docs.cursor.com/en/cli/using).

Commands used for capability checks:

```text
gh issue view 1110 --repo Mzeey-Empire/mcode --json number,title,body,state,url,labels,assignees,comments
gh issue view 1119 --repo Mzeey-Empire/mcode --json number,title,body,state,url,labels,assignees,comments
codex --version                         # 0.146.0
codex app-server --help
codex app-server generate-json-schema --help
claude --version                        # 2.1.222
claude --help
copilot --version                       # 1.0.57
copilot --help
cursor-agent --version                  # 2026.04.29-c83a488
cursor-agent --help
rg "parentToolCallId|parentProviderItemId|turn.persisted" apps packages docs  # representative search
```

The Codex schema command produced no schema. No model-consuming provider turns
were run and no new raw fixture was captured. The installed `cursor-agent` build
lacks the ACP subcommand even though the repository capture script expects
`agent acp`; generic ACP was not live-probed, and `copilot --acp` was not started.
Cursor ACP live validation is therefore blocked.

## Evidence layers

### Provider-native facts

- Codex specifies thread, turn, and item lifecycle; steering continues a live
  turn; interrupt yields an interrupted outcome; replay is bounded. It does not
  specify a normative child-event order.
- Claude streams resumable sessions and supports forks and subagents. Native
  `parent_tool_use_id` and `stop_reason` delimit the useful boundaries, but the
  public material does not define a complete nested ordering.
- Copilot envelopes carry `id`, `timestamp`, `parentId`, `agentId`, and
  `ephemeral`. A subagent sequence is selected, started, completed or failed,
  then deselected. Typical assistant work ends at `session.idle`; abort and
  replay distinguish persisted from ephemeral events.
- ACP has stable session, resume, and close concepts. `session/cancel` is
  current protocol behavior; generalized cancellation and out-of-turn v2
  prompting are draft RFDs.
- Cursor documents stream-json, resume, and history. It does not document a
  generic child identity or parent continuation protocol.

### Mcode normalization

The normalized event carries Mcode IDs and optional native IDs. Local anchors:
[Codex mapper](../../apps/server/src/providers/codex/codex-event-mapper.ts#L390),
[Codex subagent tests](../../apps/server/src/providers/codex/__tests__/codex-provider-subagent-turn.test.ts#L1),
[Claude provider](../../apps/server/src/providers/claude/claude-provider.ts#L1),
[Copilot provider](../../apps/server/src/providers/copilot/copilot-provider.ts#L333),
[ACP runtime](../../apps/server/src/providers/acp/acp-session-runtime.ts#L1),
[Cursor fixture README](../../apps/server/src/providers/cursor/__tests__/fixtures/README.md#L1),
[Cursor event mapper](../../apps/server/src/providers/cursor/cursor-stream-event-mapper.ts#L1),
[Cursor turn runner](../../apps/server/src/providers/cursor/cursor-turn-runner.ts#L1),
and the [narrative pipeline](../guides/narrative-pipeline.md#L1).

```ts
type TraceEvent = {
  threadId: string; turnId: string; eventId: string;
  type: 'turn.started'|'item.started'|'item.delta'|'item.completed'|
    'child.started'|'child.completed'|'turn.completed';
  providerThreadId?: string; providerTurnId?: string; providerItemId?: string;
  providerAgentId?: string; parentProviderItemId?: string;
  parentEventId?: string; generation: number;
  provenance: 'provider-native'|'mcode-normalized'|'inference'|'unknown';
};
```

Immutable native IDs plus generation bind late and out-of-order events. A child
completion cannot settle its parent. Early events use bounded buffers. Replay
hydrates persisted events with dedupe; it does not promise ephemeral or current
state. No implicit parent resume is allowed. A provider-triggered continuation
creates a new Mcode turn with explicit provenance.

### Inferences and unknowns

The ordering below is a planning model inferred from provider envelopes and local
adapters. It is not a claim that every provider emits every marker. Unknown
native ordering remains unknown until a fixture or specification proves it.

## Complete evidence matrix

Legend: O observed; S specified; T locally tested; U unsupported; N not observed;
B blocked. “Observed” means a local trace or fixture exists. “Specified” means a
provider document defines it. “Locally tested” means adapter tests or a golden
fixture assert it.

| Provider | Nested children | Late activity | Follow-up turn | Interruption | Replay | Parent continuation |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | T: child thread routing; S: no child order | T: immutable late mapping; T: bounded early queue | S: steer same turn; T: mapper | S: interrupted; T: interrupt path | S: bounded replay; T: dedupe mapping | N: no native child-specific parent resume |
| Claude | T: `parent_tool_use_id`; N: full order | T: stop boundary and late ignore | T: synthetic Mcode turn after result | T: provider interrupt | S: resume/fork; N: full replay order | T: provider result triggers new Mcode turn |
| Copilot | S: selected→started→completed/failed→deselected | N: late child ordering | S: idle ends turn; N: follow-up order | S: abort; T: disconnect stop | S: persisted vs ephemeral; N: full hydrate | N: no parent continuation contract |
| ACP | U: no generic child model | N: late order | S: session prompt; U: out-of-turn v2 | S: `session/cancel`; B: live CLI | S: resume; N: event replay order | U: no generic provider continuation |
| Cursor | O: parent task completes before late `cursor/task` metadata; no `parentToolCallId` or child stream | T: local fixture shows late metadata | S: resume/history; N: follow-up ordering | N: no documented event contract | S: history/resume; N: ephemeral semantics | U: no parentToolCallId or continuation |

## Provider trace narratives

### Codex

Expected native sequence: `thread.started → turn.started → item.started →
item.delta* → item.completed → turn.completed`. Steering inserts another prompt
into the same turn. Interrupt is `turn/interrupt`; terminal output is
`turn/completed` with `turn.status: interrupted`.
Local mapping proves native thread, turn, and item IDs, child-thread routing,
bounded early buffering, immutable late/replay mappings, and child completion not
settling the parent. Child order is unknown.

### Claude

The adapter receives a parent tool-use marker, emits child events carrying
`parent_tool_use_id`, observes `stop_reason`, and persists the parent boundary.
After a provider result, local behavior emits synthetic Mcode `TurnStarted` for a
provider-triggered continuation. Interrupt terminates the active stream. Claude
resume and fork are specified, but nested order and replay completeness remain
unknown.

### Copilot

Normalize envelope IDs directly: `id`, `parentId`, and `agentId` become optional
native fields, while `ephemeral` controls replay persistence. A child normally
flows selected, started, completed or failed, deselected. The adapter currently
ends a turn at `session.idle`, disconnects to stop, and drops nested IDs, so child
identity mapping is a required planning change.

### ACP

Use stable session identity and `session/cancel`; keep session close distinct from
turn interruption. Resume is a hydration operation, not proof of event replay.
The installed runtime cannot exercise ACP because its CLI lacks the expected ACP
command. Do not claim generic children or out-of-turn prompting until the RFD is
implemented and tested.

### Cursor

Local fixture: a parent task tool call and completion arrive before late
`cursor/task` metadata. There is no `parentToolCallId` or child tool stream in the fixture.
Therefore preserve event order by arrival and bind any future child using an
immutable native ID if Cursor adds one. Stream-json resume/history are documented;
parent continuation is unsupported.

## Proposed normalized contract fixtures

These are proposed contract fixtures, not captured raw traces.

```json
{"threadId":"m-t1","turnId":"m-u1","eventId":"e1","type":"turn.started","providerThreadId":"ct1","providerTurnId":"cu1","generation":1,"provenance":"provider-native"}
{"threadId":"m-t1","turnId":"m-u1","eventId":"e2","type":"child.started","providerItemId":"ci1","parentProviderItemId":"ci0","parentEventId":"e1","generation":1,"provenance":"mcode-normalized"}
{"threadId":"m-t1","turnId":"m-u1","eventId":"e3","type":"child.completed","providerItemId":"ci1","parentProviderItemId":"ci0","generation":1,"provenance":"provider-native"}
{"threadId":"m-t1","turnId":"m-u2","eventId":"e4","type":"turn.started","providerTurnId":"cu2","generation":2,"provenance":"mcode-normalized"}
```

Late events retain the original IDs and generation. A duplicate replay event is
deduped by immutable provider ID plus event type. An unknown provider event is
stored as unknown, not converted into a fabricated child or continuation.

## Planning decisions and acceptance gates

1. Preserve Mcode IDs and optional native IDs listed above.
2. Declare provider capability and evidence provenance per trace.
3. Keep turn interruption, child cancel, and session shutdown distinct.
4. Require explicit continuation intent; synthetic turns include provenance.
5. Map Copilot child identities when envelopes provide them.
6. Keep ACP and Cursor generic child support unsupported until evidenced.
7. Use bounded early buffers and immutable late-event bindings.
8. Add fixtures before changing event-pipeline behavior.

### Required sequence assertions

- Normal parent completion must end with exactly one `turn.completed` for the
  parent Mcode turn, even when children completed earlier.
- Child cancellation must record the child identity and leave the parent turn
  open unless the provider explicitly reports parent interruption.
- Turn interruption must reject stale deltas from the prior generation and
  preserve the interruption reason when the provider supplies one.
- Session shutdown may close transport and all children, but it must not be
  rewritten as a successful turn completion.
- A follow-up prompt that reuses a provider session still receives a fresh
  Mcode turn ID unless the provider explicitly defines same-turn steering.
- A provider-triggered continuation must reference the triggering event and use
  a new generation when it creates a synthetic turn.
- Replay must not re-emit ephemeral Copilot events as durable narrative items.
- Late child metadata must attach by immutable native ID, never by the latest
  active child or by array position.

### Provenance vocabulary

`provider-native` means the provider emitted the identifier or lifecycle marker.
`mcode-normalized` means the adapter translated a provider event without adding
semantic claims. `inference` means ordering inferred from multiple observations.
`unknown` means the adapter retained an event while declining to classify it.
`blocked` is reserved for an unavailable runtime or missing provider capability.

These labels belong in fixture metadata and review notes. They are not user-facing
status text and must not be used to imply confidence beyond the evidence.

Acceptance requires one fixture per provider for normal completion, interruption,
late activity, replay, and follow-up. Nested and parent-continuation fixtures are
required only where the provider declares those capabilities. Live ACP remains
blocked by the missing CLI command.

## Out of scope

This note does not modify provider adapters, schemas, persistence, UI, migrations,
or runtime behavior. It does not invent native IDs, promise undocumented child
ordering, or treat a session shutdown as an interrupted turn.
