# Codex app-server notification trace (evidence-backed spec)

Source traces: `/tmp/codex-trace/A.ndjson`, `/tmp/codex-trace/B.ndjson` captured against `codex-cli 0.130.0` on Windows, ChatGPT auth, sandbox auto-downgraded to `readOnly`, `approvalPolicy: "never"`, default `reasoningEffort: "low"`. cwd: a disposable git repo.

Trace harness: `scripts/codex-trace.mjs` (spawns `codex app-server`, NDJSON JSON-RPC 2.0, records every inbound notification in order).

Runtime trace: set `MCODE_CODEX_TRACE=1` to log each app-server notification plus mapped `AgentEvent` summaries while reproducing narrative issues in Mcode.

## Executive summary

Across both runs, Codex split "thinking" from "answer" cleanly at the wire: anything user-facing arrived only via `item/agentMessage/delta` (and its bookending `item/started` / `item/completed` for type `agentMessage`). The `reasoning` item arrived as a single `item/started` + `item/completed` with `summary.length === 0` and no `item/reasoning/*` delta stream fired at all on low reasoning effort. So in practice, Mcode only has one verified non-final channel today, but several schema-declared ones (`item/reasoning/textDelta`, `summaryTextDelta`, `item/plan/delta`) that did not fire in these runs and remain unverified.

## Notification inventory (observed)

| Method | Meaning | Position | Evidence |
|---|---|---|---|
| `remoteControl/status/changed` | Lifecycle, IDE control state | very early (seq 1, before thread/start result) | A:1, B:1 |
| `thread/started` | Thread session became active | post-`thread/start` | A:2, B:2 |
| `mcpServer/startupStatus/updated` | MCP server boot progress | early, repeats | A:3,4 / B:3,4 |
| `thread/status/changed` | Thread state transition (idle ↔ running) | brackets each turn | A:5,17 / B:5,35 |
| `turn/started` | Turn began | first event of turn | A:6 / B:6 |
| `item/started` (userMessage) | Codex echoes the user's input as an item | top of turn | A:7 / B:7 |
| `item/completed` (userMessage) | Echo finalized | immediately after | A:8 / B:8 |
| `account/rateLimits/updated` | Quota snapshot | mid-turn, multiple | A:9,16 / B:9,11,34 |
| `thread/tokenUsage/updated` | Streaming usage refresh | mid-turn | B:10,33 |
| `item/started` (reasoning) | Reasoning item opened | before tool calls / message | A:10 |
| `item/completed` (reasoning) | Reasoning closed with `summaryLen: 0` | A:11 (no text payload) | A:11 |
| `item/started` (commandExecution) | Shell command starting | between reasoning and final message | B:12 |
| `item/commandExecution/outputDelta` | Streaming stdout/stderr token | repeated | B:13,14 |
| `item/completed` (commandExecution) | Command finished, includes `command`, `aggregatedOutput`, `exitCode` | after command stream | B:15 |
| `item/started` (agentMessage) | Assistant text item began | after tools in these traces | A:12 / B:16 |
| `item/agentMessage/delta` | Streaming assistant text token | many | A:13 / B:17-31 |
| `item/completed` (agentMessage) | Assistant text item closed | end of answer stream in these traces | A:14 / B:32 |
| `turn/completed` | Turn ended with `status: "completed"`, `turn.items` length 0 | terminal | A:18 / B:36 |

`turn.items` was **empty** (`itemsLen: 0`) in both completed turns. Streaming items are the only place children appear; the post-hoc `turn.items` array was not populated in this CLI version. Code that depends on `turn.items` to reconstruct child order is unsafe — trust live ordering.

## Thinking vs final answer mapping

| Method | Route in Mcode | Evidence |
|---|---|---|
| `item/agentMessage/delta` | non-final `TextDelta`; later `AssistantMessageBoundary` promotes the last assistant item on main turn completion | A:13, B:17-31 stream the user-facing answer |
| `item/reasoning/textDelta` | `TextDelta` with `isFinalResponse: false` (thought) | **unverified in this run** — low effort produced no deltas |
| `item/reasoning/summaryTextDelta` | `TextDelta` with `isFinalResponse: false` (thought) | unverified — no deltas in either run |
| `item/reasoning/summaryPartAdded` | ignore (lifecycle) | unverified |
| `item/plan/delta` | `TextDelta` with `isFinalResponse: false` (thought, experimental) | unverified |
| `item/completed` type `reasoning` | If `summary` or `reasoningContent` non-empty, emit `TextDelta isFinalResponse:false` as delta vs accumulator | summary was empty on A:11; mapper's diff-vs-accumulator stays correct |
| `item/completed` type `agentMessage` | holds the assistant boundary for one-event lookahead | A:14, B:32 confirm final text was complete by the time completed fired |

The current mapper implements these routes. The traces give no contradiction; they just do not exercise the reasoning and plan paths under default settings.

## Sub-agent nesting (collabAgentToolCall)

**Verified in golden fixture** (`packages/providers/src/__tests__/codex/fixtures/codex-protocol-golden.ndjson`, scenario `D_subagents`, codex-cli 0.130.0, capture via `scripts/codex-protocol-capture.mjs`):

- Many `item/started` / `item/completed` rows with `type: "collabAgentToolCall"` (`spawnAgent`, `wait`).
- `item/started` can be provisional: rejected or superseded spawn attempts may carry empty `receiverThreadIds` and empty `agentsStates`.
- Parent-thread `commandExecution` rows often appear **without** `parentToolCallId` because **multiple collabs are open at once**; `nestingParentToolCallId()` returns `undefined` when `collabScopeStack.length > 1` (same rule as Claude parallel sub-agents).
- Some `commandExecution` / `outputDelta` notifications use **child thread IDs** (different `threadId` in params). Those are not replayed into the parent mapper today; nested shell output on the parent timeline may be incomplete until we subscribe or forward child-thread events.
- `spawnAgent` `item/completed` means child creation completed. The Agent row should finish from child `turn/completed` or a `wait` `agentsStates` result, not from the spawn item itself.
- No `item/reasoning/*` or `item/plan/delta` in this capture (low/default effort).
- `configWarning` appeared once; listed in `KNOWN_METHODS` / silenced set in protocol coverage test.

Replay: `bun run --cwd packages/providers test -- src/__tests__/codex/codex-protocol-coverage.test.ts`.

## Gaps (union methods never observed)

Schema-declared notifications that did not fire in either initial trace scenario and remain unverified outside the golden fixture:

- `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`
- `item/plan/delta`, `turn/plan/updated`
- `item/started` and `item/completed` for: `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `plan`, `imageView`, `imageGeneration`, `contextCompaction`, `enteredReviewMode`, `exitedReviewMode`
- `error`, `model/rerouted`, `deprecationNotice`, `skills/changed`, `turn/diff/updated`, `item/fileChange/outputDelta`, `item/autoApprovalReview/started|completed`, `item/mcpToolCall/progress`

## Methods Mcode currently treats as "unrecognized" (warn-level log noise)

Observed in both traces but not in `CodexNotification` union or `SILENCED_METHODS`:

- `thread/started`
- `thread/status/changed`
- `mcpServer/startupStatus/updated`
- `account/rateLimits/updated`
- `thread/tokenUsage/updated`

These should be added to `SILENCED_METHODS` (see follow-up patch).

## Raw appendix — method-only chronological order

**Scenario A** (text-only prompt): `remoteControl/status/changed`, `thread/started`, `mcpServer/startupStatus/updated`, `mcpServer/startupStatus/updated`, `thread/status/changed`, `turn/started`, `item/started(userMessage)`, `item/completed(userMessage)`, `account/rateLimits/updated`, `item/started(reasoning)`, `item/completed(reasoning)`, `item/started(agentMessage)`, `item/agentMessage/delta`, `item/completed(agentMessage)`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `thread/status/changed`, `turn/completed`.

**Scenario B** (shell tool prompt): `remoteControl/status/changed`, `thread/started`, `mcpServer/startupStatus/updated`, `mcpServer/startupStatus/updated`, `thread/status/changed`, `turn/started`, `item/started(userMessage)`, `item/completed(userMessage)`, `account/rateLimits/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `item/started(commandExecution)`, `item/commandExecution/outputDelta` ×2, `item/completed(commandExecution)`, `item/started(agentMessage)`, `item/agentMessage/delta` ×16, `item/completed(agentMessage)`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `thread/status/changed`, `turn/completed`.

Note: on Scenario B the `reasoning` item did not appear at all — for a tool-using turn at low reasoning effort, Codex skipped the reasoning item entirely and went straight to `commandExecution`. This is a useful invariant: do not assume a `reasoning` item always precedes tools.
