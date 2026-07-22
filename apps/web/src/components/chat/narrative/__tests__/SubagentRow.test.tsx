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
  it("renders a compact identity-first completed control", () => {
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
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open Glob cursor provider files subagent details, Completed/ })).toBeTruthy();
  });

  it("keeps child activity out of the compact narrative control", () => {
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

    expect(screen.getByRole("button", { name: /subagent details, Completed/ })).toBeTruthy();
    expect(screen.queryByText("x.ts")).toBeNull();
  });

  it("keeps settled output in the detail panel", () => {
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
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.queryByText("Mapper tests cover wait suppression.")).toBeNull();
  });

  it("keeps truncation metadata in the detail panel", () => {
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

    expect(screen.queryByText(/Output truncated/)).toBeNull();
  });

  it("does not inline nested shell transcripts", () => {
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

    expect(screen.getByRole("button", { name: /Read detection module subagent details/ })).toBeTruthy();
    expect(screen.queryByText("git status --short")).toBeNull();
    expect(screen.queryByText("M file.ts", { exact: false })).toBeNull();
  });
});
