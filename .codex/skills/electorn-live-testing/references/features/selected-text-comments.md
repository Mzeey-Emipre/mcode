# Selected text comments

## Preconditions

The first Electron launch initializes `.dev/electron-live-testing/runtime/db/app.sqlite`. Stop Electron before fixture setup. The second launch loads the fixture rows at server startup. The fixture never touches `.dev/db/app.sqlite`. Cleanup removes its thread and message only. It never deletes the built-in `.dev/fixture-repo` workspace.

## Workflow

1. Run `bun run --shell system agent:up`.
2. Run `bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs`.
3. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
4. Stop Electron.
5. Run `bun .codex/skills/electorn-live-testing/scripts/selected-text-comments-fixture.mjs setup`.
6. Run `bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs`.
7. Run `bun .codex/skills/electorn-live-testing/scripts/verify-selected-text-comments.mjs`.
8. Stop Electron.
9. Run `bun .codex/skills/electorn-live-testing/scripts/selected-text-comments-fixture.mjs cleanup`.
10. Run `bun run --shell system agent:down`.

## Observable action

Select `verification phrase` in the fixture assistant message, then dispatch a cancellable context-menu event on the selected content.

## Assertions

`Add comment` is visible, no visible `Copy` button exists, the context-menu event is not prevented, and the exact selection remains.

## Evidence

The verifier captures `.dev/verification/selected-text-comments.png` and `.dev/verification/selected-text-comments.json`.

## Cleanup

Stop Electron, remove the fixture data with the cleanup command, then bring the runtime down.

## Limitation

Automated desktop coverage proves non-interception only. It cannot prove native OS menu rendering.
