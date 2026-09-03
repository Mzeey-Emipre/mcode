# Selected text comments

## Sub-features

- A pointer drag across selected assistant text exposes an `Add comment` action.
- A pointer drag across text in several assistant list items exposes the same action.
- The action and compact editor prefer an 8px gap from the last visible selected-range rect, not the pointer release point, and flip or clamp at viewport edges.
- An open editor docks 8px from the nearest transcript edge after its source scrolls out. It reconstructs the current source range and reanchors when the source returns.
- The editor remains at that source range after the browser clears native Selection.
- The app does not add a competing visible `Copy` button.
- A secondary pointer click leaves the context-menu event available to the native operating system.
- The text selection remains after the context-menu event.
- `Add comment` opens the prototype compact editor with an empty note field and close action.
- The compact editor contains the note field, an icon-only close action, and conditional save. A saved comment also has a delete action.
- The editor accepts project slash skills, workspace file mentions, line breaks, and `Ctrl+Enter` save.
- Each saved comment keeps a reconstructed source highlight and a numbered source marker. Hover or focus a marker to strengthen only its linked highlight. Marker order follows comment creation order, even when markers overlap.
- Source highlights and markers stay below the composer annotation preview when their screen areas overlap.
- The compact editor centers a single-line note or placeholder with its action buttons.
- Saved comments appear as one compact aggregate annotation pill. Hover or keyboard-focus its count to inspect each creation number, source quote, and note. A source-available item navigates to its marker without opening an editor. When multiple annotations exist, the item also has a direct delete action. An unavailable source keeps its card edit path.
- Deleting a marker editor or an annotation preview item renumbers the survivors. Removing the aggregate clears every saved annotation.
- A source marker opens the editor at the reconstructed source range. Closing an unchanged source editor returns focus to its marker. Deleting from that editor returns focus to the surviving marker. If the source is unavailable, the card remains editable and deletable.
- The active thread draft retains saved cards and an open editor, including unsaved note text, when the user changes threads.
- The close button closes immediately. Dirty editors require two outside-click or Escape attempts. Editing resets a pending discard warning.

## How to get to it (user POV)

1. Open a thread with an assistant message.
2. Drag across text in several assistant list items.
3. Release the pointer in message whitespace after the phrase, then select the `Add comment` action.
4. Add a slash skill, a file mention, and a multiline note.
5. Save the comment with `Ctrl+Enter`, then add a second annotation.
6. Hover or keyboard-focus the aggregate annotation count, then select a source-available card to navigate. Use its numbered marker to edit and delete. Delete another item from the aggregate card when multiple annotations exist.
7. Drag across the text again, then right-click it to use the native context menu.

## Driving it with verify-mcode

The first Electron launch initializes `.dev/electron-live-testing/runtime/db/app.sqlite`. Stop Electron before fixture setup. The second launch loads the fixture rows at server startup. The fixture never touches `.dev/db/app.sqlite`.

1. Run `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime health`.
2. Run `bun run --cwd apps/desktop build` when the desktop bundle is missing or older than the changed UI source.
3. Run `bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs`.
4. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
5. Stop Electron.
6. Run `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments setup`.
7. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
8. Run `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments proof`.
9. Stop Electron.
10. Run `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments cleanup`.
11. Run `bun run --shell system agent:down`.

The verifier writes `.dev/verification/selected-text-comments-action.png`, `.dev/verification/selected-text-comments-editor.png`, `.dev/verification/selected-text-comments-result.png`, and `.dev/verification/selected-text-comments.json`. The proof first selects the full list and checks that the action appears with the preferred 8px source-range gap. It then runs the editor workflow from one list item. It validates source docking and reconstructed-range reanchoring after scroll, two multiline saves, persistent highlights, numbered markers, marker keyboard editing and deletion, aggregate card navigation and deletion, aggregate removal, and dirty dismissal states. It also checks compact-editor text alignment and popup paint order over a source highlight. It covers a real secondary pointer click that the app does not prevent, editor focus and control boundaries, and typed skill and file chips.

## Gotchas

- Stop Electron before the fixture setup and cleanup commands.
- Cleanup removes its thread, message, and owned fixture skill. It does not delete the built-in `.dev/fixture-repo` workspace.
- Automated desktop coverage uses a real secondary pointer click and proves that the app does not prevent it. It cannot inspect native OS menu rendering.
- Setup creates one owned Claude fixture skill in `.dev/fixture-repo/.claude/skills/verification-comment/`. Cleanup removes it only when its path and contents still match the verifier.
- The live UI proves visible chips and the composer draft. The focused editor test proves the hidden `MessageMention[]` payload without sending a provider turn.
- The live proof exercises rendered-source markers, marker deletion with focus return, card navigation, and direct card deletion. Unavailable sources remain covered by focused UI tests.
