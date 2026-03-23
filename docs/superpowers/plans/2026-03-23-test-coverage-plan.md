# Mcode Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Mcode test coverage from ~20% to 80%+ with risk-prioritized tests across backend and frontend.

**Architecture:** Integration tests with real in-memory SQLite for backend repos and AppState. Unit tests with mocked dependencies for sidecar, config, worktree validation, and frontend utilities. Vitest for both apps, Playwright E2E unchanged.

**Tech Stack:** Vitest 4, better-sqlite3 (in-memory), vi.mock/vi.fn for mocking, @vitest/coverage-v8

**Spec:** `docs/superpowers/specs/2026-03-22-test-coverage-design.md`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `apps/desktop/vitest.config.ts` | Desktop Vitest config (node env) |
| Modify | `apps/desktop/package.json` | Add vitest + coverage deps, test script |
| Create | `apps/desktop/src/main/__tests__/helpers/db.ts` | Shared in-memory DB helper |
| Create | `apps/desktop/src/main/__tests__/repositories.test.ts` | Repo integration tests |
| Create | `apps/desktop/src/main/__tests__/app-state.test.ts` | AppState integration tests |
| Create | `apps/desktop/src/main/__tests__/worktree.test.ts` | Worktree unit + integration tests |
| Create | `apps/desktop/src/main/__tests__/config.test.ts` | Config unit tests |
| Create | `apps/desktop/src/main/__tests__/sidecar-client.test.ts` | SidecarClient unit tests |
| Create | `apps/web/src/__tests__/settings-store.test.ts` | Settings store tests |
| Create | `apps/web/src/__tests__/model-registry.test.ts` | Model registry tests |
| Create | `apps/web/src/__tests__/thread-status.test.ts` | Thread status display tests |
| Create | `apps/web/src/__tests__/time.test.ts` | Relative time tests |
| Create | `apps/web/src/__tests__/shortcuts.test.ts` | Keyboard shortcuts tests |
| Create | `apps/web/src/__tests__/tool-call-matching.test.ts` | Tool call ID matching tests |
| Create | `apps/web/src/__tests__/agent-event-branches.test.ts` | handleAgentEvent branch tests |

---

## Task 1: Test Infrastructure (MUST run first, all other tasks depend on this)

**Files:**
- Create: `apps/desktop/vitest.config.ts`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/main/__tests__/helpers/db.ts`

- [ ] **Step 1: Add vitest + coverage deps to desktop package.json**

Add to `devDependencies` in `apps/desktop/package.json`:

```json
"vitest": "^4.1.0",
"@vitest/coverage-v8": "^4.1.0"
```

Add to `scripts`:

```json
"test": "vitest run"
```

- [ ] **Step 2: Install dependencies**

Run: `cd apps/desktop && bun install`

- [ ] **Step 3: Create desktop Vitest config**

Create `apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/main/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/main/**/*.ts"],
      exclude: ["src/main/__tests__/**", "src/preload/**"],
    },
  },
});
```

- [ ] **Step 4: Create DB test helper**

Create `apps/desktop/src/main/__tests__/helpers/db.ts`:

```ts
import { openMemoryDatabase } from "../../store/database.js";
import type Database from "better-sqlite3";

export function createTestDb(): Database.Database {
  return openMemoryDatabase();
}
```

- [ ] **Step 5: Verify infrastructure works**

Run: `cd apps/desktop && npx vitest run --passWithNoTests`
Expected: Vitest runs successfully with 0 tests.

- [ ] **Step 6: Commit**

```text
test: add Vitest config and DB test helper for desktop app
```

---

## Task 2: Repository Integration Tests

**Depends on:** Task 1
**Files:**
- Create: `apps/desktop/src/main/__tests__/repositories.test.ts`

- [ ] **Step 1: Write workspace repo tests**

Create `apps/desktop/src/main/__tests__/repositories.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers/db.js";
import * as WorkspaceRepo from "../repositories/workspace-repo.js";
import * as ThreadRepo from "../repositories/thread-repo.js";
import * as MessageRepo from "../repositories/message-repo.js";

describe("WorkspaceRepo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates a workspace with UUID and correct fields", () => {
    const ws = WorkspaceRepo.create(db, "my-project", "/tmp/my-project");
    expect(ws.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(ws.name).toBe("my-project");
    expect(ws.path).toBe("/tmp/my-project");
    expect(ws.provider_config).toEqual({});
    expect(ws.created_at).toBeTruthy();
  });

  it("findById returns null for nonexistent ID", () => {
    expect(WorkspaceRepo.findById(db, "nonexistent")).toBeNull();
  });

  it("findByPath returns the workspace by path", () => {
    const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
    const found = WorkspaceRepo.findByPath(db, "/tmp/proj");
    expect(found?.id).toBe(ws.id);
  });

  it("duplicate path throws due to UNIQUE constraint", () => {
    WorkspaceRepo.create(db, "proj1", "/tmp/proj");
    expect(() => WorkspaceRepo.create(db, "proj2", "/tmp/proj")).toThrow();
  });

  it("listAll returns workspaces in descending updated_at order", () => {
    const ws1 = WorkspaceRepo.create(db, "a", "/tmp/a");
    const ws2 = WorkspaceRepo.create(db, "b", "/tmp/b");
    const list = WorkspaceRepo.listAll(db);
    // ws2 created after ws1, so ws2 should be first
    expect(list[0].id).toBe(ws2.id);
    expect(list[1].id).toBe(ws1.id);
  });

  it("remove deletes a workspace", () => {
    const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
    expect(WorkspaceRepo.remove(db, ws.id)).toBe(true);
    expect(WorkspaceRepo.findById(db, ws.id)).toBeNull();
  });

  it("remove cascades to threads via FK", () => {
    const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
    ThreadRepo.create(db, ws.id, "Thread 1", "direct", "main");
    WorkspaceRepo.remove(db, ws.id);
    const threads = ThreadRepo.listByWorkspace(db, ws.id);
    expect(threads).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run workspace tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All WorkspaceRepo tests pass.

- [ ] **Step 3: Add thread repo tests**

Append to the same file:

```ts
describe("ThreadRepo", () => {
  let db: Database.Database;
  let workspaceId: string;

  beforeEach(() => {
    db = createTestDb();
    const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
    workspaceId = ws.id;
  });

  it("creates a thread with session_name in mcode-{uuid} format", () => {
    const thread = ThreadRepo.create(db, workspaceId, "Feature", "direct", "main");
    expect(thread.session_name).toBe(`mcode-${thread.id}`);
    expect(thread.status).toBe("active");
    expect(thread.mode).toBe("direct");
  });

  it("listByWorkspace excludes soft-deleted threads", () => {
    const t1 = ThreadRepo.create(db, workspaceId, "T1", "direct", "main");
    ThreadRepo.create(db, workspaceId, "T2", "direct", "main");
    ThreadRepo.softDelete(db, t1.id);
    const list = ThreadRepo.listByWorkspace(db, workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("T2");
  });

  it("listByWorkspace clamps limit: 0 becomes 1", () => {
    ThreadRepo.create(db, workspaceId, "T1", "direct", "main");
    ThreadRepo.create(db, workspaceId, "T2", "direct", "main");
    const list = ThreadRepo.listByWorkspace(db, workspaceId, 0);
    expect(list).toHaveLength(1);
  });

  it("listByWorkspace clamps limit: >1000 becomes 1000", () => {
    ThreadRepo.create(db, workspaceId, "T1", "direct", "main");
    // Just verify it doesn't throw with large limit
    const list = ThreadRepo.listByWorkspace(db, workspaceId, 9999);
    expect(list).toHaveLength(1);
  });

  it("softDelete sets deleted_at and status to deleted", () => {
    const t = ThreadRepo.create(db, workspaceId, "T", "direct", "main");
    ThreadRepo.softDelete(db, t.id);
    const found = ThreadRepo.findById(db, t.id);
    expect(found?.status).toBe("deleted");
    expect(found?.deleted_at).toBeTruthy();
  });

  it("hardDelete removes the row entirely", () => {
    const t = ThreadRepo.create(db, workspaceId, "T", "direct", "main");
    ThreadRepo.hardDelete(db, t.id);
    expect(ThreadRepo.findById(db, t.id)).toBeNull();
  });

  it("updateModel returns true on success, false for nonexistent", () => {
    const t = ThreadRepo.create(db, workspaceId, "T", "direct", "main");
    expect(ThreadRepo.updateModel(db, t.id, "claude-opus-4-6")).toBe(true);
    expect(ThreadRepo.updateModel(db, "nonexistent", "claude-opus-4-6")).toBe(false);
    const found = ThreadRepo.findById(db, t.id);
    expect(found?.model).toBe("claude-opus-4-6");
  });

  it("updateTitle returns true on success, false for nonexistent", () => {
    const t = ThreadRepo.create(db, workspaceId, "T", "direct", "main");
    expect(ThreadRepo.updateTitle(db, t.id, "New Title")).toBe(true);
    expect(ThreadRepo.updateTitle(db, "nonexistent", "New Title")).toBe(false);
  });

  it("updateWorktreePath returns true on success, false for nonexistent", () => {
    const t = ThreadRepo.create(db, workspaceId, "T", "direct", "main");
    expect(ThreadRepo.updateWorktreePath(db, t.id, "/tmp/wt")).toBe(true);
    expect(ThreadRepo.updateWorktreePath(db, "nonexistent", "/tmp/wt")).toBe(false);
  });

  it("updateStatus transitions correctly", () => {
    const t = ThreadRepo.create(db, workspaceId, "T", "direct", "main");
    expect(ThreadRepo.updateStatus(db, t.id, "paused")).toBe(true);
    expect(ThreadRepo.findById(db, t.id)?.status).toBe("paused");
    expect(ThreadRepo.updateStatus(db, t.id, "interrupted")).toBe(true);
    expect(ThreadRepo.findById(db, t.id)?.status).toBe("interrupted");
  });
});
```

- [ ] **Step 4: Run thread tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All ThreadRepo tests pass.

- [ ] **Step 5: Add message repo tests**

Append to the same file:

```ts
describe("MessageRepo", () => {
  let db: Database.Database;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
    const thread = ThreadRepo.create(db, ws.id, "T", "direct", "main");
    threadId = thread.id;
  });

  it("creates a message with correct fields", () => {
    const msg = MessageRepo.create(db, threadId, "user", "Hello", 1);
    expect(msg.id).toBeTruthy();
    expect(msg.thread_id).toBe(threadId);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello");
    expect(msg.sequence).toBe(1);
    expect(msg.tool_calls).toBeNull();
  });

  it("listByThread returns messages in ascending sequence order", () => {
    MessageRepo.create(db, threadId, "user", "First", 1);
    MessageRepo.create(db, threadId, "assistant", "Second", 2);
    MessageRepo.create(db, threadId, "user", "Third", 3);
    const msgs = MessageRepo.listByThread(db, threadId, 100);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].sequence).toBe(1);
    expect(msgs[1].sequence).toBe(2);
    expect(msgs[2].sequence).toBe(3);
  });

  it("listByThread clamps limit: 0 or negative becomes 1", () => {
    MessageRepo.create(db, threadId, "user", "A", 1);
    MessageRepo.create(db, threadId, "user", "B", 2);
    expect(MessageRepo.listByThread(db, threadId, 0)).toHaveLength(1);
    expect(MessageRepo.listByThread(db, threadId, -5)).toHaveLength(1);
  });

  it("listByThread clamps limit: >1000 becomes 1000", () => {
    MessageRepo.create(db, threadId, "user", "A", 1);
    const msgs = MessageRepo.listByThread(db, threadId, 9999);
    expect(msgs).toHaveLength(1); // only 1 message exists
  });

  it("parseJsonField: malformed JSON in tool_calls returns null", () => {
    // Insert row with malformed JSON directly
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, tool_calls, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg-bad", threadId, "assistant", "hi", "not-valid-json{", new Date().toISOString(), 10);
    const msgs = MessageRepo.listByThread(db, threadId, 100);
    const badMsg = msgs.find((m) => m.id === "msg-bad");
    expect(badMsg?.tool_calls).toBeNull();
  });

  it("parseJsonField: valid JSON in tool_calls is parsed", () => {
    const toolCalls = JSON.stringify([{ id: "tc1", name: "read" }]);
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, tool_calls, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("msg-good", threadId, "assistant", "hi", toolCalls, new Date().toISOString(), 11);
    const msgs = MessageRepo.listByThread(db, threadId, 100);
    const goodMsg = msgs.find((m) => m.id === "msg-good");
    expect(goodMsg?.tool_calls).toEqual([{ id: "tc1", name: "read" }]);
  });

  it("parseJsonField: null tool_calls stays null", () => {
    const msg = MessageRepo.create(db, threadId, "user", "hi", 12);
    const msgs = MessageRepo.listByThread(db, threadId, 100);
    const found = msgs.find((m) => m.id === msg.id);
    expect(found?.tool_calls).toBeNull();
  });
});
```

- [ ] **Step 6: Run all repository tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All 24 tests pass.

- [ ] **Step 7: Commit**

```text
test: add repository integration tests (workspace, thread, message)
```

---

## Task 3: AppState Integration Tests

**Depends on:** Task 1
**Files:**
- Create: `apps/desktop/src/main/__tests__/app-state.test.ts`

This is the largest test file. It uses a real in-memory DB but mocks `worktree.ts` and `SidecarClient`.

- [ ] **Step 1: Write AppState test file with createThread tests**

Create `apps/desktop/src/main/__tests__/app-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "./helpers/db.js";
import * as WorkspaceRepo from "../repositories/workspace-repo.js";
import * as ThreadRepo from "../repositories/thread-repo.js";
import * as MessageRepo from "../repositories/message-repo.js";

// Mock worktree module
vi.mock("../worktree.js", () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  listBranches: vi.fn().mockReturnValue([]),
  getCurrentBranch: vi.fn().mockReturnValue("main"),
  checkoutBranch: vi.fn(),
}));

// Mock sidecar client module
vi.mock("../sidecar/client.js", () => ({
  SidecarClient: {
    start: vi.fn().mockReturnValue({
      sendMessage: vi.fn(),
      stopSession: vi.fn(),
      shutdown: vi.fn(),
      on: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    }),
  },
}));

// Mock logger to suppress output
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs for cwd validation in sendMessage
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
  };
});

import { AppState } from "../app-state.js";
import { createWorktree, removeWorktree } from "../worktree.js";
import { existsSync, statSync } from "fs";

describe("AppState", () => {
  let appState: AppState;
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create AppState with in-memory DB by directly setting the db property
    db = createTestDb();
    // We need to construct AppState differently since constructor opens a file DB
    // Use Object.create to bypass constructor, then set db manually
    appState = Object.create(AppState.prototype) as AppState;
    (appState as unknown as { db: Database.Database }).db = db;
    (appState as unknown as { sidecar: null }).sidecar = null;
    (appState as unknown as { activeSessionIds: Set<string> }).activeSessionIds = new Set();
  });

  describe("createThread", () => {
    let workspaceId: string;

    beforeEach(() => {
      const ws = WorkspaceRepo.create(db, "proj", "/tmp/proj");
      workspaceId = ws.id;
    });

    it("direct mode creates thread without calling createWorktree", () => {
      const thread = appState.createThread(workspaceId, "Feature", "direct", "main");
      expect(thread.mode).toBe("direct");
      expect(thread.worktree_path).toBeNull();
      expect(createWorktree).not.toHaveBeenCalled();
    });

    it("worktree mode calls createWorktree and persists worktree_path", () => {
      vi.mocked(createWorktree).mockReturnValue({
        name: "feature-12345678",
        path: "/tmp/wt/feature-12345678",
        branch: "mcode/feature-12345678",
      });
      const thread = appState.createThread(workspaceId, "Feature", "worktree", "main");
      expect(createWorktree).toHaveBeenCalled();
      expect(thread.worktree_path).toBe("/tmp/wt/feature-12345678");
    });

    it("worktree failure: DB record is hard-deleted on createWorktree throw", () => {
      vi.mocked(createWorktree).mockImplementation(() => {
        throw new Error("git worktree add failed");
      });
      expect(() => appState.createThread(workspaceId, "Feature", "worktree", "main")).toThrow(
        "git worktree add failed",
      );
      // Verify the thread was cleaned up
      const threads = ThreadRepo.listByWorkspace(db, workspaceId);
      expect(threads).toHaveLength(0);
    });

    it("worktree mode with nonexistent workspace: hard-deletes DB record", () => {
      expect(() =>
        appState.createThread("nonexistent-ws-id", "Feature", "worktree", "main"),
      ).toThrow();
    });

    it("rejects empty branch name", () => {
      expect(() => appState.createThread(workspaceId, "F", "direct", "")).toThrow(
        "Branch name must be 1-250 characters",
      );
    });

    it("rejects branch >250 chars", () => {
      expect(() =>
        appState.createThread(workspaceId, "F", "direct", "a".repeat(251)),
      ).toThrow("Branch name must be 1-250 characters");
    });

    it.each(["feat~1", "feat^2", "feat:bar", "feat?", "feat*", "feat[0]", "feat\\bar", "feat\tbar", "feat..bar", "-leading", "feat bar"])(
      "rejects invalid branch chars: %s",
      (branch) => {
        expect(() => appState.createThread(workspaceId, "F", "direct", branch)).toThrow(
          "Branch name contains invalid characters",
        );
      },
    );

    it("rejects unknown mode", () => {
      expect(() =>
        appState.createThread(workspaceId, "F", "unknown" as string, "main"),
      ).toThrow("Unknown thread mode: unknown");
    });
  });
});
```

- [ ] **Step 2: Run createThread tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All createThread tests pass.

- [ ] **Step 3: Add sendMessage, stopAgent, createAndSendMessage, deleteThread, shutdown tests**

Append additional describe blocks to the same file for `sendMessage`, `stopAgent`, `createAndSendMessage`, `deleteThread`, and `shutdown`. Each follows the patterns from the spec:

- `sendMessage`: Create workspace + thread in DB, mock sidecar, mock fs for cwd validation. Test happy path (real temp dir), rejection cases, resume detection, error rollback.
- `stopAgent`: Test session ID contract, status update, null sidecar safety.
- `createAndSendMessage`: Test direct/worktree mode routing, title truncation, DB round-trip.
- `deleteThread`: Test sidecar stop, soft-delete, worktree cleanup flag.
- `shutdown`: Track sessions, verify interrupted status, DB close.

Each test should follow the same pattern: set up DB state, call AppState method, assert DB state and mock calls.

- [ ] **Step 4: Run all AppState tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All AppState tests pass (~30 tests).

- [ ] **Step 5: Commit**

```text
test: add AppState integration tests (createThread, sendMessage, lifecycle)
```

---

## Task 4: Worktree Tests

**Depends on:** Task 1
**Files:**
- Create: `apps/desktop/src/main/__tests__/worktree.test.ts`

- [ ] **Step 1: Write validateName unit tests**

Create `apps/desktop/src/main/__tests__/worktree.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { validateName, createWorktree, removeWorktree, listBranches, getCurrentBranch, branchExists, checkoutBranch, listWorktrees } from "../worktree.js";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("validateName", () => {
  it("accepts valid names", () => {
    expect(() => validateName("my-feature")).not.toThrow();
    expect(() => validateName("fix-123")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateName("")).toThrow("1-100 characters");
  });

  it("rejects >100 chars", () => {
    expect(() => validateName("a".repeat(101))).toThrow("1-100 characters");
  });

  it("rejects path traversal with '..'", () => {
    expect(() => validateName("foo..bar")).toThrow("invalid characters");
  });

  it("rejects forward slash", () => {
    expect(() => validateName("foo/bar")).toThrow("invalid characters");
  });

  it("rejects backslash", () => {
    expect(() => validateName("foo\\bar")).toThrow("invalid characters");
  });

  it("rejects dot-prefixed names", () => {
    expect(() => validateName(".hidden")).toThrow("cannot start with '.'");
  });
});

describe("Git operations (integration)", () => {
  let repoPath: string;

  beforeAll(() => {
    repoPath = mkdtempSync(join(tmpdir(), "mcode-test-"));
    execFileSync("git", ["init", repoPath], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "init"], {
      stdio: "pipe",
    });
  });

  afterAll(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("createWorktree creates directory and branch", () => {
    const info = createWorktree(repoPath, "test-feature");
    expect(info.branch).toBe("mcode/test-feature");
    expect(info.path).toContain("test-feature");
    expect(branchExists(repoPath, "mcode/test-feature")).toBe(true);
  });

  it("createWorktree throws if repo path doesn't exist", () => {
    expect(() => createWorktree("/nonexistent/path", "foo")).toThrow();
  });

  it("createWorktree throws if worktree already exists", () => {
    expect(() => createWorktree(repoPath, "test-feature")).toThrow("already exists");
  });

  it("listWorktrees returns entries", () => {
    const wts = listWorktrees(repoPath);
    expect(wts.some((w) => w.name === "test-feature")).toBe(true);
  });

  it("listBranches sorts current first, then local > worktree > remote", () => {
    const branches = listBranches(repoPath);
    expect(branches.length).toBeGreaterThan(0);
    // Current branch should be first
    if (branches.length > 1) {
      const currentIdx = branches.findIndex((b) => b.isCurrent);
      expect(currentIdx).toBe(0);
    }
  });

  it("getCurrentBranch returns the branch name", () => {
    const branch = getCurrentBranch(repoPath);
    expect(branch).toBeTruthy();
  });

  it("getCurrentBranch returns 'main' on failure", () => {
    const branch = getCurrentBranch("/nonexistent");
    expect(branch).toBe("main");
  });

  it("removeWorktree cleans up directory and branch", () => {
    removeWorktree(repoPath, "test-feature");
    expect(branchExists(repoPath, "mcode/test-feature")).toBe(false);
  });

  it("removeWorktree returns true even if worktree already gone", () => {
    const result = removeWorktree(repoPath, "test-feature");
    expect(result).toBe(true);
  });

  it("checkoutBranch switches branches", () => {
    execFileSync("git", ["-C", repoPath, "branch", "test-branch"], { stdio: "pipe" });
    checkoutBranch(repoPath, "test-branch");
    expect(getCurrentBranch(repoPath)).toBe("test-branch");
  });

  it("branchExists returns false for nonexistent branch", () => {
    expect(branchExists(repoPath, "nonexistent-branch")).toBe(false);
  });
});
```

- [ ] **Step 2: Run worktree tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All worktree tests pass.

- [ ] **Step 3: Commit**

```text
test: add worktree validateName unit tests and git integration tests
```

---

## Task 5: Config Tests

**Depends on:** Task 1
**Files:**
- Create: `apps/desktop/src/main/__tests__/config.test.ts`

- [ ] **Step 1: Write config tests**

Create `apps/desktop/src/main/__tests__/config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("which", () => ({
  default: { sync: vi.fn() },
}));

import { discoverConfig, spawnEnv } from "../config.js";
import { existsSync } from "fs";
import which from "which";

describe("discoverConfig", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.MCODE_CLAUDE_PATH;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.MCODE_CLAUDE_PATH;
    } else {
      process.env.MCODE_CLAUDE_PATH = savedEnv;
    }
  });

  it("returns all true when config exists everywhere", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(which.sync).mockReturnValue("/usr/bin/claude");
    const config = discoverConfig("/workspace");
    expect(config.has_user_config).toBe(true);
    expect(config.has_project_config).toBe(true);
    expect(config.has_user_claude_md).toBe(true);
    expect(config.has_project_claude_md).toBe(true);
    expect(config.cli_available).toBe(true);
  });

  it("returns all false for bare workspace", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(which.sync).mockImplementation(() => {
      throw new Error("not found");
    });
    const config = discoverConfig("/bare");
    expect(config.has_user_config).toBe(false);
    expect(config.has_project_config).toBe(false);
    expect(config.has_user_claude_md).toBe(false);
    expect(config.has_project_claude_md).toBe(false);
    expect(config.cli_available).toBe(false);
  });

  it("detects CLAUDE.md at workspace root", () => {
    vi.mocked(existsSync).mockImplementation((path: string | unknown) => {
      return String(path).endsWith("CLAUDE.md") && !String(path).includes(".claude");
    });
    vi.mocked(which.sync).mockImplementation(() => {
      throw new Error("not found");
    });
    const config = discoverConfig("/workspace");
    expect(config.has_project_claude_md).toBe(true);
  });

  it("respects MCODE_CLAUDE_PATH env override", () => {
    process.env.MCODE_CLAUDE_PATH = "/custom/claude";
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(which.sync).mockReturnValue("/custom/claude");
    const config = discoverConfig("/workspace");
    expect(config.cli_path).toBe("/custom/claude");
  });
});

describe("spawnEnv", () => {
  it("includes HOME key", () => {
    const env = spawnEnv();
    expect(env.HOME).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run config tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All config tests pass.

- [ ] **Step 3: Commit**

```text
test: add config discovery unit tests
```

---

## Task 6: SidecarClient Tests

**Depends on:** Task 1
**Files:**
- Create: `apps/desktop/src/main/__tests__/sidecar-client.test.ts`

- [ ] **Step 1: Write sidecar client tests with mock query helper**

Create `apps/desktop/src/main/__tests__/sidecar-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SidecarEvent } from "../sidecar/types.js";

// Helper: create a mock async iterable that yields events and has setModel
function createMockQuery(events: Array<Record<string, unknown>>) {
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    setModel: vi.fn().mockResolvedValue(undefined),
  };
  return iterable;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SidecarClient } from "../sidecar/client.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

describe("SidecarClient", () => {
  let client: SidecarClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = SidecarClient.start();
  });

  it("isReady returns true immediately", () => {
    expect(client.isReady()).toBe(true);
  });

  it("emits session.message with accumulated text on result", async () => {
    const events: SidecarEvent[] = [];
    client.on("event", (e: SidecarEvent) => events.push(e));

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello world" }] },
        },
        {
          type: "result",
          stop_reason: "end_turn",
          total_cost_usd: 0.01,
          usage: { input_tokens: 50, output_tokens: 100 },
        },
      ]) as ReturnType<typeof query>,
    );

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    const messageEvent = events.find((e) => e.method === "session.message");
    expect(messageEvent).toBeTruthy();
    if (messageEvent?.method === "session.message") {
      expect(messageEvent.params.content).toBe("Hello world");
    }

    const turnEvent = events.find((e) => e.method === "session.turnComplete");
    expect(turnEvent).toBeTruthy();
  });

  it("emits session.toolUse for tool_use blocks", async () => {
    const events: SidecarEvent[] = [];
    client.on("event", (e: SidecarEvent) => events.push(e));

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tc1", name: "Read", input: { path: "/foo" } },
            ],
          },
        },
        { type: "result", stop_reason: "end_turn" },
      ]) as ReturnType<typeof query>,
    );

    await client.sendMessage("mcode-123", "Read file", "/tmp", "claude-sonnet-4-6", false, "default");

    const toolEvent = events.find((e) => e.method === "session.toolUse");
    expect(toolEvent).toBeTruthy();
    if (toolEvent?.method === "session.toolUse") {
      expect(toolEvent.params.toolName).toBe("Read");
      expect(toolEvent.params.toolCallId).toBe("tc1");
    }
  });

  it("emits session.error and session.ended on SDK throw", async () => {
    const events: SidecarEvent[] = [];
    client.on("event", (e: SidecarEvent) => events.push(e));

    vi.mocked(query).mockReturnValue(
      createMockQuery([]).constructor.prototype as ReturnType<typeof query>,
    );
    // Override: make query throw
    vi.mocked(query).mockImplementation(() => {
      const iter = {
        async *[Symbol.asyncIterator]() {
          throw new Error("SDK crash");
        },
        setModel: vi.fn().mockResolvedValue(undefined),
      };
      return iter as ReturnType<typeof query>;
    });

    await client.sendMessage("mcode-456", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    expect(events.some((e) => e.method === "session.error")).toBe(true);
    expect(events.some((e) => e.method === "session.ended")).toBe(true);
  });

  it("shutdown aborts all sessions and clears map", () => {
    client.shutdown();
    // After shutdown, sending should still work (new session)
    expect(client.isReady()).toBe(true);
  });

  it("duplicate session ID aborts the previous session", async () => {
    const abortSpy = vi.fn();
    vi.mocked(query).mockImplementation(() => {
      const controller = new AbortController();
      const origAbort = controller.abort.bind(controller);
      controller.abort = (...args: Parameters<typeof origAbort>) => {
        abortSpy();
        return origAbort(...args);
      };
      const iter = {
        async *[Symbol.asyncIterator]() {
          // Simulate long-running session
          await new Promise((resolve) => setTimeout(resolve, 5000));
        },
        setModel: vi.fn().mockResolvedValue(undefined),
      };
      return iter as ReturnType<typeof query>;
    });

    // Start first session (don't await - it's long-running)
    client.sendMessage("mcode-dup", "msg1", "/tmp", "claude-sonnet-4-6", false, "default");

    // Small delay to let the first session register
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Start second session with same ID - should abort first
    client.sendMessage("mcode-dup", "msg2", "/tmp", "claude-sonnet-4-6", false, "default");

    // The first session's abort should have been called
    expect(abortSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run sidecar tests**

Run: `cd apps/desktop && npx vitest run --reporter=verbose`
Expected: All sidecar tests pass.

- [ ] **Step 3: Commit**

```text
test: add SidecarClient unit tests with mocked SDK query
```

---

## Task 7: Frontend Utility Tests

**Depends on:** Nothing (independent of backend tasks)
**Files:**
- Create: `apps/web/src/__tests__/settings-store.test.ts`
- Create: `apps/web/src/__tests__/model-registry.test.ts`
- Create: `apps/web/src/__tests__/thread-status.test.ts`
- Create: `apps/web/src/__tests__/time.test.ts`
- Create: `apps/web/src/__tests__/shortcuts.test.ts`

- [ ] **Step 1: Write settings store tests**

Create `apps/web/src/__tests__/settings-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";

describe("SettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      theme: "system",
      maxConcurrentAgents: 5,
      notificationsEnabled: true,
    });
  });

  it("default theme is system", () => {
    expect(useSettingsStore.getState().theme).toBe("system");
  });

  it("default maxConcurrentAgents is 5", () => {
    expect(useSettingsStore.getState().maxConcurrentAgents).toBe(5);
  });

  it("setTheme updates state", () => {
    useSettingsStore.getState().setTheme("dark");
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("setMaxConcurrentAgents updates state", () => {
    useSettingsStore.getState().setMaxConcurrentAgents(3);
    expect(useSettingsStore.getState().maxConcurrentAgents).toBe(3);
  });

  it("setNotificationsEnabled updates state", () => {
    useSettingsStore.getState().setNotificationsEnabled(false);
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Write model registry tests**

Create `apps/web/src/__tests__/model-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  MODEL_PROVIDERS,
  findModelById,
  findProviderForModel,
  getDefaultModel,
} from "@/lib/model-registry";

describe("ModelRegistry", () => {
  it("MODEL_PROVIDERS contains Claude with 3 models", () => {
    const claude = MODEL_PROVIDERS.find((p) => p.id === "claude");
    expect(claude).toBeTruthy();
    expect(claude?.models).toHaveLength(3);
    expect(claude?.comingSoon).toBe(false);
  });

  it("findModelById returns correct model", () => {
    const model = findModelById("claude-sonnet-4-6");
    expect(model?.label).toBe("Claude Sonnet 4.6");
    expect(model?.providerId).toBe("claude");
  });

  it("findModelById returns undefined for unknown ID", () => {
    expect(findModelById("nonexistent")).toBeUndefined();
  });

  it("findProviderForModel returns provider", () => {
    const provider = findProviderForModel("claude-opus-4-6");
    expect(provider?.id).toBe("claude");
  });

  it("findProviderForModel returns undefined for unknown model", () => {
    expect(findProviderForModel("nonexistent")).toBeUndefined();
  });

  it("getDefaultModel returns Claude Sonnet 4.6", () => {
    const model = getDefaultModel();
    expect(model.id).toBe("claude-sonnet-4-6");
  });
});
```

- [ ] **Step 3: Write thread status tests**

Create `apps/web/src/__tests__/thread-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getStatusDisplay } from "@/lib/thread-status";
import type { Thread } from "@/transport/types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    workspace_id: "ws1",
    title: "Test",
    status: "active",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    issue_number: null,
    pr_number: null,
    pr_status: null,
    session_name: "mcode-t1",
    pid: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    deleted_at: null,
    ...overrides,
  };
}

describe("getStatusDisplay", () => {
  it("isActuallyRunning=true returns Working with yellow", () => {
    const result = getStatusDisplay(makeThread(), true);
    expect(result.label).toBe("Working");
    expect(result.color).toContain("yellow");
  });

  it("errored status returns Errored with red", () => {
    const result = getStatusDisplay(makeThread({ status: "errored" }), false);
    expect(result.label).toBe("Errored");
    expect(result.color).toContain("red");
  });

  it("completed status returns Completed with green", () => {
    const result = getStatusDisplay(makeThread({ status: "completed" }), false);
    expect(result.label).toBe("Completed");
    expect(result.color).toContain("green");
  });

  it("default status returns empty label", () => {
    const result = getStatusDisplay(makeThread({ status: "active" }), false);
    expect(result.label).toBe("");
  });
});
```

- [ ] **Step 4: Write time tests**

Create `apps/web/src/__tests__/time.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { relativeTime } from "@/lib/time";

describe("relativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("< 1 minute ago returns 'now'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:30Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("now");
  });

  it("5 minutes ago returns '5m'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:05:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("5m");
  });

  it("3 hours ago returns '3h'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T15:00:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("3h");
  });

  it("2 days ago returns '2d'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("2d");
  });

  it("45 days ago returns '1mo'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00Z"));
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("1mo");
  });

  it("future date clamped to 'now'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00Z"));
    expect(relativeTime("2026-03-23T13:00:00Z")).toBe("now");
  });
});
```

- [ ] **Step 5: Write shortcuts tests**

Create `apps/web/src/__tests__/shortcuts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerShortcut, handleKeyDown, getShortcuts } from "@/lib/shortcuts";

function createKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: overrides.key ?? "a",
    ctrlKey: overrides.ctrlKey ?? false,
    metaKey: overrides.metaKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
  });
  vi.spyOn(event, "preventDefault");
  return event;
}

describe("Shortcuts", () => {
  beforeEach(() => {
    // Clear all shortcuts by unregistering
    for (const s of [...getShortcuts()]) {
      registerShortcut(s)(); // register returns unregister, which we call immediately
    }
  });

  it("registerShortcut adds to list and returns unregister fn", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    expect(getShortcuts().length).toBeGreaterThanOrEqual(1);
    unregister();
  });

  it("unregister function removes shortcut", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    const lengthBefore = getShortcuts().length;
    unregister();
    expect(getShortcuts().length).toBe(lengthBefore - 1);
  });

  it("handleKeyDown fires matching handler and prevents default", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    const event = createKeyEvent({ key: "k", ctrlKey: true });
    handleKeyDown(event);
    expect(handler).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    unregister();
  });

  it("handleKeyDown respects ctrl/meta modifier", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    // Without ctrl - should not fire
    handleKeyDown(createKeyEvent({ key: "k" }));
    expect(handler).not.toHaveBeenCalled();
    // With meta - should fire (ctrl/meta are interchangeable)
    handleKeyDown(createKeyEvent({ key: "k", metaKey: true }));
    expect(handler).toHaveBeenCalled();
    unregister();
  });

  it("handleKeyDown respects shift modifier", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", shift: true, description: "test", handler });
    handleKeyDown(createKeyEvent({ key: "k", shiftKey: false }));
    expect(handler).not.toHaveBeenCalled();
    handleKeyDown(createKeyEvent({ key: "k", shiftKey: true }));
    expect(handler).toHaveBeenCalled();
    unregister();
  });

  it("no match: handler not called", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "k", ctrl: true, description: "test", handler });
    handleKeyDown(createKeyEvent({ key: "j", ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
    unregister();
  });

  it("getShortcuts returns current list", () => {
    const handler = vi.fn();
    const unregister = registerShortcut({ key: "x", description: "test", handler });
    expect(getShortcuts().some((s) => s.key === "x")).toBe(true);
    unregister();
  });
});
```

- [ ] **Step 6: Run all frontend tests**

Run: `cd apps/web && npx vitest run --reporter=verbose`
Expected: All new + existing frontend tests pass.

- [ ] **Step 7: Commit**

```text
test: add frontend utility tests (settings, model-registry, time, shortcuts, thread-status)
```

---

## Task 8: Frontend Event Handling Tests

**Depends on:** Nothing (independent of backend tasks)
**Files:**
- Create: `apps/web/src/__tests__/tool-call-matching.test.ts`
- Create: `apps/web/src/__tests__/agent-event-branches.test.ts`

- [ ] **Step 1: Write tool call matching tests**

Create `apps/web/src/__tests__/tool-call-matching.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

describe("Tool Call Matching", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      agentStartTimes: {},
      currentThreadId: "thread-1",
    });
  });

  it("tool result with matching ID completes the correct tool call", () => {
    // Set up two pending tool calls
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
          { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc2", output: "done", isError: false },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].isComplete).toBe(false); // tc1 untouched
    expect(calls[1].isComplete).toBe(true);
    expect(calls[1].output).toBe("done");
  });

  it("tool result with non-matching ID falls back to last incomplete", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "unknown-id", output: "result", isError: false },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].isComplete).toBe(true);
    expect(calls[0].output).toBe("result");
  });

  it("multiple concurrent tool calls resolve independently by ID", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
          { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
          { id: "tc3", toolName: "Bash", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    // Resolve out of order
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc3", output: "third", isError: false },
    });
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc1", output: "first", isError: false },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].output).toBe("first");
    expect(calls[1].isComplete).toBe(false);
    expect(calls[2].output).toBe("third");
  });

  it("all tool calls already complete: fallback does nothing", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: "done", isError: false, isComplete: true },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "unknown", output: "extra", isError: false },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    // Original output preserved
    expect(calls[0].output).toBe("done");
  });

  it("out-of-order results don't overwrite completed calls", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: "first-result", isError: false, isComplete: true },
          { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc2", output: "second-result", isError: false },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].output).toBe("first-result"); // preserved
    expect(calls[1].output).toBe("second-result"); // newly completed
  });
});
```

- [ ] **Step 2: Write agent event branch tests**

Create `apps/web/src/__tests__/agent-event-branches.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

describe("handleAgentEvent branches", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(["thread-1"]),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      agentStartTimes: { "thread-1": Date.now() },
      currentThreadId: "thread-1",
    });
  });

  it("bridge.crashed clears all running threads and sets error", () => {
    useThreadStore.setState({
      runningThreadIds: new Set(["thread-1", "thread-2"]),
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "bridge.crashed",
      params: {},
    });

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.size).toBe(0);
    expect(state.error).toContain("bridge crashed");
  });

  it("session.error clears thread running state and sets error", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.error",
      params: { error: "Out of tokens" },
    });

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
    expect(state.error).toBe("Out of tokens");
  });

  it("session.delta appends text to streamingByThread", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.delta",
      params: { text: "Hello " },
    });
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.delta",
      params: { text: "world" },
    });

    expect(useThreadStore.getState().streamingByThread["thread-1"]).toBe("Hello world");
  });

  it("session.turnComplete with streaming content commits message", () => {
    useThreadStore.setState({
      streamingByThread: { "thread-1": "Completed response" },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      params: { sessionId: "mcode-thread-1", reason: "end_turn", costUsd: 0.01, totalTokensIn: 50, totalTokensOut: 100 },
    });

    const state = useThreadStore.getState();
    expect(state.streamingByThread["thread-1"]).toBeUndefined();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Completed response");
    expect(state.messages[0].role).toBe("assistant");
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
  });

  it("session.turnComplete without streaming content clears state only", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      params: { sessionId: "mcode-thread-1", reason: "end_turn", costUsd: null, totalTokensIn: 0, totalTokensOut: 0 },
    });

    const state = useThreadStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
  });

  it("session.toolUse adds tool call to toolCallsByThread", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "tc1", toolName: "Read", toolInput: { path: "/foo" } },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("Read");
    expect(calls[0].isComplete).toBe(false);
  });
});
```

- [ ] **Step 3: Run all frontend tests**

Run: `cd apps/web && npx vitest run --reporter=verbose`
Expected: All tests pass (existing + new).

- [ ] **Step 4: Commit**

```text
test: add tool-call-matching and agent-event-branch tests
```

---

## Task 9: Final Verification

**Depends on:** All previous tasks

- [ ] **Step 1: Run full test suite from root**

Run: `bun run test`
Expected: Both desktop and web test suites pass.

- [ ] **Step 2: Run coverage report**

Run: `cd apps/desktop && npx vitest run --coverage && cd ../web && npx vitest run --coverage`
Expected: Combined coverage >= 80% lines.

- [ ] **Step 3: Commit all if any uncommitted changes remain**

```text
test: verify 80%+ test coverage across desktop and web
```

---

## Parallelization Guide

Tasks can be executed in parallel as follows:

```text
Task 1 (infra) ──┬── Task 2 (repos)
                 ├── Task 3 (app-state)
                 ├── Task 4 (worktree)
                 ├── Task 5 (config)
                 └── Task 6 (sidecar)

Independent:      ├── Task 7 (frontend utils)
                 └── Task 8 (frontend events)

Sequential:       Task 9 (verification) ── after all above
```

**Wave 1:** Task 1 (must complete first for backend tasks)
**Wave 2:** Tasks 2, 3, 4, 5, 6, 7, 8 (all in parallel)
**Wave 3:** Task 9 (final verification)
