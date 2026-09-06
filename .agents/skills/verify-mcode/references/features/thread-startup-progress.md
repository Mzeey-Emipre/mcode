# Thread startup progress

## Behavior

- Local, new-worktree, existing-worktree, and PR-created threads use the shared startup progress display. Selecting a PR only records its branch and PR number; the PR ref is fetched when startup begins, before its checkout is created.
- The visible steps follow the operations that make the selected checkout ready.
- The activity line uses chat-body type, a shared directional shimmer for its worktree icon and text while startup runs, and a static readable label when reduced motion is requested.
- `More details` is a native collapsed disclosure. When opened, its live log receives checkout and Setup output.
- Details use the full card width. Cancellation and available recovery actions appear in a stable footer below the disclosure.
- During a cancellation request for a running managed Setup, only the web activity line animates `Cancelling setup`.
- The preparing shell stays spatially stable from optimistic thread creation through persisted startup. After startup completes, it remains until the conversation is paintable, then switches directly to normal chat without `conversation-transition-shell` or moving the startup card into the timeline first.
- Failed, blocked, cancelled, and interrupted startup records remain visible with their available actions.

## User journeys

1. Start a local thread. Confirm the display shows `Use project checkout` and `Start agent` while startup runs, stays spatially stable through persisted startup, then switches directly to normal chat when the conversation is paintable.
2. Configure a project Setup command that prints two distinct lines with a delay between them. Start a new-worktree thread.
3. Open `More details` while Setup runs. Confirm the first line appears before the second line and the disclosure reads `Less details`.
4. Select Cancel while Setup runs. Confirm that only the activity line animates `Cancelling setup` while the request waits. Confirm that the cancelled startup record remains visible after the request completes.
5. Open Pull requests, select a pull request, choose `Fork`, and send the prepared prompt. Confirm the resulting local or managed checkout uses the same startup display and removes it after success.

## Focused gates

Run these gates from the repository root:

```text
bun run --cwd apps/web test -- src/features/thread-startup/__tests__/StartupProgressCard.test.tsx src/features/conversation/messages/__tests__/ChatView.test.tsx
bun run --cwd apps/web typecheck
bun run lint apps/web/src/features/thread-startup/StartupProgressCard.tsx apps/web/src/features/thread-startup/__tests__/StartupProgressCard.test.tsx
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime worktree-setup --confirm-cleanup
```

## Evidence

Store live screenshots and receipts under `.dev/verification/startup/`. Do not commit them. The running-worktree screenshot must show the activity line, running Setup step, expanded details log, and Cancel action. The completion observation must record that no `startup-progress` element remains, that the preparing shell stayed stable until the conversation was paintable, and that no `conversation-transition-shell` appeared or moved the startup card into the timeline first.

## Cleanup

Stop the owned Electron session, remove only verifier-owned workspaces and worktrees, then run `bun run --shell system agent:down` when this workflow started the runtime.
