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
  it("keeps explicit metadata local to the subagent and counts direct children before transcript caps", () => {
    const calls = [
      call({
        id: "agent",
        toolName: "Agent",
        toolInput: { model: "gpt-5.3-codex", reasoningEffort: "high" },
        startedAt: 1_000,
        lastActivityAt: 3_000,
        isComplete: true,
      }),
      ...Array.from({ length: 40 }, (_, index) =>
        call({
          id: `child-${index}`,
          toolName: index === 0 ? "Agent" : "Read",
          parentToolCallId: "agent",
          isComplete: true,
        })),
    ];

    const row = projectSubagents(calls, []).finished[0]!;

    expect(row.detail).toMatchObject({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      stepCount: 40,
      subagentCount: 1,
    });
    expect(row.detail.transcript).toHaveLength(32);
  });

  it("sums runtime and direct-child counts across one logical provider agent", () => {
    const row = projectSubagents([
      call({
        id: "first",
        toolName: "Agent",
        toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" },
        elapsedSeconds: 5,
        isComplete: true,
      }),
      call({ id: "first-child", toolName: "Read", parentToolCallId: "first" }),
      call({
        id: "second",
        toolName: "Agent",
        toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" },
        elapsedSeconds: 7,
        isComplete: true,
      }),
      call({ id: "second-child", toolName: "Write", parentToolCallId: "second" }),
    ], []).finished[0]!;

    expect(row.elapsedSeconds).toBe(12);
    expect(row.detail.stepCount).toBe(2);
  });

  it("groups repeated explicit Codex agent paths while keeping pathless calls separate", () => {
    const calls = [
      call({ id: "explorer-1", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" }, isComplete: true, lastActivityAt: 10 }),
      call({ id: "explorer-2", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" }, isComplete: true, lastActivityAt: 20 }),
      call({ id: "explorer-3", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" }, isComplete: true, lastActivityAt: 30 }),
      call({ id: "explorer-4", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" }, output: "Latest explorer result", isComplete: true, lastActivityAt: 40 }),
      call({ id: "legacy", toolName: "Agent", toolInput: { agentName: "Explorer" }, isComplete: true, lastActivityAt: 50 }),
    ];

    const roster = projectSubagents(calls, []);

    expect(roster.finished).toHaveLength(2);
    expect(roster.finished[0]).toMatchObject({
      id: "legacy",
      memberCallIds: ["legacy"],
    });
    expect(roster.finished[1]).toMatchObject({
      id: "explorer-4",
      identity: "explorer",
      memberCallIds: ["explorer-1", "explorer-2", "explorer-3", "explorer-4"],
      detail: {
        output: "Latest explorer result",
        subtreeIds: ["explorer-1", "explorer-2", "explorer-3", "explorer-4"],
      },
    });
  });

  it("keeps matching display tails from different full agent paths distinct", () => {
    const roster = projectSubagents([
      call({ id: "a", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/a/explorer" }, isComplete: true }),
      call({ id: "b", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/b/explorer" }, isComplete: true }),
    ], []);

    expect(roster.finished).toHaveLength(2);
    expect(roster.finished.map((row) => row.memberCallIds)).toEqual([["a"], ["b"]]);
  });

  it("keeps parallel receiver identities separate when their provider path matches", () => {
    const roster = projectSubagents([
      call({
        id: "direct-receiver",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/worker",
          receiverThreadIds: ["native-direct"],
        },
        isComplete: true,
      }),
      call({
        id: "nested-receiver",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/worker",
          receiverThreadIds: ["native-nested"],
        },
        parentToolCallId: "direct-receiver",
        isComplete: true,
      }),
      call({
        id: "parallel-receiver",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/worker",
          receiverThreadIds: ["native-parallel"],
        },
        isComplete: true,
      }),
    ], []);

    expect(roster.finished).toHaveLength(2);
    expect(roster.finished.map((row) => row.memberCallIds)).toEqual([
      ["direct-receiver"],
      ["parallel-receiver"],
    ]);
    expect(roster.finished[0]?.detail.subagentCount).toBe(1);
  });

  it("keeps a logical agent active while any same-path dispatch remains active", () => {
    const roster = projectSubagents([
      call({ id: "settled", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" }, output: "Earlier result", isComplete: true, lastActivityAt: 10 }),
      call({ id: "running", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" }, isComplete: false, lastActivityAt: 20 }),
    ], []);

    expect(roster.finished).toEqual([]);
    expect(roster.active).toEqual([expect.objectContaining({
      id: "running",
      memberCallIds: ["settled", "running"],
    })]);
  });

  it("uses the newest dispatch copy and status when an earlier dispatch settles later", () => {
    const roster = projectSubagents([
      call({
        id: "earlier",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/explorer",
          agentName: "Earlier explorer",
          description: "Earlier task",
        },
        output: "Earlier result",
        isComplete: true,
        lastActivityAt: 100,
      }),
      call({
        id: "newer",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/explorer",
          agentName: "Newer explorer",
          description: "Newer task",
        },
        output: "Newer failure",
        isComplete: true,
        isError: true,
        lastActivityAt: 50,
      }),
      call({
        id: "other",
        toolName: "Agent",
        toolInput: { agentName: "Other explorer" },
        isComplete: true,
        lastActivityAt: 75,
      }),
    ], []);

    expect(roster.finished.map((row) => row.id)).toEqual(["newer", "other"]);
    expect(roster.finished[0]).toEqual(expect.objectContaining({
      id: "newer",
      identity: "Newer explorer",
      task: "Newer task",
      activity: "Newer failure",
      status: "failed",
      memberCallIds: ["earlier", "newer"],
      detail: expect.objectContaining({ output: "Newer failure" }),
    }));
  });

  it("keeps an earlier dispatch active while using copy from the newest settled dispatch", () => {
    const roster = projectSubagents([
      call({
        id: "earlier-running",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/explorer",
          agentName: "Earlier explorer",
          description: "Earlier active task",
        },
        lastActivityAt: 100,
      }),
      call({
        id: "newer-settled",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/explorer",
          agentName: "Newer explorer",
          description: "Newer settled task",
        },
        output: "Newer settled result",
        isComplete: true,
        lastActivityAt: 50,
      }),
      call({
        id: "other-running",
        toolName: "Agent",
        toolInput: { agentName: "Other explorer" },
        lastActivityAt: 75,
      }),
    ], []);

    expect(roster.finished).toEqual([]);
    expect(roster.active.map((row) => row.id)).toEqual(["newer-settled", "other-running"]);
    expect(roster.active[0]).toEqual(expect.objectContaining({
      id: "newer-settled",
      identity: "Newer explorer",
      task: "Newer settled task",
      activity: "Newer settled result",
      memberCallIds: ["earlier-running", "newer-settled"],
      detail: expect.objectContaining({ output: "Newer settled result" }),
    }));
    expect(roster.active[0]).not.toHaveProperty("status");
  });

  it("retains trustworthy file effects spanning dispatches in one logical group", () => {
    const roster = projectSubagents([
      call({ id: "first", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" } }),
      call({ id: "first-write", toolName: "Write", parentToolCallId: "first" }),
      call({ id: "second", toolName: "Agent", toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/explorer" } }),
      call({ id: "second-write", toolName: "Write", parentToolCallId: "second" }),
    ], [], 0, {
      revision: 1,
      fileCount: 1,
      additions: 2,
      deletions: 0,
      effects: [{
        path: "shared.ts",
        kind: "edited",
        scope: "workspace",
        additions: 2,
        deletions: 0,
        binary: false,
        toolCallIds: ["first-write", "second-write"],
      }],
    });

    expect(roster.active[0]?.detail.fileEffects.map((effect) => effect.path)).toEqual(["shared.ts"]);
  });

  it("hydrates the same logical grouping and aggregates bounded member detail", () => {
    const roster = projectSubagents([], [[
      record({
        id: "first",
        provider_agent_key: "/root/explorer",
        output_summary: "Earlier result",
        sort_order: 0,
      }),
      record({
        id: "first-child",
        parent_tool_call_id: "first",
        tool_name: "Read",
        input_summary: "first.ts",
        sort_order: 1,
      }),
      record({
        id: "latest",
        provider_agent_key: "/root/explorer",
        output_summary: "Latest result",
        completed_at: "2026-07-22T10:02:00.000Z",
        sort_order: 2,
      }),
      record({
        id: "latest-child",
        parent_tool_call_id: "latest",
        tool_name: "Write",
        input_summary: "latest.ts",
        sort_order: 3,
      }),
    ]]);

    expect(roster.finished).toEqual([expect.objectContaining({
      id: "latest",
      memberCallIds: ["first", "latest"],
      startedAt: Date.parse("2026-07-22T10:00:00.000Z"),
      detail: expect.objectContaining({
        output: "Latest result",
        subtreeIds: ["first", "first-child", "latest", "latest-child"],
        activity: [
          expect.objectContaining({ id: "first-child" }),
          expect.objectContaining({ id: "latest-child" }),
        ],
      }),
    })]);
  });

  it("preserves a live provider identity when the matching persisted record has none", () => {
    const roster = projectSubagents([
      call({
        id: "agent-with-late-identity",
        toolName: "Agent",
        toolInput: { agentName: "Euclid" },
        isComplete: true,
      }),
    ], [[
      record({ id: "agent-with-late-identity", display_name: null }),
    ]]);

    expect(roster.finished[0]).toMatchObject({
      identity: "Euclid",
      hasExplicitIdentity: true,
      status: "completed",
    });
  });

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
        hasExplicitIdentity: true,
        task: "Review auth changes",
        startedAt: 1_000,
        activity: "Read file: auth.ts",
        activityAt: 8_000,
        elapsedSeconds: 10,
      })],
      finished: [],
    });
    expect(roster.active[0]?.detail).toMatchObject({
      subtreeIds: ["agent-a", "child-a"],
      activity: [expect.objectContaining({ id: "child-a", depth: 1, label: "Read file" })],
      transcript: [expect.objectContaining({ id: "child-a", parentToolCallId: undefined })],
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
      identity: "Live worker",
      hasExplicitIdentity: true,
      task: "Persisted task",
      activity: "Persisted result",
    });
  });

  it("keeps persisted children separate when exact identities differ on one provider path", () => {
    const roster = projectSubagents(undefined, [[
      record({
        id: "direct",
        provider_agent_key: "/root/worker",
        subagent_identity_key: "native-direct",
        display_name: "Worker",
        status: "completed",
        sort_order: 0,
      }),
      record({
        id: "nested",
        provider_agent_key: "/root/worker",
        subagent_identity_key: "native-nested",
        display_name: "Worker",
        parent_tool_call_id: "direct",
        status: "completed",
        sort_order: 1,
      }),
      record({
        id: "nested-read",
        tool_name: "Read",
        parent_tool_call_id: "nested",
        input_summary: "nested.ts",
        sort_order: 2,
      }),
    ]]);

    expect(roster.finished).toHaveLength(1);
    expect(roster.finished[0]?.id).toBe("direct");
    expect(roster.finished[0]?.detail.subtreeIds).toEqual(["direct", "nested", "nested-read"]);
    expect(roster.finished[0]?.detail.transcript.find((call) => call.id === "nested")
      ?.subagentPresentation?.identityKey).toBe("native-nested");
  });

  it("reconciles a live-to-hydrated identity transition by provider key", () => {
    const roster = projectSubagents([
      call({
        id: "live-child-call",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/worker",
          agentName: "Worker",
        },
        isComplete: true,
        output: "Live result",
      }),
    ], [[record({
      id: "persisted-child-call",
      provider_agent_key: "/root/worker",
      display_name: "Worker",
      status: "cancelled",
      output_summary: "Interrupted by user",
    })]]);

    expect(roster.active).toEqual([]);
    expect(roster.finished).toHaveLength(1);
    expect(roster.finished[0]).toMatchObject({
      id: "persisted-child-call",
      identity: "Worker",
      status: "cancelled",
      memberCallIds: ["live-child-call", "persisted-child-call"],
    });
  });

  it("recreates hydrated terminal rows from the loaded narrative without inventing provider identity", () => {
    const roster = projectSubagents(undefined, [[
      record({ id: "hydrated", input_summary: "Inspect the persisted call", status: "failed" }),
    ]]);

    expect(roster.finished).toEqual([expect.objectContaining({
      id: "hydrated",
      identity: "Subagent",
      hasExplicitIdentity: false,
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
      "general",
      "Subagent",
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

  it("excludes internal lifecycle records from subagent detail activity and transcript", () => {
    const roster = projectSubagents([
      call({ id: "agent-a", toolName: "Agent", toolInput: { agentName: "Explorer" } }),
      call({
        id: "update-a",
        toolName: "__McodeSubagentLifecycle",
        toolInput: { lifecycle: "updated", agentName: "Explorer" },
        parentToolCallId: "agent-a",
      }),
    ], []);

    expect(roster.active).toHaveLength(1);
    expect(roster.active[0]?.detail.activity).toEqual([]);
    expect(roster.active[0]?.detail.transcript).toEqual([]);
    expect(roster.active[0]?.detail.subtreeIds).toEqual(["agent-a"]);
  });

  it("keeps explicit Subagent identity provenance distinct from the fallback label", () => {
    const live = projectSubagents([
      call({ id: "unnamed", toolName: "Agent", toolInput: {} }),
      call({ id: "explicit", toolName: "Agent", toolInput: { agentName: "Subagent" } }),
    ], []);
    const hydrated = projectSubagents(undefined, [[
      record({ id: "legacy" }),
      record({ id: "named", display_name: "Subagent", sort_order: 1 }),
    ]]);

    expect(live.active.map(({ identity, hasExplicitIdentity }) => ({ identity, hasExplicitIdentity }))).toEqual([
      { identity: "Subagent", hasExplicitIdentity: false },
      { identity: "Subagent", hasExplicitIdentity: true },
    ]);
    expect(hydrated.finished.map(({ identity, hasExplicitIdentity }) => ({ identity, hasExplicitIdentity }))).toEqual([
      { identity: "Subagent", hasExplicitIdentity: false },
      { identity: "Subagent", hasExplicitIdentity: true },
    ]);
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
    expect(detail?.transcript).toHaveLength(32);
    expect(detail?.transcript[0]).toMatchObject({
      id: "child-0",
      toolInput: { _summary: "file-0.ts" },
      isComplete: true,
    });
    expect(detail?.transcript[0]).not.toHaveProperty("parentToolCallId");
  });
});
