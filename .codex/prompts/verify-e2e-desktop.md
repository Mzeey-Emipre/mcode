---
description: Run Electron-only Playwright E2E specs (apps/desktop/e2e/)
---

Run `cd apps/desktop && bun run e2e` and show the output.

This drives the actual Electron app via Playwright's `_electron.launch()` and is heavier than the web `/verify-e2e`. Use it when you change anything in `apps/desktop/src/main/` (native IPC, window/tray/menu, BrowserView, deep links) or anything that crosses the contextBridge.

For pure-renderer changes, `/verify-e2e` is the right tool — it covers the same React tree via Vite and is much faster.
