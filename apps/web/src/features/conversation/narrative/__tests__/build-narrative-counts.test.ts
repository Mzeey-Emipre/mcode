import { describe, it, expect } from "vitest";
import { buildNarrativeItems } from "../build-narrative";
import { collapseSubagentCalls } from "../subagent-lifecycle";
import type { ToolCall } from "@/transport/types";
import type { ThoughtSegment } from "../types";

function mkTool(partial: Partial<ToolCall> & { id: string; toolName: string }): ToolCall {
  return {
    id: partial.id,
    toolName: partial.toolName,
    toolInput: partial.toolInput ?? {},
    isComplete: partial.isComplete ?? true,
    isError: partial.isError ?? false,
    output: partial.output,
    ...(partial.isCancelled ? { isCancelled: true } : {}),
    parentToolCallId: partial.parentToolCallId ?? null,
    startedAt: partial.startedAt ?? 1000,
  } as ToolCall;
}

function mkThought(text: string, startedAt: number, endedAt?: number): ThoughtSegment {
  return { text, startedAt, endedAt };
}

describe("buildNarrativeItems counts", () => {
  it("returns zero counts when nothing happened", () => {
    const { items, counts } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    expect(items).toEqual([]);
    expect(counts).toEqual({ steps: 0, thoughts: 0, subagents: 0 });
  });

  it("counts top-level tool calls as steps and Agent calls as subagents", () => {
    const tools: ToolCall[] = [
      mkTool({ id: "1", toolName: "Read", startedAt: 1000 }),
      mkTool({ id: "2", toolName: "Agent", startedAt: 2000 }),
      mkTool({ id: "3", toolName: "Read", startedAt: 1500, parentToolCallId: "2" }),
      mkTool({ id: "4", toolName: "Grep", startedAt: 3000 }),
    ];
    const { counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    expect(counts.steps).toBe(3);
    expect(counts.subagents).toBe(1);
    expect(counts.thoughts).toBe(0);
  });

  it("renders one logical child when live and completion events use different call ids", () => {
    const tools: ToolCall[] = [
      mkTool({
        id: "child-start",
        toolName: "Agent",
        toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/worker" },
        isComplete: true,
        output: "Interrupted",
        isCancelled: true,
        startedAt: 1000,
      }),
      mkTool({
        id: "child-completion",
        toolName: "Agent",
        toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/worker" },
        isComplete: false,
        parentToolCallId: undefined,
        startedAt: 1100,
      }),
    ];

    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });

    expect(counts.subagents).toBe(1);
    expect(items.filter((item) => item.type === "subagent")).toHaveLength(1);
    const item = items.find((candidate) => candidate.type === "subagent");
    expect(item).toMatchObject({ type: "subagent" });
    if (item?.type === "subagent") {
      expect(item.toolCall).toMatchObject({ isComplete: true, isCancelled: true });
    }
  });

  it("keeps distinct receiver identities separate when provider paths match", () => {
    const calls: ToolCall[] = [
      mkTool({
        id: "direct-child",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/worker",
          receiverThreadIds: ["native-direct"],
        },
        startedAt: 1000,
      }),
      mkTool({
        id: "nested-child",
        toolName: "Agent",
        toolInput: {
          codexCollabKind: "spawnAgent",
          agentPath: "/root/worker",
          receiverThreadIds: ["native-nested"],
        },
        parentToolCallId: "direct-child",
        startedAt: 1100,
      }),
    ];

    const collapsed = collapseSubagentCalls(calls);

    expect(collapsed.map((call) => [call.id, call.parentToolCallId])).toEqual([
      ["direct-child", undefined],
      ["nested-child", "direct-child"],
    ]);
  });

  it("rebases lifecycle marker source ids when a duplicate Agent call is collapsed", () => {
    const calls = [
      mkTool({
        id: "agent-canonical",
        toolName: "Agent",
        toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/worker" },
        startedAt: 1000,
      }),
      mkTool({
        id: "agent-alias",
        toolName: "Agent",
        toolInput: { codexCollabKind: "spawnAgent", agentPath: "/root/worker" },
        parentToolCallId: "agent-canonical",
        startedAt: 1100,
      }),
      mkTool({
        id: "marker",
        toolName: "__McodeSubagentLifecycle",
        toolInput: { lifecycle: "updated", sourceAgentToolCallId: "agent-alias" },
        parentToolCallId: "agent-canonical",
        startedAt: 1200,
      }),
    ];
    const collapsed = collapseSubagentCalls(calls);
    expect(collapsed.find((call) => call.id === "marker")?.toolInput.sourceAgentToolCallId)
      .toBe("agent-canonical");

    const { items } = buildNarrativeItems({
      toolCalls: calls,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });

    const row = items.find((item) => item.type === "subagent");
    expect(row?.type === "subagent" ? row.participants.map((participant) => participant.id) : [])
      .toEqual(["agent-canonical"]);
  });

  it("counts thought segments", () => {
    const thoughts: ThoughtSegment[] = [
      mkThought("first", 500, 600),
      mkThought("second", 700, 800),
    ];
    const tools: ToolCall[] = [mkTool({ id: "1", toolName: "Read", startedAt: 1000 })];
    const { counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: "",
      isAgentRunning: false,
    });
    expect(counts.thoughts).toBe(2);
    expect(counts.steps).toBe(1);
  });

  it("does not count the streaming final response as a thought", () => {
    const thoughts: ThoughtSegment[] = [
      mkThought("streaming-final", 1000), // no endedAt → still streaming
    ];
    const { items, counts } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: "",
      isAgentRunning: true,
    });
    // Final streaming response renders as `delta`, not `thought` (no anyToolRunning)
    expect(items.find((it) => it.type === "delta")).toBeDefined();
    expect(counts.thoughts).toBe(0);
  });

  it("keeps an explicit non-final open segment as a thought when no tool is running", () => {
    const thoughts: ThoughtSegment[] = [
      { ...mkThought("codex narration", 1000), isExplicitNonFinal: true },
    ];
    const { items, counts } = buildNarrativeItems({
      toolCalls: [],
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: "codex narration",
      isAgentRunning: true,
    });

    expect(items.some((it) => it.type === "delta")).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "thought", isActive: true });
    expect(counts.thoughts).toBe(1);
  });

  it("appends isFinal surplus as delta after thoughts when streaming extends past segment tape", () => {
    const thoughts: ThoughtSegment[] = [
      mkThought("pre-tool reasoning", 100, 700),
    ];
    const tools: ToolCall[] = [
      mkTool({
        id: "r1",
        toolName: "Read",
        startedAt: 800,
      }),
    ];
    const fullStream = `${thoughts[0]!.text}Here is the answer.`;
    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: fullStream,
      isAgentRunning: true,
    });
    expect(items.find((it) => it.type === "thought")?.type).toBe("thought");
    const deltaItem = items.find((it) => it.type === "delta");
    expect(deltaItem?.type === "delta" ? deltaItem.text : "").toBe("Here is the answer.");
    expect(counts.thoughts).toBe(1);
  });

  it("counts an in-progress Agent as both a step and a sub-agent", () => {
    const tools: ToolCall[] = [
      mkTool({ id: "1", toolName: "Read", startedAt: 1000 }),
      mkTool({ id: "2", toolName: "Agent", startedAt: 2000, isComplete: false }),
    ];
    const { counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: true,
    });
    expect(counts.steps).toBe(2);
    expect(counts.subagents).toBe(1);
  });

  it("renders one finished row at the Agent start position after lifecycle updates", () => {
    const tools: ToolCall[] = [
      mkTool({
        id: "agent-1",
        toolName: "Agent",
        toolInput: { agentName: "Explorer", description: "Private delegated prompt" },
        startedAt: 1_000,
        durationMs: 4_000,
      }),
      mkTool({
        id: "update-1",
        toolName: "__McodeSubagentLifecycle",
        toolInput: { lifecycle: "updated", agentName: "Explorer" },
        parentToolCallId: "agent-1",
        startedAt: 2_000,
      }),
      mkTool({
        id: "child-command",
        toolName: "Bash",
        toolInput: { command: "private child command" },
        parentToolCallId: "agent-1",
        startedAt: 2_500,
      }),
      mkTool({
        id: "update-2",
        toolName: "__McodeSubagentLifecycle",
        toolInput: { lifecycle: "updated", agentName: "Explorer" },
        parentToolCallId: "agent-1",
        startedAt: 3_000,
      }),
    ];

    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });

    expect(items.map((item) => item.type === "subagent" ? item.lifecycle : item.type)).toEqual(["finished"]);
    expect(items.every((item) => item.type === "subagent")).toBe(true);
    expect(items[0]?.type === "subagent"
      ? items[0].participants.map((participant) => participant.id)
      : []).toEqual(["agent-1"]);
    expect(counts).toEqual({ steps: 1, thoughts: 0, subagents: 1 });
  });

  it("uses the latest lifecycle marker while an Agent is still active", () => {
    const tools: ToolCall[] = [
      mkTool({ id: "agent-active", toolName: "Agent", isComplete: false, startedAt: 1_000 }),
      mkTool({
        id: "update-active",
        toolName: "__McodeSubagentLifecycle",
        toolInput: { lifecycle: "updated" },
        parentToolCallId: "agent-active",
        startedAt: 2_000,
      }),
    ];

    const { items } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: true,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "subagent", lifecycle: "updated" });
  });

  it("builds authoritative source-then-target participants for nested handoffs", () => {
    const tools: ToolCall[] = [
      mkTool({
        id: "agent-source",
        toolName: "Agent",
        toolInput: { agentName: "Explorer" },
        startedAt: 1_000,
      }),
      mkTool({
        id: "agent-target",
        toolName: "Agent",
        toolInput: { agentName: "Implementer" },
        parentToolCallId: "agent-source",
        startedAt: 2_000,
      }),
      mkTool({
        id: "update-target",
        toolName: "__McodeSubagentLifecycle",
        toolInput: {
          lifecycle: "updated",
          sourceAgentName: "Explorer",
          sourceAgentToolCallId: "agent-source",
        },
        parentToolCallId: "agent-target",
        startedAt: 3_000,
      }),
    ];

    const { items } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    const targetRows = items.filter(
      (item) => item.type === "subagent" && item.toolCall.id === "agent-target",
    );

    expect(targetRows.map((item) => item.type === "subagent" ? item.lifecycle : "")).toEqual(["finished"]);
    for (const row of targetRows) {
      if (row.type === "subagent") {
        expect(row.participants.map((participant) => participant.id)).toEqual([
          "agent-source",
          "agent-target",
        ]);
      }
    }
  });

  it("hides thoughts that duplicate the committed assistant bubble (post-turn live trail)", () => {
    const body = "README updated. Same paragraphs in thought and bubble.";
    const thoughts: ThoughtSegment[] = [
      mkThought("earlier reasoning", 100, 200),
      mkThought(body, 300, 400),
    ];
    const tools: ToolCall[] = [mkTool({ id: "1", toolName: "Read", startedAt: 500 })];
    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: "",
      isAgentRunning: false,
      committedAssistantBody: body,
    });
    expect(items.filter((it) => it.type === "thought")).toHaveLength(1);
    expect(counts.thoughts).toBe(1);
  });

  it("hides latest thought segment when bubble ends with that segment text (suffix fallback)", () => {
    const tail = "tail of final reply";
    const body = `Prefix context…${tail}`;
    const thoughts: ThoughtSegment[] = [
      mkThought("plan", 100, 200),
      mkThought(tail, 300, 400),
    ];
    const tools: ToolCall[] = [mkTool({ id: "1", toolName: "Read", startedAt: 500 })];
    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: thoughts,
      streamingText: "",
      isAgentRunning: false,
      committedAssistantBody: body,
    });
    expect(items.filter((it) => it.type === "thought")).toHaveLength(1);
    expect(counts.thoughts).toBe(1);
  });
});
