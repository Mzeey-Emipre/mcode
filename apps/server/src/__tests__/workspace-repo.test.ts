import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { WorkspaceService } from "../services/workspace-service";

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
