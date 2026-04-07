import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { openMemoryDatabase } from "../store/database.js";

describe("V014 migration - thread lineage columns", () => {
  it("adds parent_thread_id and forked_from_message_id columns", () => {
    const db = openMemoryDatabase();
    const info = db.pragma("table_info(threads)") as Array<{ name: string }>;
    const columnNames = info.map((col) => col.name);
    expect(columnNames).toContain("parent_thread_id");
    expect(columnNames).toContain("forked_from_message_id");
  });

  it("defaults lineage columns to NULL for existing rows", () => {
    const db = openMemoryDatabase();
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run("ws-1", "test", "/tmp/test");
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, status, mode, branch, worktree_managed, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t-1", "ws-1", "test", "active", "direct", "main", 1, "claude", new Date().toISOString(), new Date().toISOString());

    const row = db.prepare("SELECT parent_thread_id, forked_from_message_id FROM threads WHERE id = ?").get("t-1") as Record<string, unknown>;
    expect(row.parent_thread_id).toBeNull();
    expect(row.forked_from_message_id).toBeNull();
  });
});
