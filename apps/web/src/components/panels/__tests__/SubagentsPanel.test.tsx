import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@/transport/types";

const state = vi.hoisted(() => ({ toolCalls: [] as ToolCall[] }));

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: () => state.toolCalls,
}));

import { SubagentsPanel } from "../SubagentsPanel";

function agent(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "agent-1",
    toolName: "Agent",
    toolInput: { agentName: "Implementation worker", description: "Build the roster" },
    output: null,
    isError: false,
    isComplete: false,
    startedAt: Date.now() - 5_000,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("SubagentsPanel", () => {
  it("selects Active first while work runs and exposes rows, counts, and semantic running text", () => {
    state.toolCalls = [agent()];
    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByRole("tab", { name: /active 1/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /finished 0/i })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Implementation worker");
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Build the roster");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Running subagent")).toHaveClass("sr-only");
  });

  it("selects Finished first without active work and keeps a manual Finished choice as counts change", () => {
    state.toolCalls = [agent({ isComplete: true })];
    const { rerender } = render(<SubagentsPanel threadId="thread-1" />);

    const active = screen.getByRole("tab", { name: /active 0/i });
    const finished = screen.getByRole("tab", { name: /finished 1/i });
    expect(finished).toHaveAttribute("aria-selected", "true");

    fireEvent.click(active);
    fireEvent.click(finished);
    state.toolCalls = [agent(), agent({ id: "agent-2", toolInput: { description: "Review accessibility" } })];
    rerender(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByRole("tab", { name: /finished 0/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("subagents-finished-placeholder")).toBeInTheDocument();
  });

  it("supports arrow-key tab selection and shows the active empty state", () => {
    state.toolCalls = [];
    render(<SubagentsPanel threadId="thread-1" />);

    const finished = screen.getByRole("tab", { name: /finished 0/i });
    fireEvent.keyDown(finished, { key: "ArrowLeft" });

    const active = screen.getByRole("tab", { name: /active 0/i });
    expect(active).toHaveFocus();
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("subagents-active-empty")).toHaveTextContent("No sub-agents are running.");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", active.id);
  });
});
