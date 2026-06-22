import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../store/database.js";
import { ThreadRepo } from "../thread-repo.js";
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
