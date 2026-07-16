import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../store/database.js";
import { ThreadRepo, MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS } from "../thread-repo.js";
import { TurnSnapshotRepo } from "../turn-snapshot-repo.js";
import { WorkspaceRepo } from "../workspace-repo.js";

describe("ThreadRepo has_file_changes", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    threadRepo = container.resolve(ThreadRepo);
    const workspaceRepo = container.resolve(WorkspaceRepo);
    const ws = workspaceRepo.create("test-ws", "/tmp/ws", false);
    workspaceId = ws.id;
  });

  it("creates a thread with has_file_changes = false by default", () => {
    const t = threadRepo.create(workspaceId, "t", "direct", "main");
    expect(t.has_file_changes).toBe(false);
    const reloaded = threadRepo.findById(t.id);
    expect(reloaded?.has_file_changes).toBe(false);
  });

  it("rowToThread coerces 1 to true and 0 to false", () => {
    const t = threadRepo.create(workspaceId, "t", "direct", "main");
    db.prepare("UPDATE threads SET has_file_changes = 1 WHERE id = ?").run(t.id);
    const reloaded = threadRepo.findById(t.id);
    expect(reloaded?.has_file_changes).toBe(true);

    db.prepare("UPDATE threads SET has_file_changes = 0 WHERE id = ?").run(t.id);
    const reloaded2 = threadRepo.findById(t.id);
    expect(reloaded2?.has_file_changes).toBe(false);
  });
});

describe("ThreadRepo active worktree ownership paths", () => {
  it("caps retained sibling paths and reports truncation", () => {
    const db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const workspace = workspaceRepo.create("bounded", "/tmp/bounded", true);
    const source = threadRepo.create(
      workspace.id,
      "source",
      "worktree",
      "feature/source",
    );
    threadRepo.updateWorktreePath(source.id, "/tmp/worktrees/source");
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 0, ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index <= MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS; index++) {
        insert.run(
          `sibling-${index}`,
          workspace.id,
          `Sibling ${index}`,
          `feature/${index}`,
          `/tmp/worktrees/${index}`,
          now,
          now,
        );
      }
    })();

    const paths = threadRepo.listActiveSiblingWorktreePaths(source.id);

    expect(paths.paths).toHaveLength(MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS);
    expect(paths.truncated).toBe(true);
    db.close();
  });
});

describe("ThreadRepo.updateCheckoutToNamedBranch", () => {
  let threadRepo: ThreadRepo;
  let workspaceId: string;

  beforeEach(() => {
    const db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    threadRepo = container.resolve(ThreadRepo);
    const workspaceRepo = container.resolve(WorkspaceRepo);
    const ws = workspaceRepo.create("test-ws", "/tmp/ws", false);
    workspaceId = ws.id;
  });

  it("preserves base_branch when a branchless checkout becomes a named branch", () => {
    const thread = threadRepo.create(
      workspaceId,
      "branchless",
      "worktree",
      "release",
      true,
      "claude",
      undefined,
      "branchless",
      "release",
    );

    const updated = threadRepo.updateCheckoutToNamedBranch(thread.id, "feat/named");

    expect(updated?.checkout_state).toBe("named");
    expect(updated?.branch).toBe("feat/named");
    expect(updated?.base_branch).toBe("release");
    expect(threadRepo.findById(thread.id)?.base_branch).toBe("release");
  });
});

describe("ThreadRepo.updateCheckoutFromHead", () => {
  let threadRepo: ThreadRepo;
  let workspaceId: string;

  beforeEach(() => {
    const db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    threadRepo = container.resolve(ThreadRepo);
    const workspaceRepo = container.resolve(WorkspaceRepo);
    const ws = workspaceRepo.create("test-ws", "/tmp/ws", false);
    workspaceId = ws.id;
  });

  it("promotes a branchless checkout to a named branch, preserves base_branch, and clears stale PR metadata", () => {
    const thread = threadRepo.create(workspaceId, "t", "worktree", "release", true, "claude", undefined, "branchless", "release");
    threadRepo.updatePr(thread.id, 12, "OPEN");

    const result = threadRepo.updateCheckoutFromHead(thread.id, "feat/new", "named", null);

    expect(result?.changed).toBe(true);
    expect(result?.thread).toMatchObject({
      branch: "feat/new",
      checkout_state: "named",
      base_branch: "release",
      pr_number: null,
      pr_status: null,
    });
  });

  it("updates a named checkout to another named branch", () => {
    const thread = threadRepo.create(workspaceId, "t", "worktree", "feat/old");

    const result = threadRepo.updateCheckoutFromHead(thread.id, "feat/new", "named", null);

    expect(result?.changed).toBe(true);
    expect(result?.thread.branch).toBe("feat/new");
    expect(result?.thread.checkout_state).toBe("named");
  });

  it("updates a named checkout to detached HEAD with previous branch as base", () => {
    const thread = threadRepo.create(workspaceId, "t", "worktree", "feat/base");

    const result = threadRepo.updateCheckoutFromHead(thread.id, "HEAD", "branchless", "feat/base");

    expect(result?.changed).toBe(true);
    expect(result?.thread).toMatchObject({
      branch: "HEAD",
      checkout_state: "branchless",
      base_branch: "feat/base",
    });
  });

  it("does not clear PR metadata when checkout branch and state are unchanged", () => {
    const thread = threadRepo.create(workspaceId, "t", "worktree", "feat/same");
    threadRepo.updatePr(thread.id, 34, "OPEN");

    const result = threadRepo.updateCheckoutFromHead(thread.id, "feat/same", "named", null);

    expect(result?.changed).toBe(false);
    expect(result?.thread.pr_number).toBe(34);
    expect(result?.thread.pr_status).toBe("OPEN");
  });
});

describe("ThreadRepo.search", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    threadRepo = container.resolve(ThreadRepo);
    workspaceRepo = container.resolve(WorkspaceRepo);
  });

  it.each([
    ["title", "audit cache"],
    ["project name", "Caravan"],
    ["project path", "client-app"],
    ["provider", "codex"],
    ["branch", "sidebar-polish"],
    ["worktree path", "quiet-lantern"],
  ])("matches a term present only in %s", (_field, query) => {
    const workspace = workspaceRepo.create("Caravan", "/src/client-app", true);
    const thread = threadRepo.create(
      workspace.id,
      "Audit cache",
      "worktree",
      "feature/sidebar-polish",
      true,
      "codex",
    );
    threadRepo.updateWorktreePath(thread.id, "/worktrees/quiet-lantern");

    expect(threadRepo.search({ query }).threads.map((item) => item.id)).toEqual([thread.id]);
  });

  it("treats SQL wildcard characters as literal search text", () => {
    const workspace = workspaceRepo.create("percent_100%", "/src/literal", true);
    const matching = threadRepo.create(workspace.id, "Literal marker", "direct", "main");
    const otherWorkspace = workspaceRepo.create("plain", "/src/plain", true);
    threadRepo.create(otherWorkspace.id, "Other", "direct", "main");

    expect(threadRepo.search({ query: "_100%" }).threads.map((item) => item.id)).toEqual([
      matching.id,
    ]);
  });
});

describe("Migration 019 backfill", () => {
  it("backfills has_file_changes = 1 for threads with non-empty file changes in any snapshot", () => {
    const db = openMemoryDatabase();
    container.reset();
    container.registerInstance("Database", db);
    const threadRepo = container.resolve(ThreadRepo);
    const snapshotRepo = container.resolve(TurnSnapshotRepo);
    const workspaceRepo = container.resolve(WorkspaceRepo);
    const ws = workspaceRepo.create("test-ws", "/tmp/ws", false);

    const tWithChanges = threadRepo.create(ws.id, "with", "direct", "main");
    const tEmptySnaps = threadRepo.create(ws.id, "empty", "direct", "main");
    const tNoSnaps = threadRepo.create(ws.id, "none", "direct", "main");

    // Disable FK checks for snapshot inserts: message_id references messages(id)
    // but the test uses fabricated IDs — only the backfill SQL correctness matters here.
    db.pragma("foreign_keys = OFF");
    snapshotRepo.create({
      messageId: "m1",
      threadId: tWithChanges.id,
      refBefore: "abc",
      refAfter: "def",
      filesChanged: ["src/a.ts"],
      worktreePath: null,
    });
    snapshotRepo.create({
      messageId: "m2",
      threadId: tEmptySnaps.id,
      refBefore: "abc",
      refAfter: "def",
      filesChanged: [],
      worktreePath: null,
    });
    db.pragma("foreign_keys = ON");

    // Reset the flag to 0 to simulate pre-migration state, then re-run the backfill SQL.
    db.prepare("UPDATE threads SET has_file_changes = 0").run();
    db.prepare(
      `UPDATE threads
       SET has_file_changes = 1
       WHERE id IN (
         SELECT DISTINCT thread_id
         FROM turn_snapshots
         WHERE json_array_length(files_changed) > 0
       )`,
    ).run();

    expect(threadRepo.findById(tWithChanges.id)?.has_file_changes).toBe(true);
    expect(threadRepo.findById(tEmptySnaps.id)?.has_file_changes).toBe(false);
    expect(threadRepo.findById(tNoSnaps.id)?.has_file_changes).toBe(false);
  });
});
