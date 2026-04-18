import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Mock tool-renderers to avoid pulling in the full renderer tree
vi.mock("../tool-renderers", () => ({
  getRenderer: vi.fn(() => {
    // Return a minimal no-op renderer component
    const NoopRenderer = ({ toolCall }: { toolCall: { id: string }; isActive?: boolean }) => (
      <div data-testid={`renderer-${toolCall.id}`} />
    );
    return NoopRenderer;
  }),
}));

import { ToolCallWrapper } from "../tool-renderers/ToolCallWrapper";
import { ToolCallCard } from "../ToolCallCard";
import { FileText } from "lucide-react";
import type { ToolCall } from "@/transport/types";

/** Builds a minimal ToolCall fixture. */
function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-1",
    toolName: "ReadFile",
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

describe("ToolCallWrapper active state", () => {
  it("does not use animate-shimmer-text when active", () => {
    render(<ToolCallWrapper icon={FileText} label="Reading file" isActive />);
    expect(document.querySelector(".animate-shimmer-text")).not.toBeInTheDocument();
  });

  it("applies text-foreground and font-medium to the label when active", () => {
    render(<ToolCallWrapper icon={FileText} label="Reading file" isActive />);
    const label = screen.getByText("Reading file");
    expect(label.className).toContain("text-foreground");
    expect(label.className).toContain("font-medium");
  });

  it("applies text-foreground/70 to the label when inactive", () => {
    render(<ToolCallWrapper icon={FileText} label="Reading file" isActive={false} />);
    const label = screen.getByText("Reading file");
    expect(label.className).toContain("text-foreground/70");
  });
});

describe("ToolCallCard CollapsedGroup active state", () => {
  it("does not use animate-shimmer-text in a live collapsed group", () => {
    // Two identical tool calls collapse into a CollapsedGroup
    const calls: ToolCall[] = [
      makeToolCall({ id: "tc-1", isComplete: false }),
      makeToolCall({ id: "tc-2", isComplete: false }),
    ];
    render(<ToolCallCard toolCalls={calls} isLive />);
    expect(document.querySelector(".animate-shimmer-text")).not.toBeInTheDocument();
  });

  it("applies text-foreground font-medium to the group label when active", () => {
    const calls: ToolCall[] = [
      makeToolCall({ id: "tc-1", isComplete: false }),
      makeToolCall({ id: "tc-2", isComplete: false }),
    ];
    render(<ToolCallCard toolCalls={calls} isLive />);
    // CollapsedGroup renders TOOL_LABELS[toolName] ?? toolName
    const label = screen.getByText("ReadFile");
    expect(label.className).toContain("text-foreground");
    expect(label.className).toContain("font-medium");
  });
});

describe("ToolCallCard LiveAgentGroup active state", () => {
  it("does not use animate-shimmer-text in an active LiveAgentGroup", () => {
    const agentCall: ToolCall = makeToolCall({
      id: "agent-1",
      toolName: "Agent",
      toolInput: { description: "Searching codebase" },
      isComplete: false,
    });
    render(<ToolCallCard toolCalls={[agentCall]} isLive />);
    expect(document.querySelector(".animate-shimmer-text")).not.toBeInTheDocument();
  });

  it("applies text-foreground font-medium to the agent description when active", () => {
    const agentCall: ToolCall = makeToolCall({
      id: "agent-1",
      toolName: "Agent",
      toolInput: { description: "Searching codebase" },
      isComplete: false,
    });
    render(<ToolCallCard toolCalls={[agentCall]} isLive />);
    const label = screen.getByText("Searching codebase");
    expect(label.className).toContain("text-foreground");
    expect(label.className).toContain("font-medium");
  });
});
