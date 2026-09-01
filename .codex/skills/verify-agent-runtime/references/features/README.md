# Agent runtime feature index

## Prerequisites

1. Run `bun run --shell system agent:down`, then `bun run --shell system agent:up` in this worktree when `health` reports a missing or stale server bundle or runtime contract.
2. Use the worktree that matches `.dev/ports.json`. Do not copy its credentials into a terminal or receipt.
3. Register the current repository as a Workspace before you run `live`.
4. Log in to each provider CLI before its live runs. Provider discovery checks installation and configuration only.
5. Use `--confirm-provider-call` and a real provider model ID for every live run.
6. Run `cleanup` after you finish with harness artifacts. The harness never starts or stops a runtime.

## Proof rules

- Run `health` before every live proof.
- Use `check` for the focused automated gate before a provider call.
- Prove completion with a terminal AgentEvent and durable assistant data from both `conversation.page` and `message.list`.
- Prove stop with `turnStarted`, two concurrent `agent.stop` calls, and one stopped outcome. The two stop results must match and be cancelled.
- Require `agent.activeCount` to reach zero. Require `agent.listRunning` to retain the matching cancelled snapshot for reconnect hydration.
- Read the redacted JSON receipt and HTML timeline. Use `$electorn-live-testing` for desktop evidence.
- Treat a skipped provider, provider login failure, unavailable model, failed cleanup, or required hydration as a gap. Do not call it full provider-neutral proof.

The harness uses a 15-second health limit from `scripts/dev-web.mjs` and one shared 120-second live-proof deadline from `scripts/providers/codex/codex-live-verify.mjs`. The live deadline begins before `agent.createAndSend`; all completion and stop proof waits use its remaining time.

## Feature index

| User-visible area | Feature file | Primary proof |
| --- | --- | --- |
| A thread starts, runs, stops, clears active state, and retains a cancelled reconnect snapshot | [Thread lifecycle](thread-lifecycle.md) | `live --scenario stop` |
| Provider events become durable assistant conversation data | [Provider events and durability](provider-events-and-durability.md) | `live --scenario completion` |
| Thread deletion and provider-session cleanup retain runtime ownership | [Resource lifecycle](resource-lifecycle.md) | focused checks and controlled thread cleanup |
| Selected assistant text exposes comment and native copy actions separately | [Selected text comments](selected-text-comments.md) | Electron live verification |

## Regression order

1. Run `health`, then `inspect`.
2. Run `check`.
3. Run completion for each available Codex, Claude, and Cursor model.
4. Run stop for each available Codex, Claude, and Cursor model.
5. Run `inspect`, examine receipts, then run `cleanup`.

The matrix intentionally covers Codex, Claude, and Cursor, the provider adapter set declared by this harness, to exercise the provider-neutral orchestration required by `docs/specs/2026-08-31-agent-service-facade-refactor.md`.

## Coverage gaps

- 32-argument fixture instead of owner fixture
- no teardown path coverage
- no memory-pressure integration coverage
- ingress Error normalization gaps
- diagnostic dedup/checkpoint failure gaps
- deletion of an errored provider thread can race late canonical event delivery and cause a foreign-key failure
- incomplete Codex/Claude/Cursor live completion+stop matrix

## Contract limitation

The public push subscription requires a thread ID. `agent.createAndSend` creates that ID, so the harness requests retained event-journal replay with cursor 0 after creation. It cannot prove lossless pre-create subscription without a public caller-supplied thread ID or workspace subscription.
