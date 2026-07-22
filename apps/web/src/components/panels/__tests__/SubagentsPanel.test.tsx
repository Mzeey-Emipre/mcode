import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    display_name: "Implementation worker",
    input_summary: "Build the roster",
    output_summary: "Roster implementation complete",
    status: "completed",
    started_at: "2026-07-22T10:00:00.000Z",
    completed_at: "2026-07-22T10:01:00.000Z",
    sort_order: 0,
    ...overrides,
  };
}

function setThread(toolCalls: ToolCall[] = [], tools: ToolCallRecord[] = []): void {
  state.records["thread-1"] = {
    toolCalls,
    narrativeByMessage: tools.length > 0 ? { "message-1": { tools } } : {},
  };
}

describe("SubagentsPanel", () => {
  beforeEach(() => {
    state.records = {};
    useDiffStore.setState({ subagentDetailByThread: {} });
  });

  it("renders Active and Done on one continuous page without tabs", () => {
    setThread([agent()], [record({ id: "finished-agent" })]);
    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByRole("heading", { name: "Active · 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Done · 1" })).toBeInTheDocument();
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Implementation worker");
    expect(screen.getByTestId("subagent-finished-row")).toHaveTextContent("Roster implementation complete");
    expect(screen.getByTestId("subagent-finished-row")).not.toHaveTextContent("Build the roster");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("omits empty sections and shows one whole-panel empty state only when both are empty", () => {
    setThread([agent()]);
    const { rerender } = render(<SubagentsPanel threadId="thread-1" />);
    expect(screen.getByRole("heading", { name: "Active · 1" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Done/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagents-empty")).not.toBeInTheDocument();

    setThread();
    rerender(<SubagentsPanel threadId="thread-1" />);
    expect(screen.getByTestId("subagents-empty")).toHaveTextContent("Sub-agents will appear");
    expect(screen.queryByRole("heading", { name: /Active/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Done/ })).not.toBeInTheDocument();
  });

  it("renders explicit finished, errored, and cancelled statuses", () => {
    setThread([], [
      record({ id: "completed" }),
      record({ id: "failed", status: "failed", output_summary: "Command failed" }),
      record({ id: "cancelled", status: "cancelled" }),
    ]);
    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getAllByTestId("subagent-finished-row")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Open Implementation worker details, Finished/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Implementation worker details, Errored/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Implementation worker details, Cancelled/ })).toBeInTheDocument();
  });

  it("keeps legacy nameless glyphs neutral and explicit Subagent identities colored", () => {
    setThread([], [
      record({ id: "legacy", display_name: null }),
      record({ id: "explicit", display_name: "Subagent", sort_order: 1 }),
    ]);
    render(<SubagentsPanel threadId="thread-1" />);

    const rows = screen.getAllByTestId("subagent-finished-row");
    const legacyGlyph = rows[0]?.querySelector("[data-subagent-identity-glyph]");
    const explicitGlyph = rows[1]?.querySelector("[data-subagent-identity-glyph]");
    expect(legacyGlyph).not.toHaveAttribute("data-subagent-palette");
    expect(legacyGlyph).not.toHaveAttribute("style");
    expect(explicitGlyph).toHaveAttribute("data-subagent-palette");
    expect(explicitGlyph?.getAttribute("style")).toContain("--subagent-identity-color");
  });

  it("opens detail with the shared narrative and response primitives, then restores row focus", async () => {
    setThread([agent({ output: "**Done**", isComplete: true })], [
      record({ id: "child-read", parent_tool_call_id: "agent-1", tool_name: "Read", input_summary: "src/index.ts", output_summary: "read", sort_order: 1 }),
    ]);
    render(<SubagentsPanel threadId="thread-1" />);

    const row = screen.getByRole("button", { name: /Open Implementation worker details/ });
    fireEvent.click(row);
    expect(screen.getByRole("region", { name: /Implementation worker subagent details/ })).toBeInTheDocument();
    expect(screen.queryByText("Build the roster")).not.toBeInTheDocument();
    expect(screen.queryByText("Delegated task")).not.toBeInTheDocument();
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
    expect(screen.getByText("**Done**")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-response-text")).toHaveClass("text-sm", "text-foreground");

    fireEvent.click(screen.getByRole("button", { name: "Back to subagents" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open Implementation worker details/ })).toHaveFocus();
    });
  });

  it("shows hydrated truncation and bounded transcript notices", () => {
    const children = Array.from({ length: 40 }, (_, index) => record({
      id: `child-${index}`,
      parent_tool_call_id: "agent-1",
      tool_name: "Read",
      input_summary: `file-${index}.ts`,
      output_summary: "",
      sort_order: index + 1,
    }));
    setThread([], [record({ output_truncated: 1, output_total_bytes: 524_288, output_artifact_path: "C:\\artifacts\\agent-1.txt" }), ...children]);
    render(<SubagentsPanel threadId="thread-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Open Implementation worker details/ }));

    expect(screen.getByLabelText(/Output truncated · 512 KB total · full output saved/)).toHaveAttribute("title", "C:\\artifacts\\agent-1.txt");
    expect(screen.getByRole("note")).toHaveTextContent("Additional child activity was omitted");
  });
});
