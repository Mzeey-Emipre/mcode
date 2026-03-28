import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { ToolCallRecordRepo } from "../repositories/tool-call-record-repo";
import type { CreateToolCallRecordInput } from "../repositories/tool-call-record-repo";

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

describe("V7 migration", () => {
  it("creates tool_call_records and turn_snapshots tables", () => {
    const db = openMemoryDatabase();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tool_call_records', 'turn_snapshots') ORDER BY name",
      )
      .all() as { name: string }[];

    expect(tables).toHaveLength(2);
    expect(tables[0]!.name).toBe("tool_call_records");
    expect(tables[1]!.name).toBe("turn_snapshots");

    db.close();
  });
});

describe("ToolCallRecordRepo", () => {
  let db: Database.Database;
  let repo: ToolCallRecordRepo;
  let messageId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ToolCallRecordRepo(db);
    const fixtures = seedFixtures(db);
    messageId = fixtures.messageId;
  });

  it("creates and retrieves a tool call record", () => {
    const input: CreateToolCallRecordInput = {
      messageId,
      toolName: "Read",
      inputSummary: "file.ts",
      outputSummary: "200 lines",
      status: "completed",
      sortOrder: 0,
    };

    const record = repo.create(input);

    expect(record.id).toBeDefined();
    expect(record.message_id).toBe(messageId);
    expect(record.tool_name).toBe("Read");
    expect(record.input_summary).toBe("file.ts");
    expect(record.output_summary).toBe("200 lines");
    expect(record.status).toBe("completed");
    expect(record.sort_order).toBe(0);
    expect(record.parent_tool_call_id).toBeNull();
    expect(record.completed_at).toBeDefined();

    const records = repo.listByMessage(messageId);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(record.id);
  });

  it("bulkCreate inserts multiple records in a transaction", () => {
    const inputs: CreateToolCallRecordInput[] = [
      {
        messageId,
        toolName: "Read",
        inputSummary: "a.ts",
        outputSummary: "",
        status: "completed",
        sortOrder: 0,
      },
      {
        messageId,
        toolName: "Edit",
        inputSummary: "b.ts",
        outputSummary: "",
        status: "running",
        sortOrder: 1,
      },
      {
        messageId,
        toolName: "Bash",
        inputSummary: "ls",
        outputSummary: "",
        status: "failed",
        sortOrder: 2,
      },
    ];

    repo.bulkCreate(inputs);

    const records = repo.listByMessage(messageId);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.tool_name)).toEqual(["Read", "Edit", "Bash"]);
  });

  it("supports parent nesting via listByParent", () => {
    const parent = repo.create({
      messageId,
      toolName: "Agent",
      inputSummary: "subagent",
      outputSummary: "",
      status: "running",
      sortOrder: 0,
    });

    const child1 = repo.create({
      messageId,
      toolName: "Read",
      inputSummary: "file.ts",
      outputSummary: "",
      status: "completed",
      sortOrder: 0,
      parentToolCallId: parent.id,
    });

    const child2 = repo.create({
      messageId,
      toolName: "Edit",
      inputSummary: "file.ts",
      outputSummary: "",
      status: "completed",
      sortOrder: 1,
      parentToolCallId: parent.id,
    });

    const children = repo.listByParent(parent.id);
    expect(children).toHaveLength(2);
    expect(children[0]!.id).toBe(child1.id);
    expect(children[1]!.id).toBe(child2.id);
    expect(children[0]!.parent_tool_call_id).toBe(parent.id);
  });

  it("countByMessage returns the correct count", () => {
    expect(repo.countByMessage(messageId)).toBe(0);

    repo.create({
      messageId,
      toolName: "Read",
      inputSummary: "",
      outputSummary: "",
      status: "completed",
      sortOrder: 0,
    });
    repo.create({
      messageId,
      toolName: "Edit",
      inputSummary: "",
      outputSummary: "",
      status: "completed",
      sortOrder: 1,
    });

    expect(repo.countByMessage(messageId)).toBe(2);
  });

  it("cascade deletes records when message is deleted", () => {
    repo.create({
      messageId,
      toolName: "Read",
      inputSummary: "",
      outputSummary: "",
      status: "completed",
      sortOrder: 0,
    });

    expect(repo.countByMessage(messageId)).toBe(1);

    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);

    expect(repo.countByMessage(messageId)).toBe(0);
  });
});
