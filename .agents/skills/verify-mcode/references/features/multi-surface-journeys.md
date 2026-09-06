# Multi-surface journeys

Read this file when a change crosses product surfaces. Use the linked feature files for selectors and surface-specific proof.

## Provider completion and durable conversation

1. Start a thread from the Mcode composer with a selected provider and model.
2. Let the provider adapter send canonical events to the server runtime.
3. Wait for the terminal event and the durable assistant data through the public conversation APIs.
4. Reload or reopen the conversation in web or Electron and confirm that the reply remains.

Use `runtime live --scenario completion --confirm-provider-call` for server and persistence evidence. Use the desktop testing skill for UI reload evidence.

## Codex protocol notices and reconnect

1. Start an owned Codex thread from the Electron Composer with the [desktop live-testing skill](../../../electorn-live-testing/SKILL.md).
2. Trigger each available reroute, warning, configuration, deprecation, workspace-security, or authentication-recovery notice.
3. Confirm the current warning above Composer before any history scroll. Expand its details, hide it, then reopen it with Review notices. Inspect the public conversation state without provider payloads.
4. Type `/` and `@` in the real Composer. Each picker takes precedence. Escape restores the notice and preserves the draft. Reload the Electron conversation and check the warning before any history scroll. Confirm that no duplicate toast or diagnostics entry appears.
5. Capture the trigger and stable state, then remove only verifier-owned thread state.

Run `runtime health` before this journey. Use the trigger table and proof limits
in [Provider events and durability](provider-events-and-durability.md#codex-notice-triggers-and-desktop-proof).
Capture an Electron assertion and screenshot as well as public persistence
evidence. Record unavailable Codex access or notification variants as coverage
gaps. The focused mapper, server, and web tests do not prove desktop appearance.
For the controlled five-notice fixture, run `desktop codex-protocol-notices
setup`, set its returned path only in the owned Electron runtime, and use a fresh
direct thread. One fixture process supports one turn. Restore the prior path
before fixture cleanup.

## Stop and reconnect hydration

1. Start a provider-backed thread from the Mcode composer.
2. Stop the running turn from the chat controls.
3. Wait for the running indicator to clear.
4. Reconnect the client and confirm that the cancelled runtime snapshot remains available for hydration.

Use `runtime live --scenario stop --confirm-provider-call` for the public server proof. The harness requests retained event replay after it creates the thread.

## OpenCode restart resume and deleted upstream session

1. Create an owned temporary workspace, then start two owned direct OpenCode threads with `opencode/muse-spark-1.3-contributor-free`.
2. Restart only the current worktree runtime after both turns complete.
3. Send another message to the first thread and confirm its persisted upstream session identity remains the same.
4. Delete the second thread's upstream session with `opencode session delete`.
5. Send another message to the second thread and confirm the public `sdk_session_invalidated` event, a new persisted session identity, and the first thread's unchanged identity.

Use `runtime live --provider opencode --model opencode/muse-spark-1.3-contributor-free --scenario opencode-resume --confirm-provider-call` for the public server and persistence proof. It removes only its owned threads and temporary workspace. The focused web store test proves the event text renders. The focused OpenCode HTTP-client tests prove the exact history bound, timeout, abort, 404, and malformed-response contract. This journey does not prove the notice through Electron.

## Composer queue matrix

1. Start a direct Electron thread with the selected Codex or Cursor model.
2. While the root turn runs, queue A and B and verify their visible FIFO rows.
3. Wait for one completed root terminal, then verify that A starts once while B remains queued.
4. Queue C while A runs, Stop, and verify that B and C remain queued through a bounded stable interval with Continue visible.
5. Continue, verify that B starts once while C remains queued, then stop and remove only the owned thread and Electron process.

Use `composer-queue proof --cursor-model <id> --allow-enable-cursor --confirm-provider-calls --confirm-cleanup` when Cursor starts disabled. The command uses `gpt-5.6-luna` unless `--codex-model <id>` overrides it. The flag temporarily enables Cursor through the owned Electron-local settings RPC. The verifier records its original state and Electron runtime directory before the change, then restores that Electron-local state during each terminal path. It retains recovery metadata if that restoration fails. A successful provider proof records one redacted receipt and three composer-only screenshots. A blocked provider records its receipt only. It uses one Electron-local socket for settings, UI thread RPCs, and replayed events. It uses 5-second root waits and 10-second queued waits. Both providers require exact durable prompt identities, exact queue rows, and a running composer for A and B admission. Provider events remain redacted diagnostics. Deterministic tests cover native Codex and Cursor terminal order.

## Codex subagent detail and durable transcript

1. Start a direct Codex thread with `gpt-5.6-terra` and delegate one marked task.
2. Confirm that either Codex protocol event shape maps to one canonical child.
3. Observe Active, then Completed, in the canonical roster.
4. Open the chat row and confirm that the exact child detail uses the same glyph color.
5. Confirm that the parent task and child assistant message render in the child transcript.
6. Reload and confirm the same title, state, color, and message.

Use `runtime check` for both protocol shapes. Use `runtime live --scenario subagent --provider codex --model gpt-5.6-terra --confirm-provider-call` for the live provider and persistence proof. Use the Electron steps in [Codex subagent view](codex-subagent-view.md) for click, color, and reload evidence.

## Managed-worktree Setup readiness

1. Create a New-worktree first turn through the public agent API.
2. Wait for Git to finish the checkout before the thread is returned.
3. Keep the first turn queued while automatic Setup reads every tracked fixture file, records its PID, and writes its proof marker.
4. Cancel startup through the public API. Confirm the terminal startup state, stopped Setup process, interrupted Setup attempt, queued first turn, and no agent runtime.
5. Remove the generated thread, worktree, workspace, and fixture repository.

Use `runtime worktree-setup --confirm-cleanup` for the public server proof. The command cancels the held Setup before it removes the owned fixture. The queued turn cannot call a provider.

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
4. Save two multiline comments into the active composer draft.
5. Select one source card to navigate, use its numbered marker to edit and delete, then delete another card directly.
6. Switch away from the thread and back. Confirm that saved cards and an open unsaved editor restore.
7. Drag across the text again and right-click it.

Use the selected-text-comments Electron proof for real transcript pointer input, provider catalog, file list, aggregate cards, source markers, marker deletion, and direct card actions. Use focused composer-session tests for thread-switch editor restoration. The proof does not send a provider turn. Focused server and web tests cover existing-thread text plus comments, comment-only provider input, durable user and assistant source metadata, and sent read-only chips.

## Coverage gaps

- The provider workflows need an available model and a logged-in provider CLI. Record missing access as a blocked provider path.
- The public subscription begins after thread creation. It cannot show lossless events before creation.
- The completed-thread proof does not wait one day. Its focused integration checks use a controlled clock for the retention path.
- The selected-text comment proof cannot inspect the hidden `MessageMention[]` payload, provider input, or restore an off-screen source without sending a provider turn. Focused tests cover these paths and unavailable-source card state.
