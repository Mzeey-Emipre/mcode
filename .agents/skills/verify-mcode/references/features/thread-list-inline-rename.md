# Thread-list inline rename

## Sub-features

- A double-click on an existing thread opens an input with the current title selected.
- Enter saves a changed, non-empty title.
- Escape and a click outside the input cancel the draft without saving it.

## How to get to it (user POV)

1. Open a project with an existing thread in the Project tree.
2. Double-click the thread row.
3. Change the title, then use Enter, Escape, or a click outside the input.

## Driving it with Electron Playwright

- Run `runtime health` before the proof. Use the healthy worktree instance.
- Expand the target project. Find the thread row by its accessible name, which starts with its provider and title.
- Double-click the row. Scope the textbox locator to that row. Assert that it contains the original title and that the title is selected.
- Enter a non-empty replacement title and press Enter. Assert that the textbox closes and the row shows the replacement.
- Repeat the double-click. Type a different draft, then press Escape. Assert that the textbox closes and the row still shows the saved title.
- Repeat the double-click. Type a different draft, then click outside the textbox. Assert that the textbox closes and the row still shows the saved title.
- Restore the original title before cleanup. Do not rename a thread that is not owned by the proof.

## Gotchas

- A second click within 250ms is the same entry path as a physical double-click.
- Do not infer success from a closed input alone. Check the visible row title after each exit path.
