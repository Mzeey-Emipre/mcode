---
name: agent-workflow
description: Use for implementation, dependency setup, focused checks, verification receipts, and pull request delivery.
---

# Agent Workflow

Use focused checks locally. Hosted CI owns the full repository gate.

## Bootstrap

Before the first development or verification command, check the root
`node_modules` directory. If it is absent, run `bun install --frozen-lockfile`
once. The install runs the repository postinstall script.

`agent:up`, `agent:reset`, and direct verification commands do this check. Treat
an install error as a setup error, not a product failure.

## Implement

1. Read the complete linked context in
   [Implementation context](../agents/issue-tracker.md#implementation-context).
2. Implement one atomic change.
3. Add or update the nearest focused regression test.
4. Run `bun run verify:changed`.
5. Review and commit the complete diff.

Use `$electorn-live-testing` only when the user requests live proof or the
change crosses an Electron-only boundary. Follow
[Testing UI Changes](ui-components.md#testing-ui-changes) for UI work.

## Verification receipts

`bun run verify:changed` selects the affected typecheck, lint, and maintained
test scope. Documentation-only changes skip the gate.

Stop hooks inspect the current receipt. They do not run tests or start the app.
A missing, stale, or failed receipt blocks completion and names
`bun run verify:changed` as the next command.

## Full gate

Run `bun run verify` locally only when the user requests it. If it cannot finish,
record the result and stop local full-gate work. Use focused evidence to create
the pull request. Let hosted CI run the full gate.

Do not retry a timed-out full gate. Do not repair the environment or start a
background workaround only for that gate.

## Failed focused check

Reproduce the smallest failed phase. Fix the root cause, then rerun that phase
and `bun run verify:changed`. Keep the test strict.

## Deliver

Create the pull request after focused checks pass. Report focused evidence and
hosted CI as separate results.

## Enforcement

| Agent | Config | Receipt check |
|-------|--------|-----------------|
| Claude Code | `.claude/settings.json` | exit code 2 |
| Cursor | `.cursor/hooks.json` | exit code 2 via `scripts/agent/hooks/cursor-stop.mjs` |
| Codex | `.codex/hooks.json` | JSON `{"decision":"block"}` via `scripts/agent/hooks/codex-stop.mjs` |

PreToolUse hooks also block direct `.env` file edits across all agents.
