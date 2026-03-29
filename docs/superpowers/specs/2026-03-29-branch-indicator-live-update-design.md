# Branch Indicator Live Update — Design Spec

**Issue:** #108
**Date:** 2026-03-29
**Branch:** `fix/108-branc-indicator`

## Problem

The branch indicator in the Composer status bar shows stale branch info after the user switches branches outside Mcode (e.g., `git checkout main` in the integrated terminal or an external terminal). Branches are loaded once and cached; there is no mechanism to detect or react to external git state changes.

### Root Cause

- `workspaceStore.loadBranches()` is called only when `branches.length === 0` (Composer.tsx guard), so it never re-fetches after initial load.
- The server has no file watcher on `.git/HEAD` and no polling mechanism.
- No `branch.changed` push channel exists in the WebSocket protocol.

## Solution: File Watcher + Server Push

Use Node's built-in `fs.watch` on the workspace's HEAD file. When the HEAD changes, the server broadcasts a `branch.changed` push event. The client listens, refreshes the branch list, and updates the UI.

## Architecture

```
┌─ Server ─────────────────────────────────┐
│ GitWatcherService (new singleton)         │
│  ├─ watchWorkspace(id, path)              │
│  │   └─ fs.watch(<HEAD file>, debounced) │
│  ├─ unwatchWorkspace(id)                  │
│  └─ on change → broadcast branch.changed │
└──────────────────────────────────────────┘
               ↓ WebSocket push
┌─ Client ──────────────────────────────────┐
│ ws-events.ts: branch.changed handler      │
│  └─ workspaceStore.loadBranches(id)       │
│  └─ update newThreadBranch if unmodified  │
│                                           │
│ Composer.tsx                              │
│  └─ remove branches.length === 0 guard   │
└───────────────────────────────────────────┘
```

## Component Design

### 1. Contracts — `packages/contracts/src/ws/channels.ts`

Add to `WS_CHANNELS`:

```ts
"branch.changed": z.object({ workspaceId: z.string(), branch: z.string() })
```

### 2. Server — `GitWatcherService` (new file)

**Path:** `apps/server/src/services/git-watcher-service.ts`

Responsibilities:
- Resolve the correct HEAD file per workspace using `git rev-parse --git-dir`:
  - Returns `.git` → main repo → watch `<workspacePath>/.git/HEAD`
  - Returns absolute path → worktree → watch `<absolute-git-dir>/HEAD`
- Use `fs.watch` with a 200ms debounce to avoid rapid-fire events during rebase/merge
- On HEAD change: call `getCurrentBranchForPath(workspacePath)` and broadcast `branch.changed` with `{ workspaceId, branch }`
- `watchWorkspace(workspaceId: string, workspacePath: string): void`
- `unwatchWorkspace(workspaceId: string): void`
- `dispose(): void` — closes all active watchers (called on server shutdown)

Watcher lifecycle:
- Created when `workspace.create` RPC is handled (covers both new and existing workspaces that reconnect)
- Destroyed when `workspace.delete` RPC is handled
- All watchers closed on `process.on('SIGTERM')` / `process.on('SIGINT')` via `dispose()`

Error handling:
- If `git rev-parse --git-dir` fails (not a git repo), log a warning and skip the watcher for that workspace
- If the HEAD file doesn't exist, skip and log
- If `fs.watch` throws (e.g., unsupported platform), catch, log, and degrade gracefully (no crash)

### 3. Server — DI Registration (`container.ts`)

Register `GitWatcherService` as a singleton.

### 4. Server — WebSocket Router (`ws-router.ts`)

The WebSocket router already calls `WorkspaceService.create()` and `WorkspaceService.delete()`. After each:
- `create` → call `gitWatcherService.watchWorkspace(workspace.id, workspace.path)`
- `delete` → call `gitWatcherService.unwatchWorkspace(workspaceId)`

Also, on server startup, call `watchWorkspace` for all existing workspaces from `WorkspaceRepo.listAll()` so watchers are active after a server restart.

### 5. Frontend — `ws-events.ts`

Add handler for `branch.changed`:

```ts
pushEmitter.on("branch.changed", ({ workspaceId, branch }) => {
  const state = useWorkspaceStore.getState();
  state.loadBranches(workspaceId);
  // Update newThreadBranch only if the user hasn't manually overridden it
  if (!state.branchManuallySelected) {
    state.setNewThreadBranch(branch);
  }
});
```

### 6. Frontend — `workspaceStore.ts`

Add a `branchManuallySelected` boolean flag (default `false`). Set to `true` when the user explicitly picks a branch in `BranchPicker`. Reset to `false` when: (a) the active workspace ID changes, or (b) a new thread is successfully submitted (i.e., the composer clears).

### 7. Frontend — `Composer.tsx`

Remove the `branches.length === 0` guard:

```ts
// Before
useEffect(() => {
  if (isNewThread && workspaceId && branches.length === 0) {
    loadBranches(workspaceId);
  }
}, [isNewThread, workspaceId, branches.length, loadBranches]);

// After
useEffect(() => {
  if (isNewThread && workspaceId) {
    loadBranches(workspaceId);
  }
}, [isNewThread, workspaceId, loadBranches]);
```

This ensures the branch list is always fresh when entering new-thread mode, even without a push event (e.g., first load after server restart).

## Data Flow

```
User runs: git checkout main (external terminal)
    ↓
.git/HEAD file changes on disk
    ↓
fs.watch fires on server
    ↓
200ms debounce completes
    ↓
GitWatcherService calls getCurrentBranchForPath() → "main"
    ↓
broadcast("branch.changed", { workspaceId, branch: "main" })
    ↓
WebSocket push to all clients
    ↓
ws-events.ts handler fires
    ↓
workspaceStore.loadBranches(workspaceId) — re-fetches full branch list
    ↓
BranchPicker re-renders with updated isCurrent flags
```

## Files Affected

| File | Change |
|------|--------|
| `packages/contracts/src/ws/channels.ts` | Add `branch.changed` channel |
| `apps/server/src/services/git-watcher-service.ts` | **New** — HEAD watcher service |
| `apps/server/src/container.ts` | Register `GitWatcherService` as singleton |
| `apps/server/src/transport/ws-router.ts` | Call watch/unwatch on workspace create/delete |
| `apps/server/src/index.ts` | Init watchers for existing workspaces on startup; call `dispose()` on shutdown |
| `apps/web/src/transport/ws-events.ts` | Add `branch.changed` listener |
| `apps/web/src/stores/workspaceStore.ts` | Add `branchManuallySelected` flag |
| `apps/web/src/components/chat/Composer.tsx` | Remove `branches.length === 0` guard |

## Acceptance Criteria

- [ ] Branch indicator updates within ~1 second of an external `git checkout`
- [ ] Works for checkouts in the integrated terminal and external terminals
- [ ] Works for both main repo workspaces and worktree workspaces
- [ ] No excessive polling or CPU usage when idle
- [ ] File watcher cleaned up on workspace delete and app shutdown
- [ ] Existing thread branch display (locked mode) is unaffected — it shows `thread.branch`, not HEAD
- [ ] If the workspace is not a git repo, no crash — silent skip with log warning

## Out of Scope

- Detecting remote branch changes (fetch/pull) — HEAD doesn't change on fetch
- Notifying about new branches created externally — this would require watching `refs/heads/`, deferred to a future issue
- Stale locked-thread branch display — that shows the thread's creation-time branch, which is intentional
