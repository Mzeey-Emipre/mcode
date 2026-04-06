import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryDatabase } from "../store/database.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import type Database from "better-sqlite3";

describe("ThreadRepo.updateSettings", () => {
  let db: Database.Database;
  let repo: ThreadRepo;
  let threadId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ThreadRepo(db);
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");
    const thread = repo.create("ws-1", "test thread", "direct", "main");
    threadId = thread.id;
  });

  it("persists reasoning_level, interaction_mode, and permission_mode", () => {
    const ok = repo.updateSettings(threadId, {
      reasoning_level: "high",
      interaction_mode: "plan",
      permission_mode: "supervised",
    });
    expect(ok).toBe(true);

    const thread = repo.findById(threadId);
    expect(thread?.reasoning_level).toBe("high");
    expect(thread?.interaction_mode).toBe("plan");
    expect(thread?.permission_mode).toBe("supervised");
  });

  it("allows partial updates (only reasoning_level)", () => {
    repo.updateSettings(threadId, { reasoning_level: "max" });
    const thread = repo.findById(threadId);
    expect(thread?.reasoning_level).toBe("max");
    expect(thread?.interaction_mode).toBeNull();
    expect(thread?.permission_mode).toBeNull();
  });

  it("returns false for nonexistent thread", () => {
    const ok = repo.updateSettings("nonexistent", { reasoning_level: "low" });
    expect(ok).toBe(false);
  });

  it("new threads have null settings columns by default", () => {
    const thread = repo.findById(threadId);
    expect(thread?.reasoning_level).toBeNull();
    expect(thread?.interaction_mode).toBeNull();
    expect(thread?.permission_mode).toBeNull();
  });
});
