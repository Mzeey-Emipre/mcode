---
description: Boot the dev web app and drive it via Playwright MCP for a feature demo
---

Goal: demo a feature end-to-end in the running web app.

1. Run `node scripts/agent/demo.mjs`. It assumes the default port (5173) may be taken, claims the first free port, and boots an **isolated** `bun run dev:web` there — its own backend on a unique temp data dir and DB (`MCODE_DATA_DIR` + `MCODE_DB_PATH`), never your real `~/.mcode` and never the shared dev/worktree DB, so it always boots clean. It polls until ready, then prints the exact URL + a Playwright MCP entry point. Drive the URL it prints; never hardcode `localhost:5173`. (Set `MCODE_DEMO_URL` to reuse a server you already trust.)
2. Use the Playwright MCP tools (registered in `.cursor/mcp.json`) to drive the feature: navigate, snapshot, screenshot to `apps/web/e2e/screenshots/demo/`, check console messages.
3. Walk the golden path, then 1–2 edge cases.
4. Report screenshot paths.

See `docs/agents/demo.md` for the full runbook.
