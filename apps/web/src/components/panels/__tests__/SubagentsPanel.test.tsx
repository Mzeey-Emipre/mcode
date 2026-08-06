import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnFileEffectSummary } from "@mcode/contracts";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useChildContinuationPrototypeStore } from "@/stores/childContinuationPrototypeStore";

const state = vi.hoisted(() => ({
  records: {} as Record<string, {
    toolCalls: ToolCall[];
    narrativeByMessage: Record<string, { tools: ToolCallRecord[] } | undefined>;
    fileEffectSummary?: TurnFileEffectSummary;
  }>,
}));

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: (threadId: string, selector: (record: unknown) => unknown) => selector({
    answeredPlanMessageIds: new Set(),
    ...(state.records[threadId] ?? { toolCalls: [], narrativeByMessage: {} }),
  }),
}));

vi.mock("../../chat/MarkdownContent", () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
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

function setThread(
  toolCalls: ToolCall[] = [],
  tools: ToolCallRecord[] = [],
  fileEffectSummary?: TurnFileEffectSummary,
): void {
  state.records["thread-1"] = {
    toolCalls,
    narrativeByMessage: tools.length > 0 ? { "message-1": { tools } } : {},
    fileEffectSummary,
  };
}

describe("SubagentsPanel", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    useChildContinuationPrototypeStore.getState().reset();
    state.records = {};
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useDiffStore.setState({ subagentDetailByThread: {}, subagentReviewScopeByThread: {} });
  });

  it("renders Active and Done on one continuous page without tabs", () => {
    setThread([agent()], [record({ id: "finished-agent" })]);
    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByRole("heading", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Implementation worker");
    expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Running");
    expect(screen.getByTestId("subagent-finished-row")).toHaveTextContent("Roster implementation complete");
    expect(screen.getByTestId("subagent-finished-row")).not.toHaveTextContent("Finished");
    expect(screen.getByTestId("subagent-finished-row").querySelector("[data-testid='subagent-lifecycle-dot']")).not.toBeInTheDocument();
    expect(screen.getByTestId("subagent-finished-row")).not.toHaveTextContent("Build the roster");
    expect(screen.getByRole("button", { name: /Open Implementation worker details, Finished/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("renders the DEV prototype roster in the real Subagents panel host", async () => {
    window.history.replaceState(null, "", "/?prototype=child-continuation");

    render(<SubagentsPanel threadId="thread-1" />);

    const panel = await screen.findByTestId("prototype-subagents-panel");
    expect(panel).toHaveTextContent("Active");
    expect(panel).toHaveTextContent("Done");
    expect(panel).toHaveTextContent("Rollback check");
    expect(panel).toHaveTextContent("Docs scan");

    fireEvent.click(screen.getByRole("button", { name: "Open Rollback check details" }));
    expect(await screen.findByRole("region", { name: "Rollback check subagent details" })).toBeInTheDocument();
    expect(await screen.findByText("I’m checking whether the index is absent.")).toBeInTheDocument();
    expect(screen.getByText("Read 1 file")).toBeInTheDocument();
    expect(screen.getByText("Running command")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Running command.*pnpm test migration\/rollback/ })).toBeInTheDocument();
    expect(screen.getByText(/1 step.*Thinking\.\.\./)).toBeInTheDocument();
    expect(screen.getByText(/^\(\d+s\)$/)).toBeInTheDocument();
    expect(screen.queryByText("Checking the down migration against the new index shape…")).not.toBeInTheDocument();
    expect(screen.queryByTestId("prototype-subagent-response-text")).not.toBeInTheDocument();
    expect(screen.queryByText("2 steps")).not.toBeInTheDocument();
    expect(screen.queryByText("12.0s")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to subagents" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Schema scan details" }));
    expect(await screen.findByRole("region", { name: "Schema scan subagent details" })).toBeInTheDocument();
    expect(await screen.findByText("I’m preparing the initial checks.")).toBeInTheDocument();
    useChildContinuationPrototypeStore.getState().advanceSchemaScan();
    expect(await screen.findByText("I’m checking the migration boundary.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to subagents" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Docs scan details" }));
    expect(await screen.findByRole("region", { name: "Docs scan subagent details" })).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.getByText("12.0s")).toBeInTheDocument();
  });

  it("omits empty sections and shows one whole-panel empty state only when both are empty", () => {
    setThread([agent()]);
    const { rerender } = render(<SubagentsPanel threadId="thread-1" />);
    expect(screen.getByRole("heading", { name: "Active" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Done/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagents-empty")).not.toBeInTheDocument();

    setThread();
    rerender(<SubagentsPanel threadId="thread-1" />);
    expect(screen.getByTestId("subagents-empty")).toHaveTextContent("Sub-agents will appear");
    expect(screen.queryByRole("heading", { name: /Active/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Done/ })).not.toBeInTheDocument();
  });

  it("keeps exceptional Done statuses visible while completed rows rely on their section", () => {
    setThread([], [
      record({ id: "completed" }),
      record({ id: "failed", status: "failed", output_summary: "Command failed", sort_order: 1 }),
      record({ id: "cancelled", status: "cancelled", sort_order: 2 }),
    ]);
    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getAllByTestId("subagent-finished-row")).toHaveLength(3);
    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
    expect(screen.getByText("Errored")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    const completedRow = screen.getByRole("button", { name: /Open Implementation worker details, Finished/ });
    const erroredRow = screen.getByRole("button", { name: /Open Implementation worker details, Errored/ });
    const cancelledRow = screen.getByRole("button", { name: /Open Implementation worker details, Cancelled/ });
    expect(completedRow.querySelector("[data-testid='subagent-lifecycle-dot']")).not.toBeInTheDocument();
    expect(erroredRow.querySelector("[data-testid='subagent-lifecycle-dot']")).toBeInTheDocument();
    expect(cancelledRow.querySelector("[data-testid='subagent-lifecycle-dot']")).toBeInTheDocument();
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
    const callerTask = await screen.findByText("Build the roster");
    expect(callerTask.closest("[data-message-role='user']")).toBeInTheDocument();
    expect(screen.queryByText("Delegated task")).not.toBeInTheDocument();
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
    expect(screen.queryByText("Finished")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Finished, ran for \d+s/ })).toBeInTheDocument();
    expect(screen.queryByTestId("subagent-lifecycle-dot")).not.toBeInTheDocument();
    expect(screen.getByText("**Done**")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-response-text")).toHaveClass("text-sm", "text-foreground");
    expect(screen.queryByRole("button", { name: "Reply to this message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fork from this message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to subagents" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open Implementation worker details/ })).toHaveFocus();
    });
  });

  it("shows running detail state through the canonical dot and accessible time group", () => {
    setThread([agent()]);
    render(<SubagentsPanel threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Open Implementation worker details/ }));

    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Running, \d+s elapsed/ })).toBeInTheDocument();
    expect(screen.getByTestId("subagent-lifecycle-dot")).toHaveClass("status-pulse");
  });

  it("shows model and reasoning metadata in running detail before output or completion", () => {
    setThread([agent({
      isComplete: false,
      output: null,
      toolInput: {
        agentName: "Implementation worker",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    })]);
    render(<SubagentsPanel threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Open Implementation worker details/ }));

    expect(screen.getByRole("group", { name: /Running, \d+s elapsed/ })).toBeInTheDocument();
    expect(screen.getByTestId("subagent-header-metadata")).toHaveTextContent("GPT-5.6 Sol · High");
    expect(screen.queryByTestId("subagent-response-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-response-byline")).not.toBeInTheDocument();
  });

  it("shows explicit metadata, exact footer counts, and opens attributed workspace diffs", () => {
    setThread([
      agent({
        isComplete: true,
        elapsedSeconds: 7,
        output: "Implemented the worker.",
        toolInput: {
          agentName: "Implementation worker",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      }),
      {
        ...agent({ id: "write-1", toolName: "Write" }),
        parentToolCallId: "agent-1",
      },
    ], [], {
      revision: 1,
      fileCount: 1,
      additions: 4,
      deletions: 1,
      effects: [{
        path: "src/worker.ts",
        kind: "edited",
        scope: "workspace",
        additions: 4,
        deletions: 1,
        binary: false,
        toolCallIds: ["write-1"],
      }],
    });
    render(<SubagentsPanel threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Open Implementation worker details/ }));

    const response = screen.getByTestId("subagent-response-text");
    const headerMetadata = screen.getByTestId("subagent-header-metadata");
    const footer = screen.getByText("1 step").closest("div")!;
    expect(headerMetadata).toHaveTextContent("GPT-5.6 Sol · High");
    expect(headerMetadata.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("subagent-response-byline")).not.toBeInTheDocument();
    expect(screen.getByText("7.0s")).toBeInTheDocument();
    expect(footer).toContainElement(screen.getByText("7.0s"));
    expect(screen.getByText("1 step")).toBeInTheDocument();
    expect(screen.getByText("1 file changed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View all diffs" }));

    expect(useDiffStore.getState().viewMode).toBe("cumulative");
    expect(useDiffStore.getState().subagentReviewScopeByThread["thread-1"]).toEqual({
      label: "Implementation worker",
      paths: ["src/worker.ts"],
      additions: 4,
      deletions: 1,
    });
  });

  it("opens grouped detail from a historical member call id, then restores focus to the visible grouped row", async () => {
    setThread([], [
      record({
        id: "explorer-first",
        provider_agent_key: "/root/explorer",
        output_summary: "Earlier result",
      }),
      record({
        id: "explorer-latest",
        provider_agent_key: "/root/explorer",
        output_summary: "Latest result",
        completed_at: "2026-07-22T10:02:00.000Z",
        sort_order: 1,
      }),
    ]);
    useDiffStore.getState().selectSubagentDetail("thread-1", {
      id: "explorer-first",
      originTab: "finished",
      scrollTop: 0,
    });

    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByRole("region", { name: /Implementation worker subagent details/ })).toBeInTheDocument();
    expect(screen.getByText("Latest result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to subagents" }));
    await waitFor(() => {
      const groupedRow = screen.getByRole("button", { name: /Open Implementation worker details/ });
      expect(groupedRow).toHaveAttribute("data-subagent-id", "explorer-latest");
      expect(groupedRow).toHaveFocus();
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
