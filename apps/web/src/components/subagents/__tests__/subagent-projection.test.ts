import { describe, expect, it } from "vitest";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import { projectSubagents } from "../subagent-projection";

function call(overrides: Partial<ToolCall> & Pick<ToolCall, "id" | "toolName">): ToolCall {
  return {
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

function record(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, "id">): ToolCallRecord {
  return {
    message_id: "message-1",
    parent_tool_call_id: null,
    tool_name: "Agent",
    input_summary: "Review the roster",
    output_summary: "Finished review",
    status: "completed",
    started_at: "2026-07-22T10:00:00.000Z",
    completed_at: "2026-07-22T10:01:00.000Z",
    sort_order: 0,
    ...overrides,
  };
}

describe("projectSubagents", () => {
  it("projects top-level running Agents with provider identity, task, descendant activity, and elapsed time", () => {
    const roster = projectSubagents([
      call({
        id: "agent-a",
        toolName: "Agent",
        toolInput: { agentName: "Security reviewer", description: "Review auth changes" },
        startedAt: 1_000,
        lastActivityAt: 1_000,
      }),
      call({
        id: "child-a",
        toolName: "Read",
        toolInput: { file_path: "apps/server/src/auth.ts" },
        parentToolCallId: "agent-a",
        startedAt: 2_000,
        lastActivityAt: 8_000,
      }),
    ], [], 11_000);

    expect(roster).toEqual({
      active: [expect.objectContaining({
        id: "agent-a",
        identity: "Security reviewer",
        task: "Review auth changes",
        activity: "Read file: auth.ts",
        activityAt: 8_000,
        elapsedSeconds: 10,
      })],
      finished: [],
    });
    expect(roster.active[0]?.detail).toMatchObject({
      subtreeIds: ["agent-a", "child-a"],
      activity: [expect.objectContaining({ id: "child-a", depth: 1, label: "Read file" })],
    });
  });

  it("keeps nested Agents out of the top-level roster and orders active rows by descendant activity", () => {
    const roster = projectSubagents([
      call({ id: "agent-first", toolName: "Agent", toolInput: { description: "First" }, lastActivityAt: 10 }),
      call({ id: "agent-second", toolName: "Agent", toolInput: { description: "Second" }, lastActivityAt: 10 }),
      call({ id: "child-second", toolName: "Grep", toolInput: { pattern: "Subagent" }, parentToolCallId: "agent-second", lastActivityAt: 20 }),
      call({ id: "nested-agent", toolName: "Agent", toolInput: { description: "Nested" }, parentToolCallId: "agent-first", lastActivityAt: 30 }),
    ], [], 30_000);

    expect(roster.active.map((row) => row.id)).toEqual(["agent-first", "agent-second"]);
    expect(roster.active[0]?.activity).toBe("Delegated task: Nested");
    expect(roster.active[1]?.activity).toBe('Searched files: "Subagent"');
  });

  it("maps completed, failed, and cancelled terminal Agent rows with newest terminal time first", () => {
    const roster = projectSubagents([], [[
      record({ id: "completed", status: "completed", completed_at: "2026-07-22T10:01:00.000Z", sort_order: 4 }),
      record({ id: "failed", status: "failed", started_at: "2026-07-22T10:00:05.000Z", completed_at: "2026-07-22T10:03:00.000Z", output_summary: "Command exited 1", sort_order: 3 }),
      record({ id: "cancelled", status: "cancelled", started_at: "2026-07-22T10:00:10.000Z", completed_at: "2026-07-22T10:02:00.000Z", sort_order: 2 }),
      record({ id: "nested", parent_tool_call_id: "completed", completed_at: "2026-07-22T10:04:00.000Z" }),
    ]]);

    expect(roster.finished.map((row) => [row.id, row.status])).toEqual([
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["completed", "completed"],
    ]);
    expect(roster.finished.find((row) => row.id === "failed")?.activity).toBe("Command exited 1");
    expect(roster.finished.find((row) => row.id === "completed")?.elapsedSeconds).toBe(60);
  });

  it("uses deterministic source order for equal terminal times", () => {
    const roster = projectSubagents([], [[
      record({ id: "first", sort_order: 1 }),
      record({ id: "second", sort_order: 2 }),
    ]]);

    expect(roster.finished.map((row) => row.id)).toEqual(["first", "second"]);
  });

  it("reconciles a settled live Agent with its hydrated record by id without a duplicate", () => {
    const roster = projectSubagents([
      call({
        id: "agent-1",
        toolName: "Agent",
        toolInput: { agentName: "Live worker", description: "Live task" },
        output: "Live result",
        isComplete: true,
        startedAt: 1_000,
        lastActivityAt: 2_000,
      }),
    ], [[record({
      id: "agent-1",
      input_summary: "Persisted task",
      output_summary: "Persisted result",
      completed_at: "2026-07-22T10:01:00.000Z",
    })]]);

    expect(roster.active).toEqual([]);
    expect(roster.finished).toHaveLength(1);
    expect(roster.finished[0]).toMatchObject({
      id: "agent-1",
      identity: "Persisted task",
      task: "Persisted task",
      activity: "Persisted result",
    });
  });

  it("recreates hydrated terminal rows from the loaded narrative without inventing provider identity", () => {
    const roster = projectSubagents(undefined, [[
      record({ id: "hydrated", input_summary: "Inspect the persisted call", status: "failed" }),
    ]]);

    expect(roster.finished).toEqual([expect.objectContaining({
      id: "hydrated",
      identity: "Inspect the persisted call",
      task: "Inspect the persisted call",
      status: "failed",
    })]);
  });

  it("uses provider names before task descriptions and never uses provider models as identities", () => {
    const roster = projectSubagents([
      call({ id: "named-agent", toolName: "Agent", toolInput: { agentName: "Repository reviewer", description: "Review identity precedence", model: "gpt-5.6" } }),
      call({ id: "cursor-agent", toolName: "Agent", toolInput: { description: "Cursor delegated task", prompt: "Inspect the Cursor task result", model: "cursor-large", agentId: "cursor-internal-id", subagentType: "general" } }),
      call({ id: "codex-agent", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", prompt: "Review Codex collaboration events", model: "gpt-5.6-codex" } }),
      call({ id: "unnamed-agent", toolName: "Agent", toolInput: { model: "not-a-name" } }),
    ], []);

    expect(roster.active.map((row) => row.identity)).toEqual([
      "Repository reviewer",
      "Cursor delegated task",
      "Review Codex collaboration events",
      "Subagent",
    ]);
  });

  it("bounds provider-supplied identity, task, and activity text", () => {
    const roster = projectSubagents([
      call({ id: "agent", toolName: "Agent", toolInput: { agentName: "i".repeat(160), description: "t".repeat(400) }, lastActivityAt: 1 }),
      call({ id: "activity", toolName: "Bash", toolInput: { command: "a".repeat(400) }, parentToolCallId: "agent", lastActivityAt: 2 }),
    ], []);

    const row = roster.active[0];
    expect(row?.identity).toHaveLength(96);
    expect(row?.identity?.endsWith("…")).toBe(true);
    expect(row?.task).toHaveLength(280);
    expect(row?.task?.endsWith("…")).toBe(true);
    expect(row?.activity).toHaveLength(160);
    expect(row?.activity?.endsWith("…")).toBe(true);
  });

  it("bounds malformed descendant traversal", () => {
    const calls: ToolCall[] = [call({ id: "agent", toolName: "Agent", lastActivityAt: 1 })];
    for (let index = 0; index < 140; index += 1) {
      calls.push(call({ id: `child-${index}`, toolName: "Read", parentToolCallId: index === 0 ? "agent" : `child-${index - 1}`, lastActivityAt: index + 2 }));
    }

    expect(projectSubagents(calls, []).active[0]?.activityAt).toBe(129);
  });

  it("shows file effects only when every recorded tool id belongs to the subtree", () => {
    const roster = projectSubagents([
      call({ id: "agent", toolName: "Agent" }),
      call({ id: "child", toolName: "Write", parentToolCallId: "agent" }),
    ], [], 0, {
      revision: 1,
      fileCount: 3,
      additions: 1,
      deletions: 0,
      effects: [
        { path: "safe.ts", kind: "edited", scope: "workspace", additions: 1, deletions: 0, binary: false, toolCallIds: ["child"] },
        { path: "mixed.ts", kind: "edited", scope: "workspace", additions: 0, deletions: 0, binary: false, toolCallIds: ["child", "other"] },
        { path: "unknown.ts", kind: "edited", scope: "workspace", additions: 0, deletions: 0, binary: false, toolCallIds: [] },
      ],
    });

    expect(roster.active[0]?.detail.fileEffects.map((effect) => effect.path)).toEqual(["safe.ts"]);
  });

  it("preserves hydrated output bounds and discloses persisted activity beyond the detail cap", () => {
    const parent = record({
      id: "hydrated-agent",
      output_summary: "Bounded result",
      output_truncated: 1,
      output_total_bytes: 524_288,
      output_artifact_path: "C:\\artifacts\\hydrated-agent.txt",
    });
    const children = Array.from({ length: 40 }, (_, index) => record({
      id: `child-${index}`,
      parent_tool_call_id: "hydrated-agent",
      tool_name: "Read",
      input_summary: `file-${index}.ts`,
      output_summary: "",
      sort_order: index + 1,
    }));

    const detail = projectSubagents([], [[parent, ...children]]).finished[0]?.detail;

    expect(detail).toMatchObject({
      output: "Bounded result",
      outputTruncated: true,
      outputTotalBytes: 524_288,
      outputArtifactPath: "C:\\artifacts\\hydrated-agent.txt",
      activityTruncated: true,
    });
    expect(detail?.activity).toHaveLength(32);
  });
});
