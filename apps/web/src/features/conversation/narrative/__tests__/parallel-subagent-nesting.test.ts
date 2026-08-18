import { describe, it, expect } from "vitest";
import { buildNarrativeItems } from "../build-narrative";
import type { ToolCall } from "@/transport/types";

/**
 * Regression suite for parallel sub-agent nesting (Claude `Task` / Agent rows).
 *
 * The user's CLAUDE.md workflow dispatches 4 parallel reviewer agents
 * (security/performance/quality/correctness). Each sub-agent issues its own
 * child tool calls. The contract: children with a valid `parentToolCallId`
 * nest under the right Agent row; children whose parent id is missing or
 * empty stay top-level (they were never nested by the SDK).
 *
 * Trap context: see docs/guides/narrative-pipeline.md trap 1.
 */
function mkTool(p: Partial<ToolCall> & { id: string; toolName: string }): ToolCall {
  return {
    id: p.id,
    toolName: p.toolName,
    toolInput: p.toolInput ?? {},
    isComplete: p.isComplete ?? true,
    isError: p.isError ?? false,
    output: p.output ?? null,
    parentToolCallId: p.parentToolCallId,
    startedAt: p.startedAt ?? 1000,
  };
}

describe("parallel sub-agent nesting", () => {
  it("nests each parallel sub-agent's children under the right Agent row", () => {
    const tools: ToolCall[] = [
      // 4 parallel agents dispatched at the top level.
      mkTool({ id: "agent-sec", toolName: "Agent", startedAt: 1000 }),
      mkTool({ id: "agent-perf", toolName: "Agent", startedAt: 1001 }),
      mkTool({ id: "agent-qual", toolName: "Agent", startedAt: 1002 }),
      mkTool({ id: "agent-corr", toolName: "Agent", startedAt: 1003 }),
      // Children of agent-sec
      mkTool({ id: "c1", toolName: "Read", startedAt: 2000, parentToolCallId: "agent-sec" }),
      mkTool({ id: "c2", toolName: "Grep", startedAt: 2100, parentToolCallId: "agent-sec" }),
      // Children of agent-perf
      mkTool({ id: "c3", toolName: "Read", startedAt: 2200, parentToolCallId: "agent-perf" }),
      // Children of agent-qual
      mkTool({ id: "c4", toolName: "Bash", startedAt: 2300, parentToolCallId: "agent-qual" }),
      mkTool({ id: "c5", toolName: "Read", startedAt: 2400, parentToolCallId: "agent-qual" }),
      mkTool({ id: "c6", toolName: "Edit", startedAt: 2500, parentToolCallId: "agent-qual" }),
      // Children of agent-corr
      mkTool({ id: "c7", toolName: "Bash", startedAt: 2600, parentToolCallId: "agent-corr" }),
    ];

    const { items, counts } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });

    const subagentItems = items.filter((i) => i.type === "subagent");
    expect(subagentItems.length).toBe(1);

    for (const agentId of ["agent-sec", "agent-perf", "agent-qual", "agent-corr"]) {
      const item = subagentItems[0];
      expect(item?.type).toBe("subagent");
      expect(item?.type === "subagent"
        ? item.activities?.find((activity) => activity.toolCall.id === agentId)?.lifecycle
        : undefined).toBe("finished");
    }

    const agentRow = (agentId: string) =>
      subagentItems[0]?.type === "subagent"
        ? subagentItems[0].activities?.find((activity) => activity.toolCall.id === agentId)
        : undefined;
    expect(agentRow("agent-sec")?.children.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(agentRow("agent-perf")?.children.map((c) => c.id)).toEqual(["c3"]);
    expect(agentRow("agent-qual")?.children.map((c) => c.id)).toEqual(["c4", "c5", "c6"]);
    expect(agentRow("agent-corr")?.children.map((c) => c.id)).toEqual(["c7"]);

    expect(counts.steps).toBe(4); // 4 top-level Agent rows
    expect(counts.subagents).toBe(4);
  });

  it("treats empty-string parentToolCallId as top-level (cannot be a real parent id)", () => {
    // Defensive: if a bad event ever surfaces parentToolCallId: "" it must
    // be treated as no parent at all. Pre-fix, "" went into childrenMap[""]
    // which is built but never read — the child silently vanished. Post-fix,
    // it surfaces at top level so the user can see something went wrong.
    const tools: ToolCall[] = [
      mkTool({ id: "agent-x", toolName: "Agent", startedAt: 1000 }),
      mkTool({ id: "leaf-1", toolName: "Read", startedAt: 1100, parentToolCallId: "" as unknown as string }),
    ];
    const { items } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    const allIdsRendered = new Set<string>();
    for (const item of items) {
      if (item.type === "subagent") {
        allIdsRendered.add(item.toolCall.id);
        for (const c of item.children) allIdsRendered.add(c.id);
      } else if (item.type === "tool-group") {
        for (const c of item.group.calls) allIdsRendered.add(c.id);
      }
    }
    expect(allIdsRendered.has("leaf-1")).toBe(true);
  });

  it("marks Agent row's hasError when terminal status cancels in-flight children", () => {
    // Mirrors the ws-events.ts terminal-status handler that this PR adds:
    // cancelled children + parent Agent should propagate into the narrative
    // so the Agent row shows `errored` (SubagentRow uses tc.isComplete && tc.isError).
    const tools: ToolCall[] = [
      mkTool({
        id: "agent-x",
        toolName: "Agent",
        startedAt: 1000,
        isComplete: true,
        isError: true,
        output: "Cancelled",
      }),
      mkTool({
        id: "c1",
        toolName: "Bash",
        startedAt: 1100,
        parentToolCallId: "agent-x",
        isComplete: true,
        isError: true,
        output: "Cancelled",
      }),
    ];
    const { items } = buildNarrativeItems({
      toolCalls: tools,
      hooks: [],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    });
    const sub = items.find((i) => i.type === "subagent");
    expect(sub).toBeDefined();
    if (sub?.type === "subagent") {
      expect(sub.toolCall.isError).toBe(true);
      expect(sub.toolCall.isComplete).toBe(true);
      expect(sub.children[0]?.isError).toBe(true);
    }
  });
});
