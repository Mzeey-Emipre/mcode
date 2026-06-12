import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubagentRow } from "../SubagentRow";
import type { ToolCall } from "@/transport/types";

function mkAgent(partial: Partial<ToolCall>): ToolCall {
  return {
    id: "agent-1",
    toolName: "Agent",
    toolInput: { description: "Read detection module" },
    output: null,
    isError: false,
    isComplete: true,
    startedAt: 0,
    parentToolCallId: undefined,
    ...partial,
  };
}

describe("SubagentRow", () => {
  it("renders a flat row without expand control when there are no child tools", () => {
    render(
      <SubagentRow
        toolCall={mkAgent({
          toolInput: {
            description: "Glob cursor provider files",
            model: "composer-2.5-fast",
            subagentType: { custom: { unspecified: {} } },
          },
        })}
        children={[]}
        hooks={[]}
      />,
    );

    expect(screen.getByText("Glob cursor provider files")).toBeTruthy();
    expect(screen.getByText("Task")).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("renders an expandable control when child tools exist", () => {
    const child: ToolCall = {
      id: "read-1",
      toolName: "Read",
      toolInput: { file_path: "/x.ts" },
      output: null,
      isError: false,
      isComplete: true,
      startedAt: 1,
      parentToolCallId: "agent-1",
    };

    render(
      <SubagentRow toolCall={mkAgent({})} children={[child]} hooks={[]} />,
    );

    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("renders completed subagent output while keeping the task prompt as the label", () => {
    render(
      <SubagentRow
        toolCall={mkAgent({
          toolInput: { prompt: "Inspect the Codex mapper tests." },
          output: "Mapper tests cover wait suppression.",
          isComplete: true,
        })}
        children={[]}
        hooks={[]}
      />,
    );

    expect(screen.getByRole("button")).toBeTruthy();
    expect(screen.getByText("Inspect the Codex mapper tests.")).toBeTruthy();
    expect(screen.getByTestId("subagent-result").textContent).toContain(
      "Mapper tests cover wait suppression.",
    );
  });
});
