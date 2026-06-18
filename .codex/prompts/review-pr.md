---
description: Run a 4-parallel-subagent code review (security, performance, quality, correctness)
argument-hint: [pr-number-or-branch]
---

Review the changes in `$ARGUMENTS` (PR number, branch name, or HEAD if empty).

Dispatch four subagents in parallel in a single message — do NOT run them sequentially:

1. **Security** — use the `security-reviewer` subagent. Focus: Electron contextBridge surface, child-process spawning, SQLite parameterization, XSS, secrets.
2. **Performance** — general-purpose subagent. Focus: bundle size, render hot paths, DB query patterns, memory targets in `AGENTS.md`.
3. **Quality** — general-purpose subagent. Focus: code style per `AGENTS.md`, JSDoc on exports, no needless abstractions, naming.
4. **Correctness** — general-purpose subagent. Focus: does the diff do what the PR/commit description claims, edge cases, error handling at boundaries.

After all four return, cross-reference findings, eliminate false positives, and present a single consolidated report grouped by severity (blocker / major / minor / nit).
