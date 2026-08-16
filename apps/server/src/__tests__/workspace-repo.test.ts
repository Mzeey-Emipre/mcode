import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { ThreadRepo } from "../repositories/thread-repo";
import { CleanupJobRepo } from "../repositories/cleanup-job-repo";
import { WorkspaceService } from "../services/workspace-service";
import { AttachmentService } from "../services/attachment-service";
import type { AgentService } from "../features/agents/index.js";
import { FakeGitExecutor } from "../services/git-executor/fake-git-executor.js";

describe("WorkspaceRepo", () => {
  let db: Database.Database;
  let repo: WorkspaceRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new WorkspaceRepo(db);
  });

  it("hardDelete() deletes the workspace row", () => {
    const ws = repo.create("test", "/tmp/test");
    expect(repo.findById(ws.id)).not.toBeNull();

    const deleted = repo.hardDelete(ws.id);

    expect(deleted).toBe(true);
    expect(repo.findById(ws.id)).toBeNull();
  });

  it("hardDelete() cascade-deletes associated threads", () => {
    const ws = repo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-1", ws.id, "Thread 1", "main", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-2", ws.id, "Thread 2", "main", now, now);

    repo.hardDelete(ws.id);

    const threads = db
      .prepare("SELECT id FROM threads WHERE workspace_id = ?")
      .all(ws.id) as { id: string }[];
    expect(threads).toHaveLength(0);
  });

  it("hardDelete() cascade-deletes messages through threads", () => {
    const ws = repo.create("test", "/tmp/test");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t-1", ws.id, "Thread", "main", now, now);
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("m-1", "t-1", "user", "hello", now, 1);

    repo.hardDelete(ws.id);

    const messages = db
      .prepare("SELECT id FROM messages WHERE thread_id = ?")
      .all("t-1") as { id: string }[];
    expect(messages).toHaveLength(0);
  });

  it("hardDelete() returns false for non-existent ID", () => {
    expect(repo.hardDelete("non-existent")).toBe(false);
  });

  it("create() allows re-using a path after the previous workspace was deleted", () => {
    const ws1 = repo.create("test", "/tmp/reuse");
    repo.hardDelete(ws1.id);

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
    const threadRepo = new ThreadRepo(db);
    const cleanupJobRepo = new CleanupJobRepo(db);
    const mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    service = new WorkspaceService(
      repo,
      threadRepo,
      cleanupJobRepo,
      mockAttachmentService,
      { stopSession: vi.fn().mockResolvedValue(undefined) } as unknown as AgentService,
      new FakeGitExecutor(),
    );
  });

  it("create() returns existing workspace when path already exists", async () => {
    const ws1 = await service.create("project-a", "/tmp/existing");
    await service.create("other", "/tmp/other");

    const ws2 = await service.create("project-a-renamed", "/tmp/existing");

    expect(ws2.id).toBe(ws1.id);
    expect(ws2.name).toBe("project-a");
    expect(repo.listAll()[0]!.id).toBe(ws1.id);
  });

  it("create() creates a new workspace when path does not exist", async () => {
    const ws = await service.create("new-project", "/tmp/new");
    expect(ws.name).toBe("new-project");
    expect(ws.path).toBe("/tmp/new");
  });
});
