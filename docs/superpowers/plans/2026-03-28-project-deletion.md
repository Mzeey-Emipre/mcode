# Project Deletion Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix project (workspace) deletion so it shows a confirmation dialog, reliably deletes the DB row with cascaded threads, and allows re-adding the same folder path.

**Architecture:** Add a confirmation dialog to `ProjectTree.tsx` mirroring the existing thread-delete dialog pattern. On the server, add a `findByPath` guard in `WorkspaceService.create()` so re-adding a path that already exists returns the existing workspace instead of throwing a UNIQUE constraint error. The DB schema already has `ON DELETE CASCADE` for threads/messages, so workspace deletion cascades correctly at the DB level.

**Tech Stack:** React, Zustand, shadcn/ui Dialog, better-sqlite3, Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `apps/web/src/components/sidebar/ProjectTree.tsx` | Add workspace delete confirmation dialog |
| Modify | `apps/server/src/services/workspace-service.ts` | Add `findByPath` guard in `create()` to prevent UNIQUE constraint errors |
| Modify | `apps/web/src/__tests__/workspace-behavior.test.ts` | Add store-level delete failure test |
| Create | `apps/server/src/__tests__/workspace-repo.test.ts` | DB-level workspace CRUD + cascade tests, service-level idempotent create tests |

---

### Task 1: Server-side workspace repo tests (cascade delete verification)

**Files:**
- Create: `apps/server/src/__tests__/workspace-repo.test.ts`
- Read: `apps/server/src/store/database.ts` (for `openMemoryDatabase`)
- Read: `apps/server/src/repositories/workspace-repo.ts`

- [ ] **Step 1: Write the failing test for workspace deletion with cascade**

```typescript
import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { WorkspaceRepo } from "../repositories/workspace-repo";

describe("WorkspaceRepo", () => {
  let db: Database.Database;
  let repo: WorkspaceRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new WorkspaceRepo(db);
  });

  it("remove() deletes the workspace row", () => {
    const ws = repo.create("test", "/tmp/test");
    expect(repo.findById(ws.id)).not.toBeNull();

    const deleted = repo.remove(ws.id);

    expect(deleted).toBe(true);
    expect(repo.findById(ws.id)).toBeNull();
  });

  it("remove() cascade-deletes associated threads", () => {
    const ws = repo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-1", ws.id, "Thread 1", "main", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-2", ws.id, "Thread 2", "main", now, now);

    repo.remove(ws.id);

    const threads = db
      .prepare("SELECT id FROM threads WHERE workspace_id = ?")
      .all(ws.id) as { id: string }[];
    expect(threads).toHaveLength(0);
  });

  it("remove() cascade-deletes messages through threads", () => {
    const ws = repo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-1", ws.id, "Thread", "main", now, now);
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("m-1", "t-1", "user", "hello", now, 1);

    repo.remove(ws.id);

    const messages = db
      .prepare("SELECT id FROM messages WHERE thread_id = ?")
      .all("t-1") as { id: string }[];
    expect(messages).toHaveLength(0);
  });

  it("remove() returns false for non-existent ID", () => {
    expect(repo.remove("non-existent")).toBe(false);
  });

  it("create() allows re-using a path after the previous workspace was deleted", () => {
    const ws1 = repo.create("test", "/tmp/reuse");
    repo.remove(ws1.id);

    const ws2 = repo.create("test-2", "/tmp/reuse");

    expect(ws2.id).not.toBe(ws1.id);
    expect(ws2.path).toBe("/tmp/reuse");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (baseline cascade verification)**

Run: `cd apps/server && npx vitest run src/__tests__/workspace-repo.test.ts`
Expected: All 5 tests PASS (the DB schema already has CASCADE, so these should pass against a fresh in-memory DB)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/__tests__/workspace-repo.test.ts
git commit -m "test: add workspace repo tests for cascade delete behavior"
```

---

### Task 2: Make workspace creation idempotent for existing paths

**Files:**
- Modify: `apps/server/src/services/workspace-service.ts`
- Modify: `apps/server/src/__tests__/workspace-repo.test.ts`

The UNIQUE constraint error on re-add happens when a workspace row persists in the DB but was removed from the UI state. Rather than only fixing the deletion bug, we also add a defensive `findByPath` check in `create()` so re-adding the same path returns the existing workspace.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/__tests__/workspace-repo.test.ts`, add the import to the top of the file (after the existing `WorkspaceRepo` import):

```typescript
import { WorkspaceService } from "../services/workspace-service";
```

Then append this describe block after the closing `});` of the `WorkspaceRepo` describe:

```typescript
describe("WorkspaceService", () => {
  let db: Database.Database;
  let repo: WorkspaceRepo;
  let service: WorkspaceService;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new WorkspaceRepo(db);
    service = new WorkspaceService(repo);
  });

  it("create() returns existing workspace when path already exists", () => {
    const ws1 = service.create("project-a", "/tmp/existing");

    const ws2 = service.create("project-a-renamed", "/tmp/existing");

    expect(ws2.id).toBe(ws1.id);
    expect(ws2.name).toBe("project-a");
  });

  it("create() creates a new workspace when path does not exist", () => {
    const ws = service.create("new-project", "/tmp/new");
    expect(ws.name).toBe("new-project");
    expect(ws.path).toBe("/tmp/new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/__tests__/workspace-repo.test.ts`
Expected: FAIL - "create() returns existing workspace when path already exists" fails with `SqliteError: UNIQUE constraint failed: workspaces.path`

- [ ] **Step 3: Implement findByPath check in WorkspaceService.create()**

Modify `apps/server/src/services/workspace-service.ts`:

```typescript
/**
 * Workspace CRUD service.
 * Thin orchestration layer over WorkspaceRepo.
 */

import { injectable, inject } from "tsyringe";
import type { Workspace } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";

/** Handles workspace creation, listing, and deletion. */
@injectable()
export class WorkspaceService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  /**
   * Create a new workspace, or return the existing one if the path is already registered.
   * This prevents UNIQUE constraint errors when re-adding a previously deleted (but persisted) workspace.
   */
  create(name: string, path: string): Workspace {
    const existing = this.workspaceRepo.findByPath(path);
    if (existing) return existing;
    return this.workspaceRepo.create(name, path);
  }

  /** List all workspaces ordered by most recently updated. */
  list(): Workspace[] {
    return this.workspaceRepo.listAll();
  }

  /** Delete a workspace by ID. Returns true if the workspace was removed. */
  delete(id: string): boolean {
    return this.workspaceRepo.remove(id);
  }

  /** Find a workspace by its primary key. Returns null if not found. */
  findById(id: string): Workspace | null {
    return this.workspaceRepo.findById(id);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/__tests__/workspace-repo.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/workspace-service.ts apps/server/src/__tests__/workspace-repo.test.ts
git commit -m "fix: make workspace creation idempotent for duplicate paths"
```

---

### Task 3: Add confirmation dialog for workspace deletion

**Files:**
- Modify: `apps/web/src/components/sidebar/ProjectTree.tsx`

This task adds a confirmation dialog before deleting a workspace, mirroring the existing thread-delete dialog pattern already in the same file.

- [ ] **Step 1: Add workspace delete dialog state**

In `ProjectTree.tsx`, add a new interface and state after the existing `DeleteDialogState` (line 42-46):

```typescript
interface WorkspaceDeleteDialogState {
  workspaceId: string;
  workspaceName: string;
}
```

Inside the `ProjectTree` component, after the `deleteWorktree` state (line 76), add:

```typescript
const [wsDeleteDialog, setWsDeleteDialog] = useState<WorkspaceDeleteDialogState | null>(null);
```

- [ ] **Step 2: Add the confirmation handler**

After the `handleDeleteConfirm` callback (line 208-217), add:

```typescript
const handleWorkspaceDeleteConfirm = useCallback(async () => {
  if (!wsDeleteDialog) return;
  try {
    await deleteWorkspace(wsDeleteDialog.workspaceId);
    setWsDeleteDialog(null);
  } catch {
    // Error shown via store.error; keep dialog open so user can retry
  }
}, [wsDeleteDialog, deleteWorkspace]);
```

- [ ] **Step 3: Change the onDelete prop to open the dialog instead of deleting directly**

Replace the `onDelete` prop on `ProjectNode` (lines 262-268):

```typescript
onDelete={() => {
  setWsDeleteDialog({
    workspaceId: ws.id,
    workspaceName: ws.name,
  });
}}
```

- [ ] **Step 4: Add the workspace delete confirmation dialog JSX**

After the existing thread delete dialog (`</Dialog>` at line 390), add the workspace delete dialog:

```tsx
{/* Workspace Delete Confirmation Dialog */}
<Dialog
  open={wsDeleteDialog !== null}
  onOpenChange={(open) => {
    if (!open) setWsDeleteDialog(null);
  }}
>
  <DialogContent showCloseButton={false} className="sm:max-w-md overflow-hidden">
    <div className="flex flex-col gap-2">
      <DialogTitle>Delete project</DialogTitle>
      <DialogDescription>
        Are you sure you want to delete &ldquo;{wsDeleteDialog?.workspaceName}&rdquo;?
        All threads in this project will also be removed. This action cannot be undone.
      </DialogDescription>
    </div>
    <div className="flex justify-end gap-2 pt-2">
      <Button
        variant="outline"
        onClick={() => setWsDeleteDialog(null)}
      >
        Cancel
      </Button>
      <Button variant="destructive" onClick={handleWorkspaceDeleteConfirm}>
        Delete
      </Button>
    </div>
  </DialogContent>
</Dialog>
```

- [ ] **Step 5: Verify the app renders correctly**

Run: `cd apps/web && npx vite build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/sidebar/ProjectTree.tsx
git commit -m "feat: add confirmation dialog for project deletion"
```

---

### Task 4: Add store-level tests for workspace delete behavior

**Files:**
- Modify: `apps/web/src/__tests__/workspace-behavior.test.ts`

- [ ] **Step 1: Add test for delete failure preserving state**

Add to the existing `describe("Workspace Behavior")` block in `workspace-behavior.test.ts`:

```typescript
it("when deleteWorkspace RPC fails, workspace and threads remain in state", async () => {
  const ws = createMockWorkspace();
  const thread = createMockThread({ workspace_id: ws.id });

  useWorkspaceStore.setState({
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    threads: [thread],
    activeThreadId: thread.id,
  });

  (
    mockTransport.deleteWorkspace as ReturnType<typeof vi.fn>
  ).mockRejectedValueOnce(new Error("server error"));

  await expect(
    useWorkspaceStore.getState().deleteWorkspace(ws.id),
  ).rejects.toThrow("server error");

  const state = useWorkspaceStore.getState();
  expect(state.workspaces).toHaveLength(1);
  expect(state.threads).toHaveLength(1);
  expect(state.error).toContain("server error");
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/workspace-behavior.test.ts`
Expected: All tests PASS (the store code already handles errors correctly)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/__tests__/workspace-behavior.test.ts
git commit -m "test: add workspace delete failure test"
```

---

### Task 5: Run full test suite and verify

**Files:**
- None (verification only)

- [ ] **Step 1: Run all unit tests**

Run: `bun run test`
Expected: All tests PASS

- [ ] **Step 2: Build the app**

Run: `cd apps/web && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Final commit (if any fixups needed)**

Only if previous steps revealed issues that required code changes.
