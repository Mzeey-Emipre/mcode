# Mcode feature index

## Shared prerequisites

1. Run `bun run agent:setup`, then `bun run --shell system agent:up`, in this worktree when an area health command reports that the runtime is missing or stale.
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
| Last turn shows native agent changes, settles durably, and identifies Git fallback | [Last turn native diff](turn-diff-review.md) | Codex composer and Review Electron proof, plus focused Git/RPC and migration checks |
| A thread starts, runs, stops, clears active state, and retains a cancelled reconnect snapshot | [Thread lifecycle](thread-lifecycle.md) | `runtime live --scenario stop` |
| Provider events become durable assistant conversation data | [Provider events and durability](provider-events-and-durability.md) | `runtime live --scenario completion` |
| Codex reroutes, warnings, diagnostics, and authentication recovery remain bounded, durable, and thread-scoped | [Provider events and durability](provider-events-and-durability.md) | Composer notice journey and `runtime health` |
| Codex subagents retain task, state, transcript, navigation, and identity color across both protocol shapes | [Codex subagent view](codex-subagent-view.md) | `runtime check`, Terra `runtime live --scenario subagent`, and Electron UI proof |
| Thread deletion and provider-session cleanup retain runtime ownership | [Resource lifecycle](resource-lifecycle.md) | `runtime check` and controlled thread cleanup |
| Pointer-selected assistant text opens a compact comment editor and retains native copy actions | [Selected text comments](selected-text-comments.md) | Electron public UI proof |
| A New worktree completes checkout before automatic Setup starts and can cancel a held Setup safely | [Managed-worktree Setup readiness](managed-worktree-setup.md) | `runtime worktree-setup --confirm-cleanup` and `runtime check` |
| Local, managed-worktree, and PR-created threads show truthful startup progress and remove it after success | [Thread startup progress](thread-startup-progress.md) | Electron public UI proof and focused startup tests |
| A user completes a worktree thread and the app schedules its cleanup | [Completed-thread cleanup](completed-thread-cleanup.md) | `thread-lifecycle proof --confirm-cleanup` and `thread-lifecycle check` |
| Queued composer messages continue in FIFO order after completion and stay paused after Stop | [Composer queue](composer-queue.md) | `composer-queue proof --cursor-model <id> --allow-enable-cursor --confirm-provider-calls --confirm-cleanup` |
| An OpenCode thread streams a pooled-serve turn to completion, stops to aborted, shares one server per worktree, routes supervised permission and question cards through the shared request flow, and renders canonical notices once | [OpenCode pooled serve](opencode-pooled-serve.md) | `runtime live --provider opencode --model <provider/model-id> --scenario completion` and `--scenario stop` |
| Thread Overview defaults open beside the right panel in split mode, even when the narrowed chat is below the usual threshold, and is unavailable while the panel is maximized | [Thread Overview and right panel](thread-overview-right-panel.md) | Electron public UI proof with the stable live-testing interface |
| An existing thread title is renamed or cancelled from the Project tree | [Thread-list inline rename](thread-list-inline-rename.md) | Electron public UI proof with the stable live-testing interface |

Read [Multi-surface journeys](multi-surface-journeys.md) for a workflow that crosses the server, web or Electron UI, provider adapters, persistence, or managed worktrees.

## Broad regression order

1. Run `runtime health`, then `runtime inspect`.
2. Run `runtime check`, then the affected completion or stop provider proofs.
3. Run the selected-text-comments workflow when its desktop surface changed.
4. Run the Codex subagent workflow when collaboration mapping or the Subagents UI changed.
5. Run `runtime worktree-setup --confirm-cleanup` when managed-worktree checkout, automatic Setup, or Setup cancellation changed.
6. Run the thread startup progress journey when thread creation, checkout, Setup, or PR fork UI changed.
7. Run `thread-lifecycle health`, `thread-lifecycle check`, and the completed-thread proof when thread completion or worktree cleanup changed.
8. Run the Thread Overview and right-panel workflow when shared workspace navigation or panel layout changed.
9. Run the thread-list inline rename workflow when Project-tree thread naming changed.
10. Run the applicable multi-surface journey last, inspect receipts, then run cleanup.

## Coverage gaps

- The live completion and stop matrix remains incomplete for Codex, Claude, and Cursor.
- OpenCode live completion, stop, resume, permission, and question proof is blocked for #1624 because the available OpenCode quota is exhausted. An authenticated account and quota are required before the primary public-path proof can run. Focused tests support component behavior only.
- Provider discovery does not prove provider account login.
- The public subscription RPC cannot prove a pre-create subscription without a caller-supplied thread ID or workspace subscription.
- The selected-text-comments proof cannot show native operating-system menu rendering.
- The selected-text-comments live proof covers rendered source cards. It does not load a source that is absent from the current transcript window.
- Saved-comment edit, delete, and focus return need the card and marker entry points planned for #1557 and #1558.
- Thread retention has a minimum of one day. The live proof shows the scheduled deletion, while focused integration checks show later worktree cleanup.
- If `agent.createAndSend` creates a thread but its response is lost before the ID arrives, the public RPC has no safe cleanup identifier. Record this as a coverage gap. Do not delete threads by heuristic.
- If `thread.create` creates a managed-worktree thread but its response is lost before the ID arrives, the lifecycle verifier has no safe cleanup identifier. Record this as a coverage gap. Do not delete threads by heuristic.
