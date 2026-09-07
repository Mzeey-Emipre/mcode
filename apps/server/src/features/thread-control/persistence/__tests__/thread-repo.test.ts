import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { container } from "tsyringe";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo, MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS } from "../thread-repo.js";
import { TurnSnapshotRepo } from "../../../agents/turns/persistence/turn-snapshot-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";

describe("ThreadRepo has_file_changes", () => {
  let db: Database;
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

describe("ThreadRepo worktree path cleanup ownership", () => {
  it("rejects worktree path changes after cleanup owns a thread", () => {
    const db = openMemoryDatabase();
    const workspace = new WorkspaceRepo(db).create("cleanup", "/tmp/cleanup", true);
    const threadRepo = new ThreadRepo(db);
    const deletedThread = threadRepo.create(workspace.id, "deleted", "worktree", "feature/deleted");
    const runningThread = threadRepo.create(workspace.id, "running", "worktree", "feature/running");
    const deletedPath = "/tmp/worktrees/deleted";
    const runningPath = "/tmp/worktrees/running";

    expect(threadRepo.updateWorktreePath(deletedThread.id, deletedPath)).toBe(true);
    expect(threadRepo.updateWorktreePath(runningThread.id, runningPath)).toBe(true);
    threadRepo.softDelete(deletedThread.id);
    db.prepare("UPDATE threads SET cleanup_state = 'running' WHERE id = ?").run(runningThread.id);

    expect(threadRepo.updateWorktreePath(deletedThread.id, "/tmp/worktrees/new-deleted")).toBe(false);
    expect(threadRepo.clearWorktreePath(deletedThread.id)).toBe(false);
    expect(threadRepo.updateWorktreePath(runningThread.id, "/tmp/worktrees/new-running")).toBe(false);
    expect(threadRepo.clearWorktreePath(runningThread.id)).toBe(false);
    expect(threadRepo.findById(deletedThread.id)?.worktree_path).toBe(deletedPath);
    expect(threadRepo.findById(runningThread.id)?.worktree_path).toBe(runningPath);
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

describe("ThreadRepo canonical child retention", () => {
  it("preserves active user-visible descendants but deletes active canonical children", () => {
    const db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const workspace = workspaceRepo.create("active-child-retention", "/tmp/active-child-retention", false);
    const parent = threadRepo.create(workspace.id, "parent", "direct", "main");
    const userVisibleChild = threadRepo.create(workspace.id, "user-visible child", "direct", "main");
    const canonicalChild = threadRepo.create(workspace.id, "Sub-agent", "direct", "main");
    db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id IN (?, ?)")
      .run(parent.id, userVisibleChild.id, canonicalChild.id);
    const now = new Date().toISOString();
    const insertCanonicalThread = db.prepare(`
      INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'codex', '[]', 'Idle', 1, 0, ?, ?)
    `);
    insertCanonicalThread.run(parent.id, workspace.id, null, parent.id, null, now, now);
    insertCanonicalThread.run(
      canonicalChild.id,
      workspace.id,
      parent.id,
      parent.id,
      parent.id,
      now,
      now,
    );
    db.prepare(`
      INSERT INTO canonical_agent_turns (
        id, thread_id, execution_id, status, trigger_json, permission_mode,
        provider_identities_json, started_at, ended_at, created_at, updated_at
      ) VALUES ('active-child-turn', ?, 'child-execution', 'Completed', '{"kind":"child"}', 'full', '[]', ?, ?, ?, ?)
    `).run(canonicalChild.id, now, now, now, now);
    db.prepare(`
      INSERT INTO canonical_agent_items (
        id, thread_id, turn_id, kind, provider_identities_json, payload_json, created_at, updated_at
      ) VALUES ('active-child-item', ?, 'active-child-turn', 'message', '[]', '{"projection":"message"}', ?, ?)
    `).run(canonicalChild.id, now, now);
    db.prepare(`
      INSERT INTO canonical_collaboration_actions (
        id, kind, source_thread_id, source_turn_id, source_item_id, target_thread_id,
        status, delivery_unknown, provider_identities_json, created_at, updated_at
      ) VALUES ('active-child-action', 'delegate', ?, 'parent-turn', 'parent-item', ?, 'Dispatched', 0, '[]', ?, ?)
    `).run(parent.id, canonicalChild.id, now, now);

    expect(threadRepo.hardDelete(parent.id, { preserveActiveDescendants: true })).toBe(true);
    expect(threadRepo.findById(userVisibleChild.id)).toMatchObject({
      parent_thread_id: null,
      forked_from_message_id: null,
    });
    expect(threadRepo.findById(canonicalChild.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE id = 'active-child-turn'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = 'active-child-item'").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("hard-deletes canonical descendants and their collaboration records with the parent", () => {
    const db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const workspace = workspaceRepo.create("child-retention", "/tmp/child-retention", false);
    const parent = threadRepo.create(workspace.id, "parent", "direct", "main");
    const child = threadRepo.create(workspace.id, "child", "direct", "main");
    db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run(parent.id, child.id);
    const now = new Date().toISOString();
    const insertCanonicalThread = db.prepare(`
      INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'codex', '[]', 'Idle', 1, 1, ?, ?)
    `);
    insertCanonicalThread.run(parent.id, workspace.id, null, parent.id, null, now, now);
    insertCanonicalThread.run(child.id, workspace.id, parent.id, parent.id, parent.id, now, now);
    db.prepare(`
      INSERT INTO canonical_agent_turns (
        id, thread_id, execution_id, status, trigger_json, permission_mode,
        provider_identities_json, started_at, ended_at, created_at, updated_at
      ) VALUES ('child-turn', ?, 'child-execution', 'Completed', '{"kind":"child"}', 'full', '[]', ?, ?, ?, ?)
    `).run(child.id, now, now, now, now);
    db.prepare(`
      INSERT INTO canonical_agent_items (
        id, thread_id, turn_id, kind, provider_identities_json, payload_json, created_at, updated_at
      ) VALUES ('child-item', ?, 'child-turn', 'message', '[]', '{"projection":"message"}', ?, ?)
    `).run(child.id, now, now);
    db.prepare(`
      INSERT INTO canonical_collaboration_actions (
        id, kind, source_thread_id, source_turn_id, source_item_id, target_thread_id,
        status, delivery_unknown, provider_identities_json, created_at, updated_at
      ) VALUES ('child-action', 'delegate', ?, 'child-turn', 'child-item', ?, 'Acknowledged', 0, '[]', ?, ?)
    `).run(parent.id, child.id, now, now);

    expect(threadRepo.hardDelete(parent.id)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_threads WHERE id = ?").get(child.id))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE id = 'child-turn'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = 'child-item'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_collaboration_actions WHERE id = 'child-action'").get())
      .toEqual({ count: 0 });
    expect(threadRepo.findById(child.id)).toBeNull();
    db.close();
  });

  it("hard-deletes retained legacy descendants and their message history with the parent", () => {
    // Regression: retained legacy children have no canonical row, but remain owned by the parent.
    const db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const workspace = workspaceRepo.create("legacy-child-delete", "/tmp/legacy-child-delete", false);
    const parent = threadRepo.create(workspace.id, "parent", "direct", "main");
    const child = threadRepo.create(workspace.id, "legacy child", "direct", "main");
    db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run(parent.id, child.id);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("legacy-child-message", child.id, "assistant", "retained legacy history", now, 1);
    db.prepare(
      "INSERT INTO turn_snapshots (id, message_id, thread_id, ref_before, ref_after, files_changed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("legacy-child-snapshot", "legacy-child-message", child.id, "before", "after", "[]", now);

    expect(threadRepo.hardDelete(parent.id)).toBe(true);
    expect(threadRepo.findById(child.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get("legacy-child-message"))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM turn_snapshots WHERE id = ?").get("legacy-child-snapshot"))
      .toEqual({ count: 0 });
    db.close();
  });

  it("soft-deletes a parent without removing normal or canonical child history", () => {
    const db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const workspace = workspaceRepo.create("child-archive", "/tmp/child-archive", false);
    const parent = threadRepo.create(workspace.id, "parent", "direct", "main");
    const child = threadRepo.create(workspace.id, "child", "direct", "main");
    db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run(parent.id, child.id);
    const now = new Date().toISOString();
    const insertCanonicalThread = db.prepare(`
      INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'codex', '[]', 'Idle', 1, 0, ?, ?)
    `);
    insertCanonicalThread.run(parent.id, workspace.id, null, parent.id, null, now, now);
    insertCanonicalThread.run(child.id, workspace.id, parent.id, parent.id, parent.id, now, now);
    db.prepare(`
      INSERT INTO canonical_agent_turns (
        id, thread_id, execution_id, status, trigger_json, permission_mode,
        provider_identities_json, started_at, ended_at, created_at, updated_at
      ) VALUES ('archived-child-turn', ?, 'archived-child-execution', 'Completed', '{"kind":"child"}', 'full', '[]', ?, ?, ?, ?)
    `).run(child.id, now, now, now, now);
    db.prepare(`
      INSERT INTO canonical_agent_items (
        id, thread_id, turn_id, kind, provider_identities_json, payload_json, created_at, updated_at
      ) VALUES ('archived-child-item', ?, 'archived-child-turn', 'message', '[]', '{"projection":"message"}', ?, ?)
    `).run(child.id, now, now);

    expect(threadRepo.softDelete(parent.id)).toBe(true);
    expect(threadRepo.findById(child.id)).not.toBeNull();
    expect(db.prepare("SELECT status, deleted_at FROM threads WHERE id = ?").get(parent.id))
      .toMatchObject({ status: "deleted" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE thread_id = ?")
      .get(child.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_threads WHERE id = ?")
      .get(child.id)).toEqual({ count: 1 });
    db.close();
  });

  it("hard-deletes every nested descendant across bounded child batches", () => {
    // Regression: a bounded delete must not leave descendants beyond its batch or at a nested depth.
    const db = openMemoryDatabase();
    const workspaceRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const workspace = workspaceRepo.create("child-delete-batches", "/tmp/child-delete-batches", false);
    const parent = threadRepo.create(workspace.id, "parent", "direct", "main");
    const now = new Date().toISOString();
    const insertCanonicalThread = db.prepare(`
      INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'codex', '[]', 'Idle', 1, 0, ?, ?)
    `);
    insertCanonicalThread.run(parent.id, workspace.id, null, parent.id, null, now, now);
    for (let index = 0; index < 70; index += 1) {
      const child = threadRepo.create(workspace.id, `child-${index}`, "direct", "main");
      db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run(parent.id, child.id);
      insertCanonicalThread.run(child.id, workspace.id, parent.id, parent.id, parent.id, now, now);
      if (index < 3) {
        const grandchild = threadRepo.create(workspace.id, `grandchild-${index}`, "direct", "main");
        db.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run(child.id, grandchild.id);
        insertCanonicalThread.run(grandchild.id, workspace.id, child.id, parent.id, parent.id, now, now);
      }
    }

    expect(threadRepo.hardDelete(parent.id)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM threads WHERE workspace_id = ?").get(workspace.id))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_threads WHERE workspace_id = ?")
      .get(workspace.id)).toEqual({ count: 0 });
    db.close();
  });
});

describe("ThreadRepo.search", () => {
  let db: Database;
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

  it("filters search results to the owning external integration", () => {
    const workspace = workspaceRepo.create("owned", "/src/owned", true);
    const owned = threadRepo.create(workspace.id, "Owned", "direct", "main");
    const otherOwned = threadRepo.create(workspace.id, "Other", "direct", "main");
    const unowned = threadRepo.create(workspace.id, "Unowned", "direct", "main");
    threadRepo.updateExternalCreator(owned.id, "integration-a");
    threadRepo.updateExternalCreator(otherOwned.id, "integration-b");

    expect(threadRepo.search({ query: "", createdByIntegrationId: "integration-a" }).threads.map((item) => item.id)).toEqual([
      owned.id,
    ]);
    expect(threadRepo.findById(owned.id, { createdByIntegrationId: "integration-b" })).toBeNull();
    expect(threadRepo.findById(unowned.id, { createdByIntegrationId: "integration-a" })).toBeNull();
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
