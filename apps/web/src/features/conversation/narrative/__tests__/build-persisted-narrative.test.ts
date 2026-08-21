import { describe, it, expect } from "vitest";
import {
  buildPersistedNarrativeItems,
  recordToHookExecution,
  recordToToolCall,
} from "../build-persisted-narrative";
import { collapseSubagentRecords } from "../subagent-lifecycle";
import type {
  ToolCallRecord,
  ThoughtSegmentRecord,
  HookExecutionRecord,
} from "@/transport/types";

function makeTool(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "t-1",
    message_id: "m-1",
    parent_tool_call_id: null,
    tool_name: "Read",
    input_summary: "",
    output_summary: "",
    status: "completed",
    started_at: "2026-05-15T10:00:00Z",
    completed_at: "2026-05-15T10:00:01Z",
    sort_order: 1,
    ...over,
  };
}

function makeThought(over: Partial<ThoughtSegmentRecord> = {}): ThoughtSegmentRecord {
  return {
    id: "th-1",
    message_id: "m-1",
    text: "thought",
    started_at: "2026-05-15T10:00:00Z",
    ended_at: "2026-05-15T10:00:00.500Z",
    sort_order: 1,
    ...over,
  };
}

function makeHook(over: Partial<HookExecutionRecord> = {}): HookExecutionRecord {
  return {
    id: "hk-1",
    message_id: "m-1",
    hook_name: "PreToolUse",
    tool_name: "Bash",
    phase: "permission",
    payload: "{}",
    duration_ms: 12,
    did_block: false,
    started_at: "2026-05-15T10:00:00Z",
    ended_at: "2026-05-15T10:00:00.012Z",
    sort_order: 2,
    ...over,
  };
}

describe("buildPersistedNarrativeItems", () => {
  it("hydrates persisted Agent identity separately from its task summary", () => {
    const call = recordToToolCall(makeTool({
      tool_name: "Agent",
      display_name: "Explorer",
      provider_agent_key: "/root/explorer",
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
      input_summary: "Inspect the private task",
    }));

    expect(call.toolInput).toEqual({
      _summary: "Inspect the private task",
      agentName: "Explorer",
    });
    expect(call.subagentPresentation).toEqual({
      displayName: "Explorer",
      hasExplicitIdentity: true,
      identityKey: "/root/explorer",
      providerAgentKey: "/root/explorer",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
    });
  });

  it("keeps one hydrated card when a provider identity appears in multiple records", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({
          id: "agent-start",
          tool_name: "Agent",
          provider_agent_key: "/root/worker",
          subagent_identity_key: "native-worker",
          display_name: "Worker",
          status: "cancelled",
          output_summary: "Interrupted by user",
          sort_order: 1,
        }),
        makeTool({
          id: "agent-completion",
          tool_name: "Agent",
          provider_agent_key: "/root/worker",
          subagent_identity_key: "native-worker",
          display_name: "Worker",
          status: "completed",
          sort_order: 2,
        }),
        makeTool({
          id: "nested-read",
          tool_name: "Read",
          parent_tool_call_id: "agent-completion",
          sort_order: 3,
        }),
        makeTool({
          id: "lifecycle-marker",
          tool_name: "__McodeSubagentLifecycle",
          input_summary: JSON.stringify({ lifecycle: "updated", sourceAgentToolCallId: "agent-completion" }),
          parent_tool_call_id: "agent-start",
          sort_order: 4,
        }),
      ],
      thoughts: [],
      hooks: [],
    });

    const cards = items.filter((item) => item.type === "subagent");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.type === "subagent" && cards[0].toolCall.isCancelled).toBe(true);
    expect(cards[0]?.type === "subagent" && cards[0].children.map((child) => child.id)).toEqual(["nested-read"]);
    const collapsed = collapseSubagentRecords([
      makeTool({ id: "source", tool_name: "Agent", provider_agent_key: "/root/worker", subagent_identity_key: "native-worker", status: "cancelled" }),
      makeTool({ id: "alias", tool_name: "Agent", provider_agent_key: "/root/worker", subagent_identity_key: "native-worker", status: "completed" }),
      makeTool({
        id: "marker",
        tool_name: "__McodeSubagentLifecycle",
        input_summary: JSON.stringify({ sourceAgentToolCallId: "alias" }),
      }),
    ]);
    expect(JSON.parse(collapsed.find((record) => record.id === "marker")!.input_summary)
      .sourceAgentToolCallId).toBe("source");
  });

  it("keeps distinct durable child identities and nested transcript records", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({
          id: "direct",
          tool_name: "Agent",
          provider_agent_key: "/root/worker",
          subagent_identity_key: "native-direct",
          display_name: "Worker",
          sort_order: 1,
        }),
        makeTool({
          id: "nested",
          tool_name: "Agent",
          provider_agent_key: "/root/worker",
          subagent_identity_key: "native-nested",
          display_name: "Worker",
          parent_tool_call_id: "direct",
          sort_order: 2,
        }),
        makeTool({
          id: "nested-read",
          tool_name: "Read",
          parent_tool_call_id: "nested",
          sort_order: 3,
        }),
      ],
      thoughts: [],
      hooks: [],
    });

    const cards = items.filter((item) => item.type === "subagent");
    expect(cards.map((item) => item.type === "subagent" ? item.toolCall.id : "")).toEqual([
      "direct",
      "nested",
    ]);
    const nestedCard = cards.find((item) => item.type === "subagent" && item.toolCall.id === "nested");
    expect(nestedCard?.type === "subagent" && nestedCard.children.map((child) => child.id)).toContain("nested-read");
  });

  it("preserves an exact identity learned after a provisional provider-only record", () => {
    const [canonical] = collapseSubagentRecords([
      makeTool({
        id: "provisional",
        tool_name: "Agent",
        provider_agent_key: "/root/worker",
      }),
      makeTool({
        id: "exact",
        tool_name: "Agent",
        provider_agent_key: "/root/worker",
        subagent_identity_key: "native-worker",
      }),
    ]);

    expect(canonical).toMatchObject({
      id: "provisional",
      subagent_identity_key: "native-worker",
    });
  });
  it("empty input returns no items", () => {
    expect(buildPersistedNarrativeItems({ tools: [], thoughts: [], hooks: [] })).toEqual([]);
  });

  it("thoughts-only: emits a thought row per record", () => {
    const items = buildPersistedNarrativeItems({
      tools: [],
      thoughts: [makeThought({ id: "th-1", text: "a", sort_order: 1 })],
      hooks: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("thought");
  });

  it("tools-only flat: groups consecutive completed non-Agent calls into a tool-group", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "t-1", tool_name: "Read", sort_order: 1 }),
        makeTool({ id: "t-2", tool_name: "Write", sort_order: 2 }),
      ],
      thoughts: [],
      hooks: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("tool-group");
    if (items[0].type === "tool-group") {
      expect(items[0].group.calls).toHaveLength(2);
    }
  });

  it("hydrates persisted truncation metadata onto tool calls", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({
          id: "t-1",
          output_summary: "preview",
          output_truncated: 1,
          output_total_bytes: 300_000,
          output_artifact_path: "C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt",
        }),
      ],
      thoughts: [],
      hooks: [],
    });

    expect(items[0].type).toBe("tool-group");
    if (items[0].type === "tool-group") {
      expect(items[0].group.calls[0]).toMatchObject({
        outputTruncated: true,
        outputTotalBytes: 300_000,
        outputArtifactPath: "C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt",
      });
    }
  });

  it("hydrates a persisted shell exit code onto the rendered tool call", () => {
    const items = buildPersistedNarrativeItems({
      tools: [makeTool({ tool_name: "Bash", status: "failed", exit_code: 1 })],
      thoughts: [],
      hooks: [],
    });

    expect(items[0].type).toBe("tool-group");
    if (items[0].type === "tool-group") {
      expect(items[0].group.calls[0].exitCode).toBe(1);
    }
  });

  it("preserves an explicit persisted cancellation status", () => {
    const items = buildPersistedNarrativeItems({
      tools: [makeTool({ tool_name: "Bash", status: "cancelled" })],
      thoughts: [],
      hooks: [],
    });

    expect(items[0].type).toBe("tool-group");
    if (items[0].type === "tool-group") {
      expect(items[0].hasCancelled).toBe(true);
      expect(items[0].group.calls[0].isCancelled).toBe(true);
    }
  });

  it.each([
    ["a positive interval", "2026-05-15T10:00:00Z", "2026-05-15T10:00:15Z", 15_000],
    ["a zero interval", "2026-05-15T10:00:00Z", "2026-05-15T10:00:00Z", 0],
  ])("hydrates %s as a completed tool duration", (_label, startedAt, completedAt, expected) => {
    const items = buildPersistedNarrativeItems({
      tools: [makeTool({ started_at: startedAt, completed_at: completedAt })],
      thoughts: [],
      hooks: [],
    });

    expect(items[0].type).toBe("tool-group");
    if (items[0].type === "tool-group") {
      expect(items[0].group.calls[0].durationMs).toBe(expected);
    }
  });

  it.each([
    ["missing completion", "2026-05-15T10:00:00Z", null],
    ["invalid start", "not-a-date", "2026-05-15T10:00:15Z"],
    ["invalid completion", "2026-05-15T10:00:00Z", "not-a-date"],
    ["reversed timestamps", "2026-05-15T10:00:15Z", "2026-05-15T10:00:00Z"],
  ])("omits duration for %s", (_label, startedAt, completedAt) => {
    const items = buildPersistedNarrativeItems({
      tools: [makeTool({ started_at: startedAt, completed_at: completedAt })],
      thoughts: [],
      hooks: [],
    });

    expect(items[0].type).toBe("tool-group");
    if (items[0].type === "tool-group") {
      expect(items[0].group.calls[0].durationMs).toBeUndefined();
    }
  });

  it("hooks-only: emits a hook row per record", () => {
    const items = buildPersistedNarrativeItems({
      tools: [],
      thoughts: [],
      hooks: [makeHook({ id: "hk-1" })],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("hook");
  });

  it("omits stop hooks from the pre-message narrative", () => {
    const items = buildPersistedNarrativeItems({
      tools: [],
      thoughts: [],
      hooks: [
        makeHook({
          id: "hk-1",
          phase: "stop",
        }),
      ],
    });

    expect(items).toEqual([]);
  });

  it("maps persisted hook metadata into readable detail lines", () => {
    const hook = recordToHookExecution(
      makeHook({
        id: "hk-1",
        phase: "stop",
        tool_name: "Bash",
        payload: "{\"command\":\"bun test\"}",
        duration_ms: 42,
        did_block: true,
      }),
    );

    expect(hook.hookType).toBe("stop");
    expect(hook.outputLines).toEqual([
      "phase: stop",
      "tool: Bash",
      "duration: 42ms",
      "blocked: yes",
      "payload: {\"command\":\"bun test\"}",
    ]);
    expect(hook.fullOutput).toEqual(hook.outputLines);
  });

  it("nests child tool calls under their parent Agent as a subagent row", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "agent-1", tool_name: "Agent", sort_order: 1 }),
        makeTool({ id: "child-1", tool_name: "Read", sort_order: 2, parent_tool_call_id: "agent-1" }),
      ],
      thoughts: [],
      hooks: [],
    });
    expect(items).toHaveLength(1);
    expect(items.map((item) => item.type === "subagent" ? item.lifecycle : item.type)).toEqual(["finished"]);
    if (items[0]?.type === "subagent") {
      expect(items[0].children).toHaveLength(1);
      expect(items[0].toolCall.id).toBe("agent-1");
    }
  });

  it("parallel sibling sub-agents render in one bounded activity row", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "agent-1", tool_name: "Agent", sort_order: 1 }),
        makeTool({ id: "agent-2", tool_name: "Agent", sort_order: 2 }),
        makeTool({ id: "c-1a", tool_name: "Read", sort_order: 3, parent_tool_call_id: "agent-1" }),
        makeTool({ id: "c-2a", tool_name: "Read", sort_order: 4, parent_tool_call_id: "agent-2" }),
      ],
      thoughts: [],
      hooks: [],
    });
    const rows = items.filter((i) => i.type === "subagent");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type === "subagent"
      ? rows[0].activities?.map((activity) => activity.toolCall.id)
      : []).toEqual(["agent-1", "agent-2"]);
  });

  it("hydrates every persisted lifecycle update without exposing child activity", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({
          id: "agent-1",
          tool_name: "Agent",
          display_name: "Explorer",
          input_summary: "Private delegated prompt",
          started_at: "2026-05-15T10:00:00Z",
          completed_at: "2026-05-15T10:00:04Z",
          sort_order: 1,
        }),
        makeTool({
          id: "update-1",
          tool_name: "__McodeSubagentLifecycle",
          input_summary: '{"lifecycle":"updated","agentName":"Explorer"}',
          parent_tool_call_id: "agent-1",
          sort_order: 2,
        }),
        makeTool({
          id: "child-command",
          tool_name: "Bash",
          input_summary: "private child command",
          parent_tool_call_id: "agent-1",
          sort_order: 3,
        }),
        makeTool({
          id: "update-2",
          tool_name: "__McodeSubagentLifecycle",
          input_summary: '{"lifecycle":"updated","agentName":"Explorer"}',
          parent_tool_call_id: "agent-1",
          sort_order: 4,
        }),
      ],
      thoughts: [],
      hooks: [],
    });

    expect(items.map((item) => item.type === "subagent" ? item.lifecycle : item.type)).toEqual(["finished"]);
  });

  it("uses the latest persisted marker while an Agent is still running", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({
          id: "agent-running",
          tool_name: "Agent",
          status: "running",
          sort_order: 1,
        }),
        makeTool({
          id: "update-running",
          tool_name: "__McodeSubagentLifecycle",
          input_summary: '{"lifecycle":"updated"}',
          parent_tool_call_id: "agent-running",
          sort_order: 2,
        }),
      ],
      thoughts: [],
      hooks: [],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "subagent", lifecycle: "updated" });
  });

  it("matches live source-then-target participants and tolerates legacy markers", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({
          id: "agent-source",
          tool_name: "Agent",
          display_name: "Explorer",
          sort_order: 1,
        }),
        makeTool({
          id: "agent-target",
          tool_name: "Agent",
          display_name: "Implementer",
          parent_tool_call_id: "agent-source",
          sort_order: 2,
        }),
        makeTool({
          id: "update-target",
          tool_name: "__McodeSubagentLifecycle",
          input_summary: JSON.stringify({
            lifecycle: "updated",
            sourceAgentName: "Explorer",
            sourceAgentToolCallId: "agent-source",
          }),
          parent_tool_call_id: "agent-target",
          sort_order: 3,
        }),
        makeTool({
          id: "legacy-update",
          tool_name: "__McodeSubagentLifecycle",
          input_summary: "",
          parent_tool_call_id: "agent-source",
          sort_order: 4,
        }),
      ],
      thoughts: [],
      hooks: [],
    });
    const targetRows = items.filter(
      (item) => item.type === "subagent" && item.toolCall.id === "agent-target",
    );
    const sourceRow = items.find(
      (item) => item.type === "subagent" && item.toolCall.id === "agent-source",
    );

    expect(targetRows.map((item) => item.type === "subagent" ? item.lifecycle : "")).toEqual(["finished"]);
    expect(targetRows.every(
      (item) => item.type === "subagent"
        && item.participants.map((participant) => participant.id).join(",") === "agent-source,agent-target",
    )).toBe(true);
    expect(sourceRow?.type === "subagent"
      ? sourceRow.participants.map((participant) => participant.id)
      : []).toEqual(["agent-source"]);
  });

  it("interleaves all streams by sort_order", () => {
    const items = buildPersistedNarrativeItems({
      tools: [
        makeTool({ id: "t-1", tool_name: "Read", sort_order: 2 }),
        makeTool({ id: "t-2", tool_name: "Write", sort_order: 5 }),
      ],
      thoughts: [
        makeThought({ id: "th-1", sort_order: 1 }),
        makeThought({ id: "th-2", sort_order: 3 }),
      ],
      hooks: [makeHook({ id: "hk-1", sort_order: 4 })],
    });
    // sort: thought(1), tool(2), thought(3), hook(4), tool(5)
    // tool-group breaks on each non-tool, so: thought, tool-group(1), thought, hook, tool-group(1)
    expect(items.map((i) => i.type)).toEqual([
      "thought",
      "tool-group",
      "thought",
      "hook",
      "tool-group",
    ]);
  });

  it("hides a thought that exactly matches messageContent even when sort_order is not last", () => {
    const dup = "ENTIRE ASSISTANT BODY";
    const items = buildPersistedNarrativeItems({
      tools: [],
      thoughts: [
        makeThought({ id: "th-dup", text: dup, sort_order: 1 }),
        makeThought({ id: "th-tail", text: "short note", sort_order: 9 }),
      ],
      hooks: [],
      messageContent: dup,
    });
    const thoughtTexts = items
      .filter((i): i is Extract<typeof i, { type: "thought" }> => i.type === "thought")
      .map((i) => i.segment.text);
    expect(thoughtTexts).toEqual(["short note"]);
  });

  it("memo cache invalidates when messageContent changes but thoughts reference is stable", () => {
    const thoughts = [
      makeThought({ id: "th-dup", text: "BODY", sort_order: 1 }),
      makeThought({ id: "th-keep", text: "note", sort_order: 2 }),
    ];
    const first = buildPersistedNarrativeItems({
      tools: [],
      thoughts,
      hooks: [],
      messageContent: "BODY",
    });
    const second = buildPersistedNarrativeItems({
      tools: [],
      thoughts,
      hooks: [],
      messageContent: "OTHER",
    });
    const firstTexts = first
      .filter((i): i is Extract<typeof i, { type: "thought" }> => i.type === "thought")
      .map((i) => i.segment.text);
    const secondTexts = second
      .filter((i): i is Extract<typeof i, { type: "thought" }> => i.type === "thought")
      .map((i) => i.segment.text);
    expect(firstTexts).toEqual(["note"]);
    expect(secondTexts).toEqual(["BODY", "note"]);
  });

  it("memo cache invalidates when persisted tools change but thoughts reference is stable", () => {
    const thoughts = [makeThought({ id: "th-tools-cache", text: "note" })];
    const first = buildPersistedNarrativeItems({
      tools: [],
      thoughts,
      hooks: [],
    });
    const second = buildPersistedNarrativeItems({
      tools: [makeTool({ id: "agent-tools-cache", tool_name: "Agent", sort_order: 2 })],
      thoughts,
      hooks: [],
    });

    expect(first.some((item) => item.type === "subagent")).toBe(false);
    expect(second.some((item) => item.type === "subagent")).toBe(true);
  });

  it("preserves unchanged row inputs when one persisted record changes", () => {
    const stableThought = makeThought({ id: "th-stable", text: "stable", sort_order: 2 });
    const tool = makeTool({ id: "tool-stable", sort_order: 3 });
    const hook = makeHook({ id: "hook-stable", sort_order: 4 });
    const first = buildPersistedNarrativeItems({
      tools: [tool],
      thoughts: [makeThought({ id: "th-changing", text: "before" }), stableThought],
      hooks: [hook],
    });
    const second = buildPersistedNarrativeItems({
      tools: [tool],
      thoughts: [makeThought({ id: "th-changing", text: "after" }), stableThought],
      hooks: [hook],
    });

    const firstStableThought = first.find(
      (item) => item.type === "thought" && item.segment.text === "stable",
    );
    const secondStableThought = second.find(
      (item) => item.type === "thought" && item.segment.text === "stable",
    );
    const firstTool = first.find((item) => item.type === "tool-group");
    const secondTool = second.find((item) => item.type === "tool-group");
    const firstHook = first.find((item) => item.type === "hook");
    const secondHook = second.find((item) => item.type === "hook");

    expect(firstStableThought?.type === "thought" ? firstStableThought.segment : null)
      .toBe(secondStableThought?.type === "thought" ? secondStableThought.segment : null);
    expect(firstTool?.type === "tool-group" ? firstTool.group.calls[0] : null)
      .toBe(secondTool?.type === "tool-group" ? secondTool.group.calls[0] : null);
    expect(firstHook?.type === "hook" ? firstHook.hook : null)
      .toBe(secondHook?.type === "hook" ? secondHook.hook : null);
  });
});
