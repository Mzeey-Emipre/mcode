import { describe, it, expect } from "vitest";
import { buildNarrativeItems } from "../build-narrative";
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
