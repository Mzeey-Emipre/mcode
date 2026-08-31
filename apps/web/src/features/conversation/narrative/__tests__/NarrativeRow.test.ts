import { describe, expect, it } from "vitest";
import type { HookExecution, ToolCall } from "@/transport/types";
import type { NarrativeItem } from "../types";
import {
  areNarrativeRowPropsEqual,
  type NarrativeRowProps,
} from "../NarrativeRow";

const toolCall: ToolCall = {
  id: "tool-1",
  toolName: "Read",
  toolInput: { path: "README.md" },
  output: null,
  isError: false,
  isComplete: true,
};

const hook: HookExecution = {
  hookName: "PreToolUse",
  hookType: "permission",
  status: "completed",
  outputLines: [],
  fullOutput: [],
  startedAt: 1,
};

function props(item: NarrativeItem): NarrativeRowProps {
  return { rowId: "row-1", item, allToolCalls: [toolCall] };
}

describe("areNarrativeRowPropsEqual", () => {
  it("keeps stable thought, tool, hook, sub-agent, and response rows isolated", () => {
    const segment = { text: "thinking", startedAt: 1 };
    const stablePairs: Array<[NarrativeItem, NarrativeItem]> = [
      [
        { type: "thought", segment, isActive: false },
        { type: "thought", segment, isActive: false },
      ],
      [
        { type: "tool-group", group: { calls: [toolCall] }, hasError: false, hasCancelled: false },
        { type: "tool-group", group: { calls: [toolCall] }, hasError: false, hasCancelled: false },
      ],
      [
        { type: "hook", hook },
        { type: "hook", hook },
      ],
      [
        { type: "subagent", lifecycle: "started", toolCall, participants: [toolCall], children: [], hooks: [] },
        { type: "subagent", lifecycle: "started", toolCall, participants: [toolCall], children: [], hooks: [] },
      ],
      [
        { type: "active-tool", toolCall },
        { type: "active-tool", toolCall },
      ],
      [
        { type: "delta", text: "response" },
        { type: "delta", text: "response" },
      ],
    ];

    for (const [left, right] of stablePairs) {
      expect(areNarrativeRowPropsEqual(props(left), props(right))).toBe(true);
    }
  });

  it("updates only a row whose visible state changed", () => {
    const original = { type: "thought", segment: { text: "before", startedAt: 1 }, isActive: false } as const;
    const changed = { type: "thought", segment: { text: "after", startedAt: 1 }, isActive: false } as const;

    expect(areNarrativeRowPropsEqual(props(original), props(changed))).toBe(false);
  });

  it("rerenders when the item type changes but ignores the retained full-turn graph", () => {
    const thought: NarrativeItem = {
      type: "thought",
      segment: { text: "thinking", startedAt: 1 },
      isActive: false,
    };
    const delta: NarrativeItem = { type: "delta", text: "thinking" };

    expect(areNarrativeRowPropsEqual(props(thought), props(delta))).toBe(false);
    expect(areNarrativeRowPropsEqual(
      props(thought),
      { ...props(thought), allToolCalls: [] },
    )).toBe(true);
  });
});
