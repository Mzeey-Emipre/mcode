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
