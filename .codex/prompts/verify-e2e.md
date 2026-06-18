---
description: Run Playwright E2E tests and report results
---

Run `bun run verify:e2e` and show the output.

Requires the dev server (`bun run dev:web`) to be running, or the script will auto-start it.

Use after UI changes that touch: interactive components, keyboard navigation, focus trapping, responsive layout, accessibility semantics, floating overlays, or persisted state. See `docs/guides/agent-workflow.md` for the full trigger list.
