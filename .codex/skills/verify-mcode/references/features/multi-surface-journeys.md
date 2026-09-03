# Multi-surface journeys

Read this file when a change crosses product surfaces. Use the linked feature files for selectors and surface-specific proof.

## Provider completion and durable conversation

1. Start a thread from the Mcode composer with a selected provider and model.
2. Let the provider adapter send canonical events to the server runtime.
3. Wait for the terminal event and the durable assistant data through the public conversation APIs.
4. Reload or reopen the conversation in web or Electron and confirm that the reply remains.

Use `runtime live --scenario completion --confirm-provider-call` for server and persistence evidence. Use the desktop testing skill for UI reload evidence.

## Stop and reconnect hydration

1. Start a provider-backed thread from the Mcode composer.
2. Stop the running turn from the chat controls.
3. Wait for the running indicator to clear.
4. Reconnect the client and confirm that the cancelled runtime snapshot remains available for hydration.

Use `runtime live --scenario stop --confirm-provider-call` for the public server proof. The harness requests retained event replay after it creates the thread.

## Composer queue matrix

1. Start a direct Electron thread with the selected Codex or Cursor model.
2. While the root turn runs, queue A and B and verify their visible FIFO rows.
3. Wait for one completed root terminal, then verify that A starts once while B remains queued.
4. Queue C while A runs, Stop, and verify that B and C remain queued through a bounded stable interval with Continue visible.
5. Continue, verify that B starts once while C remains queued, then stop and remove only the owned thread and Electron process.

Use `composer-queue proof --cursor-model <id> --allow-enable-cursor --confirm-provider-calls --confirm-cleanup` when Cursor starts disabled. The command uses `gpt-5.6-luna` unless `--codex-model <id>` overrides it. The flag temporarily enables Cursor through the owned Electron-local settings RPC. The verifier records its original state and Electron runtime directory before the change, then restores that Electron-local state during each terminal path. It retains recovery metadata if that restoration fails. A successful provider proof records one redacted receipt and three composer-only screenshots. A blocked provider records its receipt only. It uses one Electron-local socket for settings, UI thread RPCs, and replayed events. It uses 5-second root waits and 10-second queued waits. Both providers require exact durable prompt identities, exact queue rows, and a running composer for A and B admission. Provider events remain redacted diagnostics. Deterministic tests cover native Codex and Cursor terminal order.

## Managed-worktree Setup readiness

1. Create a New-worktree first turn through the public agent API.
2. Wait for Git to finish the checkout before the thread is returned.
3. Keep the first turn queued while automatic Setup reads every tracked fixture file and writes its proof marker.
4. Remove the generated thread, worktree, workspace, and fixture repository.

Use `runtime worktree-setup --confirm-cleanup` for the public server proof. The Setup command remains running after the marker, so the queued turn cannot call a provider.

## Completed managed-worktree thread

1. Open an idle managed-worktree thread in Electron.
2. Select its completion control from the Project tree.
3. Confirm that persistence records the completed state and deletion schedule.
4. Use controlled cleanup tests to confirm later deletion of only the managed worktree and thread data.

Use `thread-lifecycle proof --confirm-cleanup` for the desktop action and receipt. Use `thread-lifecycle check` for the retention-worker result.

## Selected-text comment draft

1. Drag across assistant text in the Electron transcript and open the compact comment editor.
2. Load the selected thread's Claude skill catalog and select the owned project skill.
3. Load workspace files and select `README.md` as a typed mention.
4. Save the multiline comment into the active composer draft.
5. Drag across the text again and right-click it.

Use the selected-text-comments Electron proof for real transcript pointer input, provider catalog, file list, and composer-draft result. The proof does not send a provider turn.

## Coverage gaps

- The provider workflows need an available model and a logged-in provider CLI. Record missing access as a blocked provider path.
- The public subscription begins after thread creation. It cannot show lossless events before creation.
- The completed-thread proof does not wait one day. Its focused integration checks use a controlled clock for the retention path.
- The selected-text comment proof cannot inspect the hidden `MessageMention[]` payload without sending a provider turn. The focused editor test covers that payload.
- The Composer queue matrix needs exact listed models and logged-in provider CLIs. `--allow-enable-cursor` temporarily changes only the owned Electron session's Cursor setting. In the 09:42 matrix, Codex showed root and A with B as the only queued row, while runtime logs showed root, A, and B sends in FIFO order. Its event-gated receipt was inconclusive. Cursor enabled and restored successfully, but its root did not complete in 120 seconds while A and B remained queued. Cursor is a live application or provider failure, not a disabled-provider blocker. Retain this gap until Codex passes with the visible admission oracle and Cursor completes its root turn.
