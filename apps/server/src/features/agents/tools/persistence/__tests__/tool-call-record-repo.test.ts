import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ToolCallRecordRepo } from "../tool-call-record-repo.js";
import type { CreateToolCallRecordInput } from "../tool-call-record-repo.js";

/** Seed a workspace, thread, and message so foreign keys are satisfied. */
function seedFixtures(db: Database): {
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

  it("adds tool output truncation columns", () => {
    const db = openMemoryDatabase();

    const cols = (
      db.prepare("PRAGMA table_info(tool_call_records)").all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(cols).toEqual(expect.arrayContaining([
      "output_truncated",
      "output_total_bytes",
      "output_artifact_path",
      "exit_code",
      "provider_agent_key",
      "subagent_identity_key",
    ]));

    db.close();
  });
});

describe("ToolCallRecordRepo", () => {
  let db: Database;
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
      displayName: "Explorer",
      providerAgentKey: "/root/explorer",
      subagentIdentityKey: "native-explorer",
      subagentProviderName: "Cursor",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      inputSummary: "file.ts",
      outputSummary: "200 lines",
      outputTruncated: true,
      outputTotalBytes: 300_000,
      outputArtifactPath: "C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt",
      exitCode: 1,
      status: "completed",
      sortOrder: 0,
    };

    const record = repo.create(input);

    expect(record.id).toBeDefined();
    expect(record.message_id).toBe(messageId);
    expect(record.tool_name).toBe("Read");
    expect(record.display_name).toBe("Explorer");
    expect(record.provider_agent_key).toBe("/root/explorer");
    expect(record.subagent_identity_key).toBe("native-explorer");
    expect(record.subagent_provider_name).toBe("Cursor");
    expect(record.model).toBe("gpt-5.3-codex");
    expect(record.reasoning_effort).toBe("high");
    expect(record.input_summary).toBe("file.ts");
    expect(record.output_summary).toBe("200 lines");
    expect(record.output_truncated).toBe(1);
    expect(record.output_total_bytes).toBe(300_000);
    expect(record.output_artifact_path).toBe("C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt");
    expect(record.exit_code).toBe(1);
    expect(record.status).toBe("completed");
    expect(record.sort_order).toBe(0);
    expect(record.parent_tool_call_id).toBeNull();
    expect(record.completed_at).toBeDefined();

    const records = repo.listByMessage(messageId);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(record.id);
    expect(records[0]!.display_name).toBe("Explorer");
    expect(records[0]!.provider_agent_key).toBe("/root/explorer");
    expect(records[0]!.subagent_identity_key).toBe("native-explorer");
    expect(records[0]!.subagent_provider_name).toBe("Cursor");
    expect(records[0]!.model).toBe("gpt-5.3-codex");
    expect(records[0]!.reasoning_effort).toBe("high");
    expect(records[0]!.output_truncated).toBe(1);
    expect(records[0]!.exit_code).toBe(1);
  });

  it("preserves a successful exit code of zero", () => {
    const record = repo.create({
      messageId,
      toolName: "Bash",
      inputSummary: "git status",
      outputSummary: "",
      exitCode: 0,
      status: "completed",
      sortOrder: 0,
    });

    expect(record.exit_code).toBe(0);
    expect(repo.listByMessage(messageId)[0]!.exit_code).toBe(0);
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

  it("returns command execution and Agent records sharing one assistant message", () => {
    repo.bulkCreate([
      {
        toolCallId: "command-1",
        messageId,
        toolName: "command_execution",
        inputSummary: "pwd",
        outputSummary: "/workspace",
        status: "completed",
        sortOrder: 1,
      },
      {
        toolCallId: "agent-1",
        messageId,
        toolName: "Agent",
        inputSummary: "delegate",
        outputSummary: "done",
        status: "completed",
        sortOrder: 2,
      },
    ]);

    expect(repo.listByMessage(messageId).map((record) => record.tool_name)).toEqual([
      "command_execution",
      "Agent",
    ]);
    expect(repo.listByMessages([messageId]).get(messageId)?.map((record) => record.tool_name)).toEqual([
      "command_execution",
      "Agent",
    ]);
  });

  it("preserves explicit lifecycle timestamps for each bulk-created record", () => {
    repo.bulkCreate([
      {
        toolCallId: "agent-first",
        messageId,
        toolName: "Agent",
        inputSummary: "First delegated task",
        outputSummary: "First result",
        status: "completed",
        startedAt: "2026-07-22T10:00:00.000Z",
        completedAt: "2026-07-22T10:00:20.000Z",
        sortOrder: 0,
      },
      {
        toolCallId: "agent-second",
        messageId,
        toolName: "Agent",
        inputSummary: "Second delegated task",
        outputSummary: "Second result",
        status: "completed",
        startedAt: "2026-07-22T10:00:05.000Z",
        completedAt: "2026-07-22T10:00:50.000Z",
        sortOrder: 1,
      },
    ]);

    expect(repo.listByMessage(messageId).map((record) => ({
      id: record.id,
      startedAt: record.started_at,
      completedAt: record.completed_at,
    }))).toEqual([
      {
        id: "agent-first",
        startedAt: "2026-07-22T10:00:00.000Z",
        completedAt: "2026-07-22T10:00:20.000Z",
      },
      {
        id: "agent-second",
        startedAt: "2026-07-22T10:00:05.000Z",
        completedAt: "2026-07-22T10:00:50.000Z",
      },
    ]);
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
