# Selected text comments

## Sub-features

- A pointer drag across selected assistant text exposes an `Add comment` action.
- The action and compact editor prefer an 8px gap from the last visible selected-range rect, not the pointer release point, and flip or clamp at viewport edges.
- An open editor docks 8px from the nearest transcript edge after its source scrolls out. It reconstructs the current source range and reanchors when the source returns.
- The editor remains at that source range after the browser clears native Selection.
- The app does not add a competing visible `Copy` button.
- A secondary pointer click leaves the context-menu event available to the native operating system.
- The text selection remains after the context-menu event.
- `Add comment` opens the prototype compact editor with an empty note field and close action.
- The compact editor contains only the note field and icon-only close and conditional save actions.
- The editor accepts project slash skills, workspace file mentions, line breaks, and `Ctrl+Enter` save.
- Saved comments appear as one compact aggregate annotation pill. Hover or keyboard-focus its count to inspect each creation number, source quote, and note. Hover or keyboard-focus a preview item to reveal its edit action and, when multiple annotations exist, its delete action. Each item also has a direct source action.
- Deleting an annotation preview item renumbers the survivors. Removing the aggregate clears every saved annotation.
- Source reconstruction opens the editor at the source range. If the source is unavailable, the card remains editable and deletable.
- The active thread draft retains saved cards and an open editor, including unsaved note text, when the user changes threads.
- Clean editors close once. Dirty editors require two close, outside-click, or Escape attempts. Editing resets a pending discard warning.

## How to get to it (user POV)

1. Open a thread with an assistant message.
2. Drag across text in the assistant message.
3. Release the pointer in message whitespace after the phrase, then select the `Add comment` action.
4. Add a slash skill, a file mention, and a multiline note.
5. Save the comment with `Ctrl+Enter`, then add a second annotation.
6. Hover or keyboard-focus the aggregate annotation count, then use the preview's source, edit, and multi-item delete actions.
7. Drag across the text again, then right-click it to use the native context menu.

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

The verifier writes `.dev/verification/selected-text-comments-action.png`, `.dev/verification/selected-text-comments-editor.png`, `.dev/verification/selected-text-comments-result.png`, and `.dev/verification/selected-text-comments.json`. The JSON receipt records source, action, and editor geometry with their measured range gaps. The proof keeps the exact phrase selected during its pointer drag and checks the preferred 8px source-range gap where it fits. It validates source docking and reconstructed-range reanchoring after scroll, two multiline saves, the aggregate annotation pill and preview, source and edit actions, multi-item deletion, aggregate removal, and clean and dirty dismissal states. It also covers a real secondary pointer click that the app does not prevent, editor focus and control boundaries, and typed skill and file chips.

## Gotchas

- Stop Electron before the fixture setup and cleanup commands.
- Cleanup removes its thread, message, and owned fixture skill. It does not delete the built-in `.dev/fixture-repo` workspace.
- Automated desktop coverage uses a real secondary pointer click and proves that the app does not prevent it. It cannot inspect native OS menu rendering.
- Setup creates one owned Claude fixture skill in `.dev/fixture-repo/.claude/skills/verification-comment/`. Cleanup removes it only when its path and contents still match the verifier.
- The live UI proves visible chips and the composer draft. The focused editor test proves the hidden `MessageMention[]` payload without sending a provider turn.
- The live proof exercises source, edit, and multi-item deletion for a rendered source. Focus return and unavailable sources remain covered by focused UI tests.
