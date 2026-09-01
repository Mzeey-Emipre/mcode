# Thread lifecycle feature index

## Prerequisites

1. Run `bun run --cwd apps/desktop build`.
2. Run `bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs`.
3. Run `bun run --shell system agent:up` when `health` reports that the runtime is missing or stale.
4. Use the worktree that matches `.dev/ports.json`.
5. Run the commands from this skill only in that worktree.

## Proof rules

- Run `health` before a live proof.
- Run `check` before `proof`.
- Use `proof --confirm-cleanup` for the desktop user action. It creates a disposable thread in the fixture project and captures a screenshot plus the persisted completion fields.
- Read the receipt before `cleanup --confirm-cleanup` removes its evidence.
- Treat a failed UI control, a missing scheduled deletion date, or a retained disposable worktree as a failed proof.

## Feature index

| User-visible area | Feature file | Primary proof |
| --- | --- | --- |
| A user completes a worktree thread, sees it in Completed, and the app schedules its cleanup | [Completed-thread cleanup](completed-thread-cleanup.md) | `proof --confirm-cleanup` plus `check` |

## Regression order

1. Run `health`.
2. Run `check`.
3. Run `proof --confirm-cleanup`.
4. Run `inspect`.
5. Run `cleanup --confirm-cleanup`.

## Coverage gap

The retention setting has a minimum of one day. The live proof confirms the user action and its scheduled deletion. The controlled cleanup integration tests prove expiry and worktree removal without waiting one day.
