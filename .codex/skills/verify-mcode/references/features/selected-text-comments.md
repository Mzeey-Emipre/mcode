# Selected text comments

## Sub-features

- Selected assistant text exposes an `Add comment` action.
- The app does not add a competing visible `Copy` button.
- The context-menu event remains available to the native operating system.
- The text selection remains after the context-menu event.

## How to get to it (user POV)

1. Open a thread with an assistant message.
2. Select text in the assistant message.
3. Select the `Add comment` action.
4. Open the native context menu for the selected text.

## Driving it with verify-mcode

The first Electron launch initializes `.dev/electron-live-testing/runtime/db/app.sqlite`. Stop Electron before fixture setup. The second launch loads the fixture rows at server startup. The fixture never touches `.dev/db/app.sqlite`.

1. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime health`.
2. Run `bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs`.
3. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
4. Stop Electron.
5. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments setup`.
6. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
7. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments proof`.
8. Stop Electron.
9. Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments cleanup`.
10. Run `bun run --shell system agent:down`.

The verifier captures `.dev/verification/selected-text-comments.png` and `.dev/verification/selected-text-comments.json`. It requires `Add comment`, no visible `Copy` button, an unprevented context-menu event, and the selected phrase.

## Gotchas

- Stop Electron before the fixture setup and cleanup commands.
- Cleanup removes its thread and message only. It does not delete the built-in `.dev/fixture-repo` workspace.
- Automated desktop coverage proves non-interception only. It cannot prove native OS menu rendering.
