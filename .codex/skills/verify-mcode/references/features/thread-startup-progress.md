# Thread startup progress

## Behavior

- Local, new-worktree, existing-worktree, and PR-created threads use the shared startup progress display.
- The visible steps follow the operations that make the selected checkout ready.
- The activity line uses the worktree icon and a continuously moving text highlight while startup runs.
- `More details` is a native collapsed disclosure. When opened, its live log receives checkout and Setup output.
- The complete startup display is removed after successful startup.
- Failed, blocked, cancelled, and interrupted startup records remain visible with their available actions.

## User journeys

1. Start a local thread. Confirm the display shows `Use project checkout` and `Start agent` while startup runs, then disappears after agent admission.
2. Configure a project Setup command that prints two distinct lines with a delay between them. Start a new-worktree thread.
3. Open `More details` while Setup runs. Confirm the first line appears before the second line and the disclosure reads `Less details`.
4. Confirm the activity text highlight moves, the icon has `data-slot="worktree-mode-icon"`, and the whole display disappears after success.
5. Open Pull requests, select a pull request, choose `Fork`, and send the prepared prompt. Confirm the resulting local or managed checkout uses the same startup display and removes it after success.

## Focused gates

Run these gates from the repository root:

```text
bun run --cwd apps/web test -- src/features/thread-startup/__tests__/StartupProgressCard.test.tsx src/features/conversation/messages/__tests__/ChatView.test.tsx
bun run --cwd apps/web typecheck
bun run lint apps/web/src/features/thread-startup/StartupProgressCard.tsx apps/web/src/features/thread-startup/__tests__/StartupProgressCard.test.tsx
bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime worktree-setup --confirm-cleanup
```

## Evidence

Store live screenshots and receipts under `.dev/verification/startup/`. Do not commit them. The running-worktree screenshot must show the activity line, running Setup step, expanded details log, and Cancel action. The completion observation must record that no `startup-progress` element remains.

## Cleanup

Stop the owned Electron session, remove only verifier-owned workspaces and worktrees, then run `bun run --shell system agent:down` when this workflow started the runtime.
