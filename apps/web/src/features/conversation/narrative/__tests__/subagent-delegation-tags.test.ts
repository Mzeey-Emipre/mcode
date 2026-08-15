import { describe, expect, it } from "vitest";
import { buildDelegationTags } from "../subagent-delegation-tags";
import type { ToolCall } from "@/transport/types";

function mkAgent(partial: Partial<ToolCall>): ToolCall {
  return {
    id: "agent-1",
    toolName: "Agent",
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    startedAt: 0,
    parentToolCallId: undefined,
    ...partial,
  };
}

describe("buildDelegationTags", () => {
  it("includes Task and formatted model from cursor/task toolInput", () => {
    const tags = buildDelegationTags(
      mkAgent({
        toolInput: {
          description: "Glob files",
          model: "composer-2.5-fast",
          subagentType: { custom: { unspecified: {} } },
        },
      }),
    );
    expect(tags).toContain("Task");
    expect(tags).toContain("Composer 2.5 Fast");
  });

  it("skips whitespace-only model labels", () => {
    const tags = buildDelegationTags(mkAgent({ toolInput: { model: "   " } }));
    expect(tags).toEqual([]);
  });

  it("does not include duration tags", () => {
    const tags = buildDelegationTags(
      mkAgent({
        isComplete: true,
        output: "Glob files",
        toolInput: { model: "composer-2.5-fast", durationMs: 8300 },
      }),
    );
    expect(tags).toEqual(["Composer 2.5 Fast"]);
    expect(tags).not.toContain("8.3s");
  });

  it("includes Codex kind, model, and reasoning effort metadata", () => {
    const tags = buildDelegationTags(
      mkAgent({
        toolInput: {
          codexCollabKind: "spawnAgent",
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
      }),
    );

    expect(tags).toEqual(["Spawn agent", "GPT-5.5", "High effort"]);
  });
});
