# Mcode feature index

## Shared prerequisites

1. Run `bun run --shell system agent:up` in this worktree when an area health command reports that the runtime is missing or stale.
2. Use the worktree that matches `.dev/ports.json`. Do not print its credentials.
3. Register this repository as an Mcode Workspace before a runtime live proof.
4. Log in to each provider CLI before its live proof.
5. Pass a real provider, model, and `--confirm-provider-call` to each runtime live proof.
6. Run the health command named by the affected feature file before proof collection.
7. Use each area cleanup command after you inspect its evidence.

## Proof and skip rules

- Drive a production UI, API, or CLI path. Do not treat a launch screen as proof.
- Capture the visual and non-visual evidence specified by the feature file.
- Record unavailable provider accounts, models, desktop controls, or cleanup failures as coverage gaps.
- Update this index and the affected feature file when observed behavior differs from this system. Run the affected proof again.

## Feature index

| User-visible area | Feature file | Primary proof |
| --- | --- | --- |
| A thread starts, runs, stops, clears active state, and retains a cancelled reconnect snapshot | [Thread lifecycle](thread-lifecycle.md) | `runtime live --scenario stop` |
| Provider events become durable assistant conversation data | [Provider events and durability](provider-events-and-durability.md) | `runtime live --scenario completion` |
| Thread deletion and provider-session cleanup retain runtime ownership | [Resource lifecycle](resource-lifecycle.md) | `runtime check` and controlled thread cleanup |
| Pointer-selected assistant text opens a compact comment editor and retains native copy actions | [Selected text comments](selected-text-comments.md) | Electron public UI proof |
| A New worktree completes checkout before automatic Setup starts and can cancel a held Setup safely | [Managed-worktree Setup readiness](managed-worktree-setup.md) | `runtime worktree-setup --confirm-cleanup` and `runtime check` |
| Local, managed-worktree, and PR-created threads show truthful startup progress and remove it after success | [Thread startup progress](thread-startup-progress.md) | Electron public UI proof and focused startup tests |
| A user completes a worktree thread and the app schedules its cleanup | [Completed-thread cleanup](completed-thread-cleanup.md) | `thread-lifecycle proof --confirm-cleanup` and `thread-lifecycle check` |

Read [Multi-surface journeys](multi-surface-journeys.md) for a workflow that crosses the server, web or Electron UI, provider adapters, persistence, or managed worktrees.

## Broad regression order

1. Run `runtime health`, then `runtime inspect`.
2. Run `runtime check`, then the affected completion or stop provider proofs.
3. Run the selected-text-comments workflow when its desktop surface changed.
4. Run `runtime worktree-setup --confirm-cleanup` when managed-worktree checkout, automatic Setup, or Setup cancellation changed.
5. Run the thread startup progress journey when thread creation, checkout, Setup, or PR fork UI changed.
6. Run `thread-lifecycle health`, `thread-lifecycle check`, and the completed-thread proof when thread completion or worktree cleanup changed.
7. Run the applicable multi-surface journey last, inspect receipts, then run cleanup.

## Coverage gaps

- The live completion and stop matrix remains incomplete for Codex, Claude, and Cursor.
- Provider discovery does not prove provider account login.
- The public subscription RPC cannot prove a pre-create subscription without a caller-supplied thread ID or workspace subscription.
- The selected-text-comments proof cannot show native operating-system menu rendering.
- Saved-comment edit, delete, and focus return need the card and marker entry points planned for #1557 and #1558.
- Thread retention has a minimum of one day. The live proof shows the scheduled deletion, while focused integration checks show later worktree cleanup.
- If `agent.createAndSend` creates a thread but its response is lost before the ID arrives, the public RPC has no safe cleanup identifier. Record this as a coverage gap. Do not delete threads by heuristic.
- If `thread.create` creates a managed-worktree thread but its response is lost before the ID arrives, the lifecycle verifier has no safe cleanup identifier. Record this as a coverage gap. Do not delete threads by heuristic.
