import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Mock tool-renderers to avoid pulling in the full renderer tree
vi.mock("../tool-renderers", () => ({
  getRenderer: vi.fn(() => {
    const NoopRenderer = ({ toolCall }: { toolCall: { id: string }; isActive?: boolean }) => (
      <div data-testid={`renderer-${toolCall.id}`} />
    );
    return NoopRenderer;
  }),
}));

import { ToolCallWrapper } from "../tool-renderers/ToolCallWrapper";
import { ToolCallCard } from "../ToolCallCard";
import { Terminal } from "lucide-react";
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

describe("ToolCallWrapper — border-l stripe removal", () => {
  it("does not use border-l when active", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive />,
    );
    expect(container.firstElementChild?.className).not.toContain("border-l");
  });

  it("does not use glow-primary when active", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive />,
    );
    expect(container.firstElementChild?.className).not.toContain("glow-primary");
  });

  it("uses bg-primary fill when active", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive />,
    );
    expect(container.firstElementChild?.className).toContain("bg-primary");
  });

  it("does not use border-l when inactive", () => {
    const { container } = render(
      <ToolCallWrapper icon={Terminal} label="Running command" isActive={false} />,
    );
    expect(container.firstElementChild?.className).not.toContain("border-l");
  });
});

describe("ToolCallCard CollapsedGroup — border-l stripe removal", () => {
  // Two identical non-Agent calls collapse into a CollapsedGroup
  const calls: ToolCall[] = [
    makeToolCall({ id: "tc-1", isComplete: false }),
    makeToolCall({ id: "tc-2", isComplete: false }),
  ];

  it("does not use border-l on the active CollapsedGroup wrapper", () => {
    const { container } = render(<ToolCallCard toolCalls={calls} isLive />);
    const wrappers = container.querySelectorAll("[class]");
    wrappers.forEach((el) => {
      // Only check outer wrapper divs (direct children of the list)
      if (el.parentElement === container.firstElementChild) {
        expect(el.className).not.toContain("border-l");
      }
    });
  });

  it("does not use glow-primary on the active CollapsedGroup wrapper", () => {
    const { container } = render(<ToolCallCard toolCalls={calls} isLive />);
    const wrappers = container.querySelectorAll("[class]");
    wrappers.forEach((el) => {
      if (el.parentElement === container.firstElementChild) {
        expect(el.className).not.toContain("glow-primary");
      }
    });
  });
});

describe("ToolCallCard LiveAgentGroup — border-l stripe removal", () => {
  const agentCall: ToolCall = makeToolCall({
    id: "agent-1",
    toolName: "Agent",
    toolInput: { description: "Searching codebase" },
    isComplete: false,
  });

  it("does not use border-l on the LiveAgentGroup wrapper", () => {
    const { container } = render(<ToolCallCard toolCalls={[agentCall]} isLive />);
    const wrappers = container.querySelectorAll("[class]");
    wrappers.forEach((el) => {
      if (el.parentElement === container.firstElementChild) {
        expect(el.className).not.toContain("border-l");
      }
    });
  });
});
