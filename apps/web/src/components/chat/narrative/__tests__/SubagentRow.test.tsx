import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows truncation metadata for bounded subagent output", () => {
    render(
      <SubagentRow
        toolCall={mkAgent({
          output: "preview",
          outputTruncated: true,
          outputTotalBytes: 512 * 1024,
          outputArtifactPath: "C:\\mcode\\artifacts\\tool-output\\thread\\agent.txt",
        })}
        children={[]}
        hooks={[]}
      />,
    );

    expect(screen.getByText(/Output truncated/).textContent).toContain("512 KB total");
  });

  it("keeps shell calls nested under a subagent and expands their transcript", () => {
    const child: ToolCall = {
      id: "shell-1",
      toolName: "Shell",
      toolInput: { command: "git status --short" },
      output: " M file.ts",
      isError: false,
      isComplete: true,
      durationMs: 2_000,
      startedAt: 1,
      parentToolCallId: "agent-1",
    };

    render(<SubagentRow toolCall={mkAgent({})} children={[child]} hooks={[]} />);

    const parent = screen.getByRole("button", { name: /Read detection module/ });
    fireEvent.click(parent);

    const command = screen.getByRole("button", { name: /Ran command/ });
    expect(command).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Shell output" })).toBeNull();

    fireEvent.click(command);

    expect(screen.getByRole("region", { name: "Shell output" })).toBeTruthy();
    expect(screen.getAllByText("git status --short")).toHaveLength(2);
    expect(screen.getByText("M file.ts", { exact: false })).toBeTruthy();
  });
});
