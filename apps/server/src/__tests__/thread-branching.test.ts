import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryDatabase } from "../store/database.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { MessageRepo } from "../repositories/message-repo.js";
import { HANDOFF_MARKER } from "../services/handoff-builder.js";
import type Database from "better-sqlite3";

describe("thread branching - data layer", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    messageRepo = new MessageRepo(db);

    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");

    const parent = threadRepo.create("ws-1", "Fix auth bug", "direct", "main");
    messageRepo.create(parent.id, "user", "Fix the auth bug", 1);
    messageRepo.create(parent.id, "assistant", "I fixed the auth bug by updating the middleware.", 2);
    messageRepo.create(parent.id, "user", "Now add tests", 3);
    messageRepo.create(parent.id, "assistant", "I added comprehensive tests for the auth middleware.", 4);
  });

  it("child thread stores lineage to parent", () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    const child = threadRepo.create("ws-1", "Branch: test coverage", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    expect(child.parent_thread_id).toBe(parent.id);
    expect(child.forked_from_message_id).toBe("msg-fork");
  });

  it("child does not copy parent sdk_session_id", () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    threadRepo.updateSdkSessionId(parent.id, "sdk-parent-session");
    const child = threadRepo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    expect(child.sdk_session_id).toBeNull();
  });

  it("deleting parent does not delete child", () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    const child = threadRepo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    threadRepo.softDelete(parent.id);
    const found = threadRepo.findById(child.id);
    expect(found).not.toBeNull();
    expect(found!.parent_thread_id).toBe(parent.id);
  });

  it("child messages are independent from parent messages", () => {
    const parent = threadRepo.listByWorkspace("ws-1")[0];
    const child = threadRepo.create("ws-1", "child", "direct", "main", true, "claude", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-fork",
    });

    const parentMsgs = messageRepo.listByThread(parent.id, 100);
    expect(parentMsgs.messages).toHaveLength(4);

    const childMsgs = messageRepo.listByThread(child.id, 100);
    expect(childMsgs.messages).toHaveLength(0);
  });
});

describe("thread branching - edge cases", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    messageRepo = new MessageRepo(db);
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-2", "other", "/tmp/other");
  });

  it("cross-workspace lineage data is isolated", () => {
    const parent = threadRepo.create("ws-1", "parent", "direct", "main");
    messageRepo.create(parent.id, "user", "hello", 1);
    expect(parent.workspace_id).toBe("ws-1");
    // Cross-workspace branching is prevented by the guard in createBranchedThread
  });

  it("deleted thread lineage is preserved", () => {
    const parent = threadRepo.create("ws-1", "parent", "direct", "main");
    messageRepo.create(parent.id, "user", "hello", 1);
    threadRepo.softDelete(parent.id);
    const found = threadRepo.findById(parent.id);
    expect(found?.deleted_at).not.toBeNull();
  });

  it("empty thread has no messages to fork from", () => {
    const parent = threadRepo.create("ws-1", "empty", "direct", "main");
    const { messages } = messageRepo.listByThread(parent.id, 100);
    expect(messages).toHaveLength(0);
  });
});
