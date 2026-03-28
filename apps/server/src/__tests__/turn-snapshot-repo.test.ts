import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import type { CreateTurnSnapshotInput } from "../repositories/turn-snapshot-repo";

/** Seed a workspace, thread, and message so foreign keys are satisfied. */
function seedFixtures(db: Database.Database): {
  workspaceId: string;
  threadId: string;
  messageId: string;
} {
  const workspaceId = "ws-1";
  const threadId = "thread-1";
  const messageId = "msg-1";
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(workspaceId, "Test", "/tmp/test", now, now);

  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(threadId, workspaceId, "Test thread", "main", now, now);

  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(messageId, threadId, "assistant", "hello", now, 1);

  return { workspaceId, threadId, messageId };
}

describe("TurnSnapshotRepo", () => {
  let db: Database.Database;
  let repo: TurnSnapshotRepo;
  let threadId: string;
  let messageId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new TurnSnapshotRepo(db);
    const fixtures = seedFixtures(db);
    threadId = fixtures.threadId;
    messageId = fixtures.messageId;
  });

  it("creates and retrieves a snapshot by message", () => {
    const input: CreateTurnSnapshotInput = {
      messageId,
      threadId,
      refBefore: "abc123",
      refAfter: "def456",
      filesChanged: ["src/a.ts", "src/b.ts"],
      worktreePath: "/tmp/worktree",
    };

    const snapshot = repo.create(input);

    expect(snapshot.id).toBeDefined();
    expect(snapshot.message_id).toBe(messageId);
    expect(snapshot.thread_id).toBe(threadId);
    expect(snapshot.ref_before).toBe("abc123");
    expect(snapshot.ref_after).toBe("def456");
    expect(snapshot.files_changed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(snapshot.worktree_path).toBe("/tmp/worktree");

    const retrieved = repo.getByMessage(messageId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(snapshot.id);
    expect(retrieved!.files_changed).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("getById returns the snapshot or null", () => {
    const snapshot = repo.create({
      messageId,
      threadId,
      refBefore: "aaa",
      refAfter: "bbb",
      filesChanged: [],
      worktreePath: null,
    });

    expect(repo.getById(snapshot.id)).not.toBeNull();
    expect(repo.getById("nonexistent")).toBeNull();
  });

  it("listByThread returns snapshots ordered by created_at", () => {
    const now = new Date().toISOString();

    // Create a second message for a second snapshot
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("msg-2", threadId, "assistant", "world", now, 2);

    repo.create({
      messageId,
      threadId,
      refBefore: "a1",
      refAfter: "a2",
      filesChanged: ["x.ts"],
      worktreePath: null,
    });

    repo.create({
      messageId: "msg-2",
      threadId,
      refBefore: "b1",
      refAfter: "b2",
      filesChanged: ["y.ts"],
      worktreePath: null,
    });

    const snapshots = repo.listByThread(threadId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.ref_before).toBe("a1");
    expect(snapshots[1]!.ref_before).toBe("b1");
  });

  it("deleteExpired removes old snapshots", () => {
    // Insert a snapshot with a manually backdated created_at
    const oldDate = "2020-01-01T00:00:00.000Z";
    db.prepare(
      "INSERT INTO turn_snapshots (id, message_id, thread_id, ref_before, ref_after, files_changed, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "old-snap",
      messageId,
      threadId,
      "old1",
      "old2",
      "[]",
      null,
      oldDate,
    );

    // Insert a fresh snapshot via the repo
    repo.create({
      messageId,
      threadId,
      refBefore: "new1",
      refAfter: "new2",
      filesChanged: [],
      worktreePath: null,
    });

    const deleted = repo.deleteExpired(30);
    expect(deleted).toBe(1);

    const remaining = repo.listByThread(threadId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.ref_before).toBe("new1");
  });

  it("cascade deletes snapshots when message is deleted", () => {
    repo.create({
      messageId,
      threadId,
      refBefore: "a",
      refAfter: "b",
      filesChanged: [],
      worktreePath: null,
    });

    expect(repo.getByMessage(messageId)).not.toBeNull();

    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);

    expect(repo.getByMessage(messageId)).toBeNull();
  });
});
