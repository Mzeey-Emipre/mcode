import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { HookExecutionRepo } from "../hook-execution-repo.js";

function seedFixtures(db: Database.Database): { messageId: string } {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "ws-1", "Test thread", "main", now, now);
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("msg-1", "thread-1", "assistant", "hello", now, 1);
  return { messageId: "msg-1" };
}

describe("HookExecutionRepo", () => {
  let db: Database.Database;
  let repo: HookExecutionRepo;
  let messageId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new HookExecutionRepo(db);
    ({ messageId } = seedFixtures(db));
  });

  it("create then listByMessage round-trips a hook with all fields", () => {
    repo.create({
      id: "hk-1",
      messageId,
      hookName: "PreToolUse",
      toolName: "Bash",
      phase: "pre",
      payload: JSON.stringify({ command: "ls" }),
      durationMs: 12,
      didBlock: false,
      startedAt: "2026-05-15T10:00:00Z",
      endedAt: "2026-05-15T10:00:00.012Z",
      sortOrder: 3,
    });
    const out = repo.listByMessage(messageId);
    expect(out).toHaveLength(1);
    expect(out[0]!.hook_name).toBe("PreToolUse");
    expect(out[0]!.tool_name).toBe("Bash");
    expect(out[0]!.did_block).toBe(false);
    expect(out[0]!.duration_ms).toBe(12);
  });

  it("didBlock=true round-trips as true (not 1)", () => {
    repo.create({
      id: "hk-2",
      messageId,
      hookName: "Stop",
      toolName: null,
      phase: "post",
      payload: "{}",
      durationMs: null,
      didBlock: true,
      startedAt: "2026-05-15T10:00:00Z",
      endedAt: null,
      sortOrder: 4,
    });
    const out = repo.listByMessage(messageId);
    expect(out[0]!.did_block).toBe(true);
    expect(out[0]!.tool_name).toBeNull();
    expect(out[0]!.duration_ms).toBeNull();
  });

  it("bulkCreate orders by sort_order ascending", () => {
    repo.bulkCreate([
      { id: "h-b", messageId, hookName: "B", toolName: null, phase: "pre", payload: "{}", durationMs: null, didBlock: false, startedAt: "2026-05-15T10:00:00Z", endedAt: null, sortOrder: 2 },
      { id: "h-a", messageId, hookName: "A", toolName: null, phase: "pre", payload: "{}", durationMs: null, didBlock: false, startedAt: "2026-05-15T10:00:00Z", endedAt: null, sortOrder: 1 },
    ]);
    const out = repo.listByMessage(messageId);
    expect(out.map((r) => r.hook_name)).toEqual(["A", "B"]);
  });
});
