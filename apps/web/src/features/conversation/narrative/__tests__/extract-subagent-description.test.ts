import { describe, expect, it } from "vitest";
import { extractSubagentDescription } from "../extract-subagent-description";
import type { ToolCall } from "@/transport/types";

function mkAgent(partial: Partial<ToolCall>): ToolCall {
  return {
    id: "a1",
    toolName: "Agent",
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    ...partial,
  };
}

describe("extractSubagentDescription", () => {
  it("uses cursor/task description when present", () => {
    expect(
      extractSubagentDescription(
        mkAgent({
          toolInput: { description: "Glob cursor provider files" },
        }),
      ),
    ).toBe("Glob cursor provider files");
  });

  it("falls back to prompt when description is the generic Task title", () => {
    const prompt = "Read packages/providers/src/private/cursor/acp/cursor-acp-task.ts.";
    expect(
      extractSubagentDescription(
        mkAgent({
          toolInput: { description: "Subagent task", prompt },
        }),
      ),
    ).toBe(prompt);
  });

  it("keeps the prompt as the completed row label", () => {
    expect(
      extractSubagentDescription(
        mkAgent({
          isComplete: true,
          toolInput: { prompt: "Inspect the mapper tests." },
          output: "Found wait suppression coverage.\n\nDetails follow.",
        }),
      ),
    ).toBe("Inspect the mapper tests.");
  });

  it("uses completed output as a fallback when no task metadata exists", () => {
    expect(
      extractSubagentDescription(
        mkAgent({
          isComplete: true,
          output: "Found wait suppression coverage.\n\nDetails follow.",
        }),
      ),
    ).toBe("Found wait suppression coverage.");
  });

  it("shows a running placeholder while incomplete and metadata is generic", () => {
    expect(
      extractSubagentDescription(
        mkAgent({
          isComplete: false,
          toolInput: { description: "Subagent task" },
        }),
      ),
    ).toBe("Running subagent");
  });
});
