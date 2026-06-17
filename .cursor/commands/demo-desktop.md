---
description: Launch the Electron desktop app under Playwright and screenshot the first window
---

Goal: demo an Electron-specific feature in the running desktop app.

Use this **only** for features that need the actual Electron runtime — native menus, tray, BrowserView, contextBridge IPC, deep links, window chrome. For anything that renders identically in the browser, prefer `/demo` (faster, Playwright MCP can drive it interactively).

1. Build the Electron bundles: `cd apps/desktop && bun run build`.
2. Run `node scripts/agent/demo-desktop.mjs`. It launches Electron via Playwright's `_electron.launch()`, waits for the first window, screenshots to `apps/web/e2e/screenshots/demo-desktop/`, and prints renderer errors. It runs against an **isolated, empty data dir** by default (never your real `~/.mcode`), and the embedded server claims its own free port — so it never attaches to another running app. Pass `MCODE_DEMO_USE_REAL_DATA=1` only when you must demo against existing workspaces. If you write a **custom** desktop demo that seeds data over RPC, read the launched instance's `server.lock` from its `MCODE_DATA_DIR` for the port + token — never port-scan for a `/health`, or you may mutate the wrong database.
3. Pass `--tour` for extra `tour-*.png` snapshots: settled shell (`tour-02`), optional **active chat** (`tour-02b-active-chat` when a thread row exists), Changes (`mod+d`), Terminal (`mod+j`), Preview (`mod+shift+b`), and header Changes toggle (`tour-06`) when the chat header is visible.
4. Pass `--keep-open` to leave Electron running. Drive it programmatically using the `apps/desktop/e2e/electron-smoke.spec.ts` pattern (Playwright library, not the MCP — the MCP does not support Electron).
5. Promote regression-risk flows into `apps/desktop/e2e/` and run `/verify-e2e-desktop`.

See `docs/agents/demo.md` § Demoing the Desktop App for the full runbook.
