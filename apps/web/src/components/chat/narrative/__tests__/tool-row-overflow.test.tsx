/**
 * Regression tests for long shell-command layout in narrative tool rows.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ActiveToolRow } from "../ActiveToolRow";
import { ToolSummaryLine } from "../ToolSummaryLine";
import { buildToolSummaryText, isShellTool, resolveToolName } from "../../tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import type { ToolGroup } from "../types";

/** Long unbroken path + git add, matching real overflow reports. */
export const LONG_SHELL_COMMAND =
  'cd "C:\\Users\\cjnwo\\.mcode\\worktrees\\mcode\\feat-cursor-sub-agents-71ba0f21" && git add apps/web/src/components/chat/narrative/SubagentRow.tsx';

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
  it("ActiveToolRow applies constrained flex row and title tooltip on detail", () => {
    render(
      <div className={COLUMN_CLASS}>
        <ActiveToolRow toolCall={makeBashCall()} />
      </div>,
    );

    const detail = screen.getByTitle(LONG_SHELL_COMMAND);
    const row = detail.parentElement;
    expect(row?.className).toContain("min-w-0");
    expect(row?.className).toContain("overflow-hidden");
    expect(detail.className).toContain("truncate");
    expect(detail.className).toContain("overflow-wrap");
  });

  it("ToolSummaryLine expanded rows use constrained flex layout", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({ id: "tc-1", isComplete: true })],
    };

    render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} hasError={false} hasCancelled={false} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    const detail = screen.getByTitle(LONG_SHELL_COMMAND);
    expect(detail.className).toContain("truncate");
    expect(detail.closest("li")?.className).toContain("min-w-0");
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

    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector(".lucide-terminal")).toBeTruthy();
    expect(screen.getByText("Ran command")).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText(/Output truncated/).textContent).toContain("300 KB total");
    expect(screen.getByText(/Output truncated/).textContent).toContain("full output saved");
  });
});
