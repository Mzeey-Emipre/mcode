/**
 * Regression tests for long shell-command layout in narrative tool rows.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ActiveToolRow } from "../ActiveToolRow";
import { ToolSummaryLine } from "../ToolSummaryLine";
import { buildPersistedNarrativeItems } from "../build-persisted-narrative";
import { buildToolSummaryText, isShellTool, resolveToolName } from "@/components/chat/tool-renderers/constants";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import type { ToolGroup } from "../types";

/** Long unbroken path + git add, matching real overflow reports. */
export const LONG_SHELL_COMMAND =
  'cd "C:\\Users\\cjnwo\\.mcode\\worktrees\\mcode\\feat-cursor-sub-agents-71ba0f21" && git add apps/web/src/features/conversation/narrative/SubagentRow.tsx';

const COLUMN_CLASS = "w-[480px] min-w-0 max-w-full overflow-hidden";

function makeBashCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-bash-1",
    toolName: "Bash",
    toolInput: { command: LONG_SHELL_COMMAND },
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

describe("resolveToolName", () => {
  it("maps provider shell aliases to Bash", () => {
    expect(resolveToolName("Shell")).toBe("Bash");
    expect(resolveToolName("command_execution")).toBe("Bash");
    expect(resolveToolName("Read")).toBe("Read");
  });

  it("groups shell aliases in buildToolSummaryText", () => {
    const text = buildToolSummaryText([
      { toolName: "Bash" },
      { toolName: "command_execution" },
    ]);
    expect(text).toBe("Ran 2 commands");
  });

  it("treats shell aliases as shell tools for output blocks", () => {
    expect(isShellTool("Shell")).toBe(true);
    expect(isShellTool("Read")).toBe(false);
  });
});

describe("narrative tool row layout classes", () => {
  it("ActiveToolRow renders shell commands as expandable terminal cards", () => {
    const { container } = render(
      <div className={COLUMN_CLASS}>
        <ActiveToolRow toolCall={makeBashCall()} />
      </div>,
    );

    const button = screen.getByRole("button", { name: /Running command/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTitle(LONG_SHELL_COMMAND)).toHaveClass("truncate");

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    const command = container.querySelector("code");
    expect(command?.textContent).toBe(LONG_SHELL_COMMAND);
    expect(command?.className).toContain("whitespace-pre-wrap");
    expect(command?.className).toContain("overflow-wrap");
  });

  it("ToolSummaryLine keeps shell calls nested and reveals a shell transcript", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-1",
          isComplete: true,
          output: "command output",
          durationMs: 15_000,
        }),
      ],
    };

    const { container } = render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} hasError={false} hasCancelled={false} />
      </div>,
    );

    const summary = screen.getByRole("button", { name: /Ran 1 command/ });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(summary);

    const child = screen.getByRole("button", { name: /Ran command/ });
    expect(child).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("in 15s")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Shell output" })).toBeNull();

    fireEvent.click(child);

    const detail = screen.getByTitle(LONG_SHELL_COMMAND);
    expect(detail.className).toContain("truncate");
    expect(detail.closest("li")?.className).toContain("min-w-0");
    expect(screen.getByRole("region", { name: "Shell output" })).toBeTruthy();
    expect(screen.getByText("Shell")).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toBe(LONG_SHELL_COMMAND);
    expect(screen.getByText("command output")).toBeTruthy();
  });

  it("ToolSummaryLine renders duration hydrated from a persisted shell call", () => {
    const persisted: ToolCallRecord = {
      id: "tc-persisted",
      message_id: "message-1",
      parent_tool_call_id: null,
      tool_name: "Shell",
      input_summary: JSON.stringify({ command: LONG_SHELL_COMMAND }),
      output_summary: "command output",
      status: "completed",
      started_at: "2026-05-15T10:00:00Z",
      completed_at: "2026-05-15T10:00:15Z",
      sort_order: 1,
    };
    const items = buildPersistedNarrativeItems({
      tools: [persisted],
      thoughts: [],
      hooks: [],
    });

    expect(items[0].type).toBe("tool-group");
    if (items[0].type !== "tool-group") return;

    render(
      <ToolSummaryLine group={items[0].group} hasError={false} hasCancelled={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    expect(screen.getByRole("button", { name: /Ran command/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("in 15s")).toBeTruthy();
  });

  it("ToolSummaryLine maps command_execution to terminal icon via Bash alias", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-codex",
          toolName: "command_execution",
          isComplete: true,
        }),
      ],
    };

    const { container } = render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} hasError={false} hasCancelled={false} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    expect(container.querySelector(".lucide-terminal")).toBeTruthy();
    expect(screen.getByText("Ran command")).toBeTruthy();
  });

  it("ToolSummaryLine renders cancelled status at the mono-data text size", () => {
    const group: ToolGroup = {
      calls: [makeBashCall()],
    };

    render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} hasError={false} hasCancelled />
      </div>,
    );

    for (const badge of screen.getAllByText("cancelled")) {
      expect(badge).toHaveClass("text-xs");
    }
  });

  it("does not round a sub-second shell duration up to one second", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({ isComplete: true, durationMs: 500 })],
    };

    render(<ToolSummaryLine group={group} hasError={false} hasCancelled={false} />);

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    expect(screen.getByRole("button", { name: /Ran command/ })).not.toHaveTextContent("in 1s");
  });

  it("shows cancelled for a persisted cancelled shell call", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({ isComplete: true, isCancelled: true })],
    };

    render(<ToolSummaryLine group={group} hasError={false} hasCancelled />);

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    expect(screen.getAllByText("cancelled")).toHaveLength(2);
  });

  it("normalizes older persisted Codex command summaries before display", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-persisted",
          toolName: "command_execution",
          toolInput: { _summary: JSON.stringify({ command: LONG_SHELL_COMMAND }) },
          isComplete: true,
        }),
      ],
    };

    const { container } = render(
      <ToolSummaryLine group={group} hasError={false} hasCancelled={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    expect(container.querySelector("code")?.textContent).toBe(LONG_SHELL_COMMAND);
    expect(container.textContent).not.toContain('{"command"');
  });

  it("normalizes truncated legacy Codex summaries without escaped path syntax", () => {
    const legacySummary = JSON.stringify({ command: LONG_SHELL_COMMAND }).slice(0, 80);
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-truncated-summary",
          toolName: "command_execution",
          toolInput: { _summary: legacySummary },
          isComplete: true,
        }),
      ],
    };

    const { container } = render(
      <ToolSummaryLine group={group} hasError={false} hasCancelled={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    const command = container.querySelector("code")?.textContent ?? "";
    expect(command).toMatch(/^cd "C:\\Users\\cjnwo/);
    expect(command).not.toContain("\\\\Users");
    expect(command).not.toContain('{"command"');
  });

  it("ToolSummaryLine shows truncation metadata for bounded output", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-truncated",
          output: "preview",
          isComplete: true,
          outputTruncated: true,
          outputTotalBytes: 300 * 1024,
          outputArtifactPath: "C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt",
        }),
      ],
    };

    render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} hasError={false} hasCancelled={false} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));

    const notice = screen.getByText(/Output truncated/);
    expect(notice.textContent).toContain("300 KB total");
    expect(notice.textContent).toContain("full output saved");
    expect(notice.className).toContain("text-xs");
  });

  it("shows a plain shell exit code at the bottom right of the expanded panel", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-failed",
          output: "fatal: remote failed",
          isComplete: true,
          isError: true,
          exitCode: 1,
        }),
      ],
    };

    render(
      <ToolSummaryLine group={group} hasError={true} hasCancelled={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    const child = screen.getByRole("button", { name: /Ran command/ });
    expect(child).not.toHaveTextContent("errored");
    fireEvent.click(child);

    const panel = screen.getByRole("region", { name: "Shell output" });
    const exitCode = screen.getByText("exit code 1");
    expect(panel).toContainElement(exitCode);
    expect(exitCode).toHaveClass("text-muted-foreground/70");
    expect(exitCode.closest("footer")).toHaveClass("justify-end");
  });
});
