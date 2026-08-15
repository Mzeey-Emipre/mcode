import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import { ActiveToolRow } from "../ActiveToolRow";
import { buildPersistedNarrativeItems } from "../build-persisted-narrative";
import { ToolSummaryLine } from "../ToolSummaryLine";

function browserCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "browser-1",
    toolName: "mcp__mcode-browser__browser_act",
    toolInput: {
      observationRef: "SECRET_OBSERVATION",
      steps: [
        { operation: "click", target: { accessibleName: "SECRET_BUTTON" } },
        { operation: "type", text: "SECRET_TYPED_VALUE" },
      ],
    },
    output: JSON.stringify({
      operation: "act",
      outcome: "completed",
      effect: "complete",
      recovery: "inspect",
      receipts: [
        { index: 0, operation: "click", status: "applied", message: "SECRET_RESULT" },
        { index: 1, operation: "type", status: "applied" },
      ],
      finalObservation: { visibleText: "SECRET_PAGE_BODY" },
    }),
    isError: false,
    isComplete: true,
    ...overrides,
  };
}

function editCall(): ToolCall {
  return {
    id: "edit-1",
    toolName: "Edit",
    toolInput: { file_path: "src/checkout.tsx" },
    output: null,
    isError: false,
    isComplete: true,
  };
}

describe("BrowserActivityRow", () => {
  it("renders the accepted grouped summary and chronological safe details", () => {
    const { container } = render(
      <ToolSummaryLine
        group={{ calls: [browserCall(), editCall()] }}
        hasError={false}
        hasCancelled={false}
      />,
    );

    const summary = screen.getByRole("button", { name: /Used the browser, edited a file/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(summary);

    expect(screen.getByText("Clicked the page")).toBeTruthy();
    expect(screen.getByText("Entered text")).toBeTruthy();
    expect(screen.getByText("Edited file")).toBeTruthy();
    expect(container.textContent).not.toContain("SECRET");

    const action = screen.getByRole("button", { name: "Clicked the page" });
    expect(action).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(action);

    expect(action).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Plain text")).toHaveLength(2);
    expect(screen.getAllByText(/MCP server: mcode-browser/)).toHaveLength(2);
    expect(screen.getAllByText(/MCP tool: browser_act/)).toHaveLength(2);
    expect(container.textContent).not.toContain("mcp__mcode-browser");
  });

  it("uses the quiet active summary without exposing Browser input", () => {
    const { container } = render(
      <ActiveToolRow toolCall={browserCall({ output: null, isComplete: false })} />,
    );

    const summary = screen.getByRole("button", { name: "Using the browser" });
    expect(summary.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(summary);

    expect(screen.getByText("Clicking the page")).toBeTruthy();
    expect(screen.getByText("Entering text")).toBeTruthy();
    expect(container.textContent).not.toContain("SECRET");
  });

  it("renders user takeover as a Browser outcome instead of a generic error", () => {
    render(
      <ToolSummaryLine
        group={{
          calls: [browserCall({
            output: JSON.stringify({
              operation: "act",
              outcome: "interrupted",
              effect: "partial",
              recovery: "yield_to_user",
              receipts: [{ index: 0, operation: "click", status: "interrupted" }],
            }),
          })],
        }}
        hasError={false}
        hasCancelled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Used the browser" }));
    expect(screen.getByText("Stopped when you took control")).toBeTruthy();
    expect(screen.queryByText("cancelled")).toBeNull();
  });

  it("renders allowlisted recovery meaning without the raw Browser error", () => {
    const { container } = render(
      <ToolSummaryLine
        group={{
          calls: [browserCall({
            output: JSON.stringify({
              code: "STALE_TARGET_GENERATION",
              message: "SECRET_PAGE_DETAILS",
              recovery: "inspect",
            }),
            isError: true,
          })],
        }}
        hasError
        hasCancelled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Used the browser" }));
    expect(screen.getByText("Page changed before the action")).toBeTruthy();
    expect(container.textContent).not.toContain("SECRET");
    expect(screen.queryByText("errored")).toBeNull();
  });

  it("renders a nested Browser failure as failed instead of completed", () => {
    const { container } = render(
      <ToolSummaryLine
        group={{
          calls: [browserCall({
            output: JSON.stringify({
              ok: false,
              error: {
                code: "UNSUPPORTED_OPERATION",
                effect: "none",
                recovery: "inspect",
                message: "SECRET_DETAILS",
              },
            }),
            isError: false,
          })],
        }}
        hasError={false}
        hasCancelled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Used the browser" }));
    expect(screen.getByText("Browser action failed")).toBeTruthy();
    expect(screen.queryByText("Completed Browser actions")).toBeNull();
    expect(container.textContent).not.toContain("SECRET");
  });

  it("renders a cancelled Browser call with no output as cancelled instead of completed", () => {
    render(
      <ToolSummaryLine
        group={{
          calls: [browserCall({ output: null, isCancelled: true })],
        }}
        hasError={false}
        hasCancelled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Used the browser" }));
    expect(screen.getByText("Browser action cancelled")).toBeTruthy();
    expect(screen.queryByText("Completed Browser actions")).toBeNull();
  });

  it("restores persisted Browser input and receipt meaning", () => {
    const record: ToolCallRecord = {
      id: "browser-persisted",
      message_id: "message-1",
      parent_tool_call_id: null,
      tool_name: "mcp__mcode-browser__browser_act",
      input_summary: JSON.stringify({
        operation: "browser_act",
        steps: [{ operation: "resize", width: 390, height: 844 }],
      }),
      output_summary: JSON.stringify({
        operation: "browser_act",
        outcome: "completed",
        effect: "complete",
        recovery: "inspect",
        receipts: [{ index: 0, operation: "resize", status: "applied" }],
      }),
      status: "completed",
      started_at: "2026-08-04T10:00:00Z",
      completed_at: "2026-08-04T10:00:01Z",
      sort_order: 1,
    };
    const items = buildPersistedNarrativeItems({ tools: [record], thoughts: [], hooks: [] });
    expect(items[0]?.type).toBe("tool-group");
    if (items[0]?.type !== "tool-group") return;

    render(<ToolSummaryLine group={items[0].group} hasError={false} hasCancelled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Used the browser" }));
    expect(screen.getByText("Resized the Browser to 390 × 844")).toBeTruthy();
  });
});
