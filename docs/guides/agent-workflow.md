---
name: agent-workflow
description: Use for implementation, dependency setup, focused checks, and pull request delivery.
---

# Agent Workflow

Use focused checks locally. Hosted CI owns the full repository gate.

## Bootstrap

Run `bun install`, then run `bun run agent:setup` when runtime artifacts are
absent or stale. Setup snapshots the local database into the worktree, creates
or validates `.dev/fixture-repo`, and builds runtime artifacts. Product and
runtime tests select and mutate only `.dev/fixture-repo`.

`agent:up` assumes setup is complete and fails fast if it is not.

After `bun run --shell system agent:up`, run `bun run agent:ready`. It reads
`.dev/ports.json` and waits for the server, web app, and any managed desktop
surface.

## Implement

1. Read the complete linked context in
   [Implementation context](../agents/issue-tracker.md#implementation-context).
2. Implement one atomic change.
3. Add or update the nearest focused regression test.
4. Run the focused checks for the changed behavior.
5. Review and commit the complete diff.

Use `$electorn-live-testing` only when the user requests live proof or the
change crosses an Electron-only boundary. Follow
[Testing UI Changes](ui-components.md#testing-ui-changes) for UI work.

## Focused checks

Run the narrowest test that exercises the changed behavior. Run typecheck or
lint when the change affects those boundaries. Hosted CI owns the full
repository gate.

Build a fresh related-test candidate from package dependencies and TypeScript
aliases after the edit. Then inspect direct callers and manually include
transport, event, dependency-injection, and contract consumers that the graph
cannot resolve. A broad store may justify several focused tests. Establish a
focused baseline on the unchanged revision before calling an unexpected result
a regression.

Use the workspace's installed Vitest to list a candidate before selecting its
tests. For an explicit candidate, run
`bunx --no-install vitest list <test-file> --filesOnly`. To discover changed
tests from a workspace, run `bunx --no-install vitest list --changed --filesOnly`.
Add a base reference to compare against it, such as `--changed origin/main`.
From `apps/server`, keep
the Electron runner with
`bun ../../scripts/run-electron-node.mjs --workspace-cli vitest vitest.mjs list --changed --filesOnly`.
Review the result with the manual boundary checks above before running the
selected tests.

For changes under `scripts/agent`, run the named maintained test with
`bun run test:scripts -- scripts/agent/__tests__/<file>.test.mjs`. Supplying no
file runs the maintained script-test collection.

## Failed focused check

Reproduce the smallest failed phase. Fix the root cause, then rerun it. Keep
the test strict.

## Deliver

Create the pull request after focused checks pass. Report focused evidence and
hosted CI as separate results.
