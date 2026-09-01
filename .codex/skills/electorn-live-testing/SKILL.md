---
name: electorn-live-testing
description: Keep one Mcode Electron application open and control it across many Playwright commands through the persistent Node REPL. Use when inspecting, debugging, benchmarking, or verifying desktop-only behavior, including existing Browser tabs, background tabs, tab switching, popups, provider selection, reloads, and restart boundaries.
---

# Electron Live Testing

Use one persistent Playwright connection to an agent-owned Electron process. Launch once, keep the browser and page handles in the Node REPL, and issue small commands against those handles until verification is complete.

## Start the session

1. Read `docs/agents/runtime.md` and start the worktree runtime with `bun run --shell system agent:up` if it is not healthy.
2. Read `.dev/ports.json`. Never print its token or seeded credentials.
3. Make Playwright importable by the Node REPL. Prefer an existing external installation. Otherwise use the helper to create an isolated private package under `.dev/playwright-scratch`. Never add Playwright to the repository package manifest:

   ```powershell
   bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs
   ```

4. Start or reuse the owned Electron process. The launcher selects a dynamic CDP port and records only its own PID:

   ```powershell
   bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs
   ```

5. Add the absolute `.dev/playwright-scratch/node_modules` directory with `mcp__node_repl__js_add_node_module_dir`.
6. Import Playwright and the session helper in `mcp__node_repl__js`. Use top-level `var` names because the kernel preserves bindings:

   ```js
   var electronPlaywright = await import("playwright");
   var electronSessionHelper = await import(
     "./.codex/skills/electorn-live-testing/scripts/electron-session.mjs"
   );
   var electronSession = await electronSessionHelper.connectElectronSession({
     playwright: electronPlaywright,
     repoRoot: nodeRepl.cwd,
   });
   var electronPage = electronSession.page;
   nodeRepl.write({ pid: electronSession.pid, url: electronPage.url() });
   ```

Do not reset the Node REPL while the application is open. Do not launch a second session to perform the next action.

## Operate directly

Run each observation or action as a new `mcp__node_repl__js` call against `electronPage`, `electronSession.context`, or `electronSession.browser`.

Prefer accessible Playwright locators and explicit postconditions. Re-inspect after navigation or any action that changes the page structure. Keep console errors and failed requests in persistent arrays when they matter to the test.

Use Playwright for deterministic DOM, keyboard, focus, popup, multi-tab, and timing checks. Use computer use only when visual inspection or native-window behavior cannot be established through Playwright. Computer use supplements the Playwright evidence; it does not replace assertions.

For Browser lifecycle changes, cover the states that can regress:

- An agent starts while a Browser tab already exists.
- Two or more tabs retain independent URL and page state.
- Switching away and back preserves the live hidden tab.
- Background creation does not steal focus unless the product contract requires it.
- Popup behavior preserves the expected automation target.
- A clean Electron restart restores or reloads only the states promised by the issue.

Select any requested provider or model inside Mcode before starting the test turn. The provider selected in the app is independent from the model running this testing workflow.

## Measure and capture evidence

Warm each path before timing it. Record multiple samples with `performance.now()` around the exact user-visible transition, then report the sample count, median, minimum, and maximum. Do not claim a performance change from a single run.

Store screenshots, logs, and measurements under `.dev/verification/`. Keep exploratory specifications under `.dev/playwright-scratch/`; do not commit them.

Main-process and preload changes require a rebuild and clean Electron relaunch. Renderer-only edits can use hot reload for iteration, but final lifecycle evidence requires a clean relaunch so stale guest or generation state cannot mask a failure.

## Close the owned session

Disconnect Playwright, then stop the exact process tree owned by the launcher:

```js
await electronSessionHelper.disconnectElectronSession(electronSession);
electronSession = undefined;
electronPage = undefined;
nodeRepl.write("Playwright disconnected");
```

```powershell
bun .codex/skills/electorn-live-testing/scripts/stop-electron.mjs
```

Then run `bun run --shell system agent:down` only when this workflow started the runtime. The stop helper verifies the recorded executable and dynamic CDP port before stopping the PID tree. If verification fails, inspect `.dev/electron-live-testing.json` and the live command before cleanup. Never kill Electron processes by name.

Report desktop evidence separately from focused automated tests and `bun run verify`.

Use this command order for selected-text comments:

```powershell
bun run --shell system agent:up
bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs
bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs
bun .codex/skills/electorn-live-testing/scripts/stop-electron.mjs
bun .codex/skills/electorn-live-testing/scripts/selected-text-comments-fixture.mjs setup
bun .codex/skills/electorn-live-testing/scripts/start-electron.mjs
bun .codex/skills/electorn-live-testing/scripts/verify-selected-text-comments.mjs
bun .codex/skills/electorn-live-testing/scripts/stop-electron.mjs
bun .codex/skills/electorn-live-testing/scripts/selected-text-comments-fixture.mjs cleanup
bun run --shell system agent:down
```

The first Electron launch initializes `.dev/electron-live-testing/runtime/db/app.sqlite`. Stop Electron before fixture setup. The second launch loads the fixture rows at server startup. The fixture never touches `.dev/db/app.sqlite` or deletes the built-in `.dev/fixture-repo` workspace.

The verifier writes `.dev/verification/selected-text-comments.png` and `.json` evidence. Playwright proves that the app does not intercept `contextmenu`, but it cannot inspect the native OS menu.
