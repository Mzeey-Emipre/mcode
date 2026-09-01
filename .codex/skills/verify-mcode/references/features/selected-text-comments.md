# Selected text comments

## Sub-features

- A pointer drag across selected assistant text exposes an `Add comment` action.
- The action and compact editor prefer an 8px gap from the last visible selected-range rect, not the pointer release point, and flip or clamp at viewport edges.
- The editor remains at that source range after the browser clears native Selection.
- The app does not add a competing visible `Copy` button.
- A secondary pointer click leaves the context-menu event available to the native operating system.
- The text selection remains after the context-menu event.
- `Add comment` opens the prototype compact editor with an empty note field and close action.
- The compact editor contains only the note field and icon-only close and conditional save actions.
- The editor accepts project slash skills, workspace file mentions, line breaks, and `Ctrl+Enter` save.
- Saved comments appear as one compact composer attachment. Its details list each note, and its remove action clears the active draft's comments.
- Clean editors close once. Dirty editors require two close, outside-click, or Escape attempts. Editing resets a pending discard warning.

## How to get to it (user POV)

1. Open a thread with an assistant message.
2. Drag across text in the assistant message.
3. Release the pointer in message whitespace after the phrase, then select the `Add comment` action.
4. Add a slash skill, a file mention, and a multiline note.
5. Save the comment with `Ctrl+Enter`.
6. Drag across the text again, then right-click it to use the native context menu.

## Driving it with verify-mcode

The first Electron launch initializes `.dev/electron-live-testing/runtime/db/app.sqlite`. Stop Electron before fixture setup. The second launch loads the fixture rows at server startup. The fixture never touches `.dev/db/app.sqlite`.

1. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health`.
2. Run `bun run --cwd apps/desktop build` when the desktop bundle is missing or older than the changed UI source.
3. Run `bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs`.
4. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
5. Stop Electron.
6. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments setup`.
7. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
8. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments proof`.
9. Stop Electron.
10. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments cleanup`.
11. Run `bun run --shell system agent:down`.

The verifier writes `.dev/verification/selected-text-comments-action.png`, `.dev/verification/selected-text-comments-editor.png`, `.dev/verification/selected-text-comments-result.png`, and `.dev/verification/selected-text-comments.json`. The JSON receipt records source, action, and editor geometry with their measured range gaps. The proof releases a pointer drag in message whitespace while the exact phrase stays selected, then requires the action and editor to remain within a small tolerance of the preferred 8px source-range gap when it fits. Popovers flip or clamp at viewport edges. It also covers a real secondary pointer click that the app does not prevent, editor focus and control boundaries, typed skill and file chips, multiline save, a visible composer-draft result, and clean and dirty dismissal states.

## Gotchas

- Stop Electron before the fixture setup and cleanup commands.
- Cleanup removes its thread, message, and owned fixture skill. It does not delete the built-in `.dev/fixture-repo` workspace.
- Automated desktop coverage uses a real secondary pointer click and proves that the app does not prevent it. It cannot inspect native OS menu rendering.
- Setup creates one owned Claude fixture skill in `.dev/fixture-repo/.claude/skills/verification-comment/`. Cleanup removes it only when its path and contents still match the verifier.
- The live UI proves visible chips and the composer draft. The focused editor test proves the hidden `MessageMention[]` payload without sending a provider turn.
- Do not add edit, delete, or marker-focus proof until #1557 and #1558 provide production entry points.
