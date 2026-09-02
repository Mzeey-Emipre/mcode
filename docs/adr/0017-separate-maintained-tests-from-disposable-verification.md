---
status: accepted
---

# Separate maintained tests from disposable verification

Mcode keeps automated regression coverage in focused Vitest and Testing Library tests close to the behavior they protect. Live verification uses browser use, computer use, or another suitable external tool against the isolated worktree runtime; task-specific scripts, fixtures, logs, screenshots, annotations, and probes belong under the ignored `.dev/verification/` directory and may be deleted after the task.

The tracked web and desktop Playwright E2E suites, demo harnesses, specialized demo and E2E commands, repository Playwright dependency, and required E2E CI jobs are retired. Existing E2E assertions are reviewed before removal: uncovered product behavior moves into a regular test, while screenshot flows, duplicate checks, and task-specific probes are deleted.

## Consequences

- Hosted CI runs the maintained automated regression gate after the retired E2E suite is removed.
- UI and runtime behavior still require fresh live evidence before completion.
- Browser use and computer use are preferred for live verification when available.
- Playwright remains an optional external verification tool, not a repository default.
