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
    // Set distinct timestamps to avoid race when both inserts happen in same ms
    db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", ws1.id);
    db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", ws2.id);
    const list = WorkspaceRepo.listAll(db);
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
