import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryDatabase } from "../store/database.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import type Database from "better-sqlite3";

describe("ThreadRepo lineage", () => {
  let db: Database.Database;
  let repo: ThreadRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ThreadRepo(db);
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");
  });

  it("creates a thread without lineage by default", () => {
    const thread = repo.create("ws-1", "root thread", "direct", "main");
    expect(thread.parent_thread_id).toBeNull();
    expect(thread.forked_from_message_id).toBeNull();
  });

  it("creates a thread with lineage fields", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    const child = repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-123",
    });
    expect(child.parent_thread_id).toBe(parent.id);
    expect(child.forked_from_message_id).toBe("msg-123");
  });

  it("persists and reads back lineage fields", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    const child = repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-456",
    });
    const found = repo.findById(child.id);
    expect(found?.parent_thread_id).toBe(parent.id);
    expect(found?.forked_from_message_id).toBe("msg-456");
  });

  it("lists threads including lineage fields", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-789",
    });
    const threads = repo.listByWorkspace("ws-1");
    const child = threads.find((t) => t.title === "child");
    expect(child?.parent_thread_id).toBe(parent.id);
  });

  it("soft-deleting parent does not delete child", () => {
    const parent = repo.create("ws-1", "parent", "direct", "main");
    const child = repo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-abc",
    });
    repo.softDelete(parent.id);
    const found = repo.findById(child.id);
    expect(found).not.toBeNull();
    expect(found?.parent_thread_id).toBe(parent.id);
  });

  it("updateLineage sets lineage on existing thread", () => {
    const thread = repo.create("ws-1", "existing", "direct", "main");
    expect(thread.parent_thread_id).toBeNull();

    const updated = repo.updateLineage(thread.id, "parent-id", "msg-999");
    expect(updated).toBe(true);

    const found = repo.findById(thread.id);
    expect(found?.parent_thread_id).toBe("parent-id");
    expect(found?.forked_from_message_id).toBe("msg-999");
  });
});
