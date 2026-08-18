import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookExecutionRecord, ToolCallRecord } from "@/transport/types";

const recordsByThread = vi.hoisted(() => new Map<string, { narrativeByMessage: Record<string, { tools: ToolCallRecord[]; thoughts: []; hooks: HookExecutionRecord[] }> }>());
const loadNarrativeForMessage = vi.hoisted(() => vi.fn());

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: (threadId: string | null | undefined, selector: (record: unknown) => unknown) => selector(
    recordsByThread.get(threadId ?? "") ?? { narrativeByMessage: {} },
  ),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: (selector: (state: unknown) => unknown) => selector({ loadNarrativeForMessage }),
}));

vi.mock("../NarrativeRows", () => ({
  NarrativeRows: ({
    items,
    onSubagentSelect,
  }: {
    items: readonly { type: string; toolCall?: { id: string } }[];
    onSubagentSelect?: (id: string, target: "active" | "finished") => void;
  }) => (
    <>
      <div data-testid="persisted-row-ids">
        {items
          .filter((item) => item.type === "subagent")
          .map((item) => item.toolCall?.id)
          .join(",")}
      </div>
      <button type="button" onClick={() => onSubagentSelect?.("child-tool", "finished")}>Open child</button>
    </>
  ),
}));

vi.mock("../TurnFooter", () => ({
  TurnFooter: ({ counts }: { counts: { steps: number; subagents: number } }) => (
    <div data-testid="persisted-footer-steps" data-subagents={counts.subagents}>{counts.steps}</div>
  ),
}));

vi.mock("../HookRow", () => ({
  HookRow: ({ hook }: { hook: { hookName: string } }) => <div data-testid="persisted-hook-name">{hook.hookName}</div>,
}));

import { PersistedNarrative } from "../PersistedNarrative";
import { PersistedTurnFooter } from "../PersistedTurnFooter";
import { PersistedLateHooks } from "../../messages/PersistedLateHooks";

function tool(id: string, toolName = "Read"): ToolCallRecord {
  return {
    id,
    message_id: "assistant-1",
    parent_tool_call_id: null,
    tool_name: toolName,
    input_summary: "",
    output_summary: "",
    status: "completed",
    started_at: "2026-08-18T10:00:00.000Z",
    completed_at: "2026-08-18T10:00:01.000Z",
    sort_order: 1,
  };
}

function stopHook(hookName: string): HookExecutionRecord {
  return {
    id: `${hookName}-id`,
    message_id: "assistant-1",
    hook_name: hookName,
    tool_name: null,
    phase: "stop",
    payload: "{}",
    duration_ms: 1,
    did_block: false,
    started_at: "2026-08-18T10:00:01.000Z",
    ended_at: "2026-08-18T10:00:01.001Z",
    sort_order: 2,
  };
}

describe("persisted child timeline thread selection", () => {
  beforeEach(() => {
    recordsByThread.clear();
    loadNarrativeForMessage.mockReset();
    recordsByThread.set("parent-thread", {
      narrativeByMessage: {
        "assistant-1": { tools: [tool("parent-tool"), tool("parent-agent", "Agent")], thoughts: [], hooks: [stopHook("ParentStop")] },
      },
    });
    recordsByThread.set("child-thread", {
      narrativeByMessage: {
        "assistant-1": { tools: [tool("child-tool", "Agent")], thoughts: [], hooks: [stopHook("ChildStop")] },
      },
    });
  });

  it("reads persisted narrative and footer records from the explicitly rendered child thread", () => {
    render(
      <>
        <PersistedNarrative threadId="child-thread" messageId="assistant-1" messageContent="Child result" />
        <PersistedTurnFooter threadId="child-thread" messageId="assistant-1" />
        <PersistedLateHooks threadId="child-thread" messageId="assistant-1" />
      </>,
    );

    expect(screen.getByTestId("persisted-row-ids")).toHaveTextContent("child-tool");
    expect(screen.getByTestId("persisted-row-ids")).not.toHaveTextContent("parent-agent");
    expect(screen.getByTestId("persisted-footer-steps")).toHaveTextContent("1");
    expect(screen.getByTestId("persisted-hook-name")).toHaveTextContent("ChildStop");
    expect(screen.getByTestId("persisted-hook-name")).not.toHaveTextContent("ParentStop");
    expect(loadNarrativeForMessage).not.toHaveBeenCalled();
  });

  it("loads missing records into the explicitly rendered child thread", () => {
    recordsByThread.delete("child-thread");

    render(
      <>
        <PersistedNarrative threadId="child-thread" messageId="assistant-1" messageContent="Child result" />
        <PersistedTurnFooter threadId="child-thread" messageId="assistant-1" />
      </>,
    );

    expect(loadNarrativeForMessage).toHaveBeenCalledTimes(2);
    expect(loadNarrativeForMessage).toHaveBeenCalledWith("assistant-1", "child-thread");
    expect(loadNarrativeForMessage).not.toHaveBeenCalledWith("assistant-1", "parent-thread");
  });

  it("renders a canonical footer without loading legacy narrative records", () => {
    recordsByThread.delete("child-thread");

    render(
      <PersistedTurnFooter
        threadId="child-thread"
        messageId="assistant-1"
        summary={{
          counts: { steps: 2, thoughts: 1, subagents: 1 },
          durationMs: 2_500,
        }}
      />,
    );

    expect(screen.getByTestId("persisted-footer-steps")).toHaveTextContent("2");
    expect(screen.getByTestId("persisted-footer-steps")).toHaveAttribute("data-subagents", "1");
    expect(loadNarrativeForMessage).not.toHaveBeenCalled();
  });

  it("renders the elapsed time for a completed canonical turn without tools", () => {
    recordsByThread.delete("child-thread");

    render(
      <PersistedTurnFooter
        threadId="child-thread"
        messageId="assistant-1"
        summary={{
          counts: { steps: 0, thoughts: 0, subagents: 0 },
          durationMs: 2_500,
        }}
      />,
    );

    expect(screen.getByTestId("persisted-footer-steps")).toHaveTextContent("0");
    expect(loadNarrativeForMessage).not.toHaveBeenCalled();
  });

  it("routes persisted subagent rows through the chat detail callback", () => {
    const onSubagentSelect = vi.fn();

    render(
      <PersistedNarrative
        threadId="child-thread"
        messageId="assistant-1"
        messageContent="Child result"
        onSubagentSelect={onSubagentSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));

    expect(onSubagentSelect).toHaveBeenCalledWith("child-tool", "finished");
  });
});
