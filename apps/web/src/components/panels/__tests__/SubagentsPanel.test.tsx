import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import { useDiffStore } from "@/stores/diffStore";

const state = vi.hoisted(() => ({
  records: {} as Record<string, { toolCalls: ToolCall[]; narrativeByMessage: Record<string, { tools: ToolCallRecord[] } | undefined> }>,
}));

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: (threadId: string, selector: (record: unknown) => unknown) => selector(
    state.records[threadId] ?? { toolCalls: [], narrativeByMessage: {} },
  ),
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

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "agent-1",
    message_id: "message-1",
    parent_tool_call_id: null,
    tool_name: "Agent",
    input_summary: "Build the roster",
    output_summary: "Roster implementation complete",
    status: "completed",
    started_at: "2026-07-22T10:00:00.000Z",
    completed_at: "2026-07-22T10:01:00.000Z",
    sort_order: 0,
    ...overrides,
  };
}

function setThread(threadId: string, toolCalls: ToolCall[] = [], tools: ToolCallRecord[] = []): void {
  state.records[threadId] = {
    toolCalls,
    narrativeByMessage: tools.length > 0 ? { "message-1": { tools } } : {},
  };
}

describe("SubagentsPanel", () => {
  beforeEach(() => {
    state.records = {};
    useDiffStore.setState({ subagentRosterTabByThread: {} });
  });

  it("selects Active first while work runs and exposes rows, counts, and semantic running text", () => {
    setThread("thread-1", [agent()]);
    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByRole("tab", { name: /active 1/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /finished 0/i })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Implementation worker");
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Build the roster");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Running subagent")).toHaveClass("sr-only");
  });

  it("renders completed, failed, and cancelled rows with explicit terminal status", () => {
    setThread("thread-1", [], [
      record({ id: "completed", status: "completed" }),
      record({ id: "failed", status: "failed", output_summary: "Command failed" }),
      record({ id: "cancelled", status: "cancelled" }),
    ]);
    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByRole("tab", { name: /finished 3/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByTestId("subagent-finished-row")).toHaveLength(3);
    expect(screen.getByText("Completed")).toHaveClass("text-[var(--diff-add-strong)]");
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Command failed")).toBeInTheDocument();
  });

  it("moves a settled Agent from Active to Finished once as the persisted narrative arrives", () => {
    setThread("thread-1", [agent()]);
    const { rerender } = render(<SubagentsPanel threadId="thread-1" />);

    setThread("thread-1", [agent({ isComplete: true })], [record()]);
    rerender(<SubagentsPanel threadId="thread-1" />);
    expect(screen.getByRole("tab", { name: /active 0/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("subagents-active-empty")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /finished 1/i }));
    expect(screen.getAllByTestId("subagent-finished-row")).toHaveLength(1);
  });

  it("restores each thread's roster choice after unmount and keeps thread rows isolated", () => {
    setThread("thread-1", [], [record({ id: "thread-1-finished" })]);
    setThread("thread-2", [agent({ id: "thread-2-active", toolInput: { description: "Review thread two" } })]);
    const first = render(<SubagentsPanel threadId="thread-1" />);

    fireEvent.click(screen.getByRole("tab", { name: /active 0/i }));
    expect(screen.getByTestId("subagents-active-empty")).toBeInTheDocument();
    first.unmount();

    const second = render(<SubagentsPanel threadId="thread-2" />);
    expect(screen.getByRole("tab", { name: /active 1/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Review thread two");
    fireEvent.click(screen.getByRole("tab", { name: /finished 0/i }));
    second.unmount();

    render(<SubagentsPanel threadId="thread-1" />);
    expect(screen.getByRole("tab", { name: /active 0/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("subagents-active-empty")).toBeInTheDocument();
    expect(screen.queryByText("Review thread two")).not.toBeInTheDocument();
  });

  it("keeps a selected tab when counts change and gives each empty state distinct guidance", () => {
    setThread("thread-1");
    const { rerender } = render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByTestId("subagents-finished-empty")).toHaveTextContent("loaded conversation");
    fireEvent.click(screen.getByRole("tab", { name: /active 0/i }));
    expect(screen.getByTestId("subagents-active-empty")).toHaveTextContent("running");

    setThread("thread-1", [], [record()]);
    rerender(<SubagentsPanel threadId="thread-1" />);
    expect(screen.getByRole("tab", { name: /active 0/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("subagents-active-empty")).toBeInTheDocument();
  });

  it("supports arrow-key tab selection", () => {
    setThread("thread-1");
    render(<SubagentsPanel threadId="thread-1" />);

    const finished = screen.getByRole("tab", { name: /finished 0/i });
    fireEvent.keyDown(finished, { key: "ArrowLeft" });

    const active = screen.getByRole("tab", { name: /active 0/i });
    expect(active).toHaveFocus();
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", active.id);
  });
});
