import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentRow } from "../SubagentRow";
import type { ToolCall } from "@/transport/types";
import { getSubagentIdentityPaletteIndex } from "@/components/ui/SubagentIdentityGlyph";

const { openSubagentDetail } = vi.hoisted(() => ({ openSubagentDetail: vi.fn() }));

function agent(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "agent-1",
    toolName: "Agent",
    toolInput: { agentName: "Explorer", description: "Read detection module" },
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

function renderRow(toolCall: ToolCall, children: readonly ToolCall[] = []) {
  return render(
    <SubagentRow
      toolCall={toolCall}
      participants={[toolCall]}
      lifecycle="started"
      children={children}
      hooks={[]}
      onSubagentSelect={openSubagentDetail}
    />,
  );
}

describe("SubagentRow", () => {
  it("shows explicit identity and exact lowercase lifecycle copy without delegated task text", () => {
    renderRow(agent());

    expect(screen.getByRole("button", { name: "Open Explorer subagent details" })).toBeInTheDocument();
    expect(screen.getByText("started working")).toBeInTheDocument();
    expect(screen.queryByTestId("subagent-lifecycle-dot")).not.toBeInTheDocument();
    expect(screen.queryByText("Read detection module")).not.toBeInTheDocument();
    expect(document.querySelector('[data-subagent-identity-glyph="Explorer"]')).toBeInTheDocument();
  });

  it("keeps one identity color stable across rerenders", () => {
    const view = renderRow(agent());
    const firstPalette = document.querySelector('[data-subagent-identity-glyph="Explorer"]')?.getAttribute("data-subagent-palette");

    const updatedAgent = agent({ output: "Provider update" });
    view.rerender(<SubagentRow toolCall={updatedAgent} participants={[updatedAgent]} lifecycle="updated" children={[]} hooks={[]} onSubagentSelect={openSubagentDetail} />);

    expect(document.querySelector('[data-subagent-identity-glyph="Explorer"]')).toHaveAttribute("data-subagent-palette", firstPalette);
  });

  it("uses the bounded identity palette across distinct agents", () => {
    const identities = ["Explorer", "Reviewer", "Implementer"];
    const paletteSlots = identities.map(getSubagentIdentityPaletteIndex);

    expect(new Set(paletteSlots).size).toBeGreaterThan(1);
    expect(paletteSlots.every((slot) => slot >= 0 && slot < 5)).toBe(true);
  });

  it("shows updated without exposing provider output", () => {
    const updatedAgent = agent({ output: "Provider update" });
    render(<SubagentRow toolCall={updatedAgent} participants={[updatedAgent]} lifecycle="updated" children={[]} hooks={[]} onSubagentSelect={openSubagentDetail} />);

    expect(screen.getByText("updated")).toBeInTheDocument();
    expect(screen.queryByText("Provider update")).not.toBeInTheDocument();
  });

  it.each([{ isComplete: true }, { isComplete: true, isError: true }, { isComplete: true, isCancelled: true }] as const)(
    "uses finished for every terminal state in chat",
    (overrides) => {
      const finishedAgent = agent(overrides);
      render(<SubagentRow toolCall={finishedAgent} participants={[finishedAgent]} lifecycle="finished" children={[]} hooks={[]} onSubagentSelect={openSubagentDetail} />);
      expect(screen.getByText("finished")).toBeInTheDocument();
    },
  );

  it("falls back to Subagent and never uses prompt or description as identity", () => {
    const anonymousAgent = agent({ toolInput: { prompt: "Private prompt", description: "Private task" }, isComplete: true });
    render(<SubagentRow toolCall={anonymousAgent} participants={[anonymousAgent]} lifecycle="finished" children={[]} hooks={[]} onSubagentSelect={openSubagentDetail} />);

    expect(screen.getByRole("button", { name: "Open Subagent subagent details" })).toBeInTheDocument();
    expect(screen.queryByText("Private prompt")).not.toBeInTheDocument();
    expect(screen.queryByText("Private task")).not.toBeInTheDocument();
    const glyph = document.querySelector('[data-subagent-identity-glyph="Subagent"]');
    expect(glyph).not.toHaveAttribute("data-subagent-palette");
    expect(glyph).not.toHaveAttribute("style");
  });

  it("colors an explicitly named Subagent instead of treating the label as anonymous", () => {
    renderRow(agent({ toolInput: { agentName: "Subagent" } }));

    const glyph = document.querySelector('[data-subagent-identity-glyph="Subagent"]');
    expect(glyph).toHaveAttribute(
      "data-subagent-palette",
      String(getSubagentIdentityPaletteIndex("Subagent")),
    );
    expect(glyph?.getAttribute("style")).toContain("--subagent-identity-color");
  });

  it("keeps child calls and settled output out of chat", () => {
    const child: ToolCall = {
      id: "shell-1",
      toolName: "Shell",
      toolInput: { command: "git status --short" },
      output: " M file.ts",
      isError: false,
      isComplete: true,
      parentToolCallId: "agent-1",
    };
    renderRow(agent({ output: "Final report", isComplete: true }), [child]);

    expect(screen.queryByText("git status --short")).not.toBeInTheDocument();
    expect(screen.queryByText("M file.ts", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText("Final report")).not.toBeInTheDocument();
  });

  it("renders source and target as independent compact controls without a chevron", async () => {
    const source = agent({
      id: "agent-source",
      toolInput: { agentName: "Explorer with a deliberately long identity" },
      isComplete: true,
    });
    const target = agent({
      id: "agent-target",
      toolInput: { agentName: "Implementer" },
      isComplete: true,
    });

    const { container } = render(
      <SubagentRow
        toolCall={target}
        participants={[source, target]}
        lifecycle="finished"
        children={[]}
        hooks={[]}
        onSubagentSelect={openSubagentDetail}
      />,
    );

    const sourceButton = screen.getByRole("button", {
      name: "Open Explorer with a deliberately long identity subagent details",
    });
    const targetButton = screen.getByRole("button", {
      name: "Open Implementer subagent details",
    });
    expect(sourceButton).toHaveClass("h-8");
    expect(targetButton).toHaveClass("h-8");
    expect(sourceButton).toHaveClass("gap-1", "rounded-full", "px-2");
    expect(targetButton).toHaveClass("gap-1", "rounded-full", "px-2");
    expect(sourceButton.parentElement).toHaveClass("gap-1");
    expect(sourceButton.parentElement?.parentElement).toHaveClass("gap-2");
    expect(sourceButton).toHaveTextContent("Explorer with a deliberately long identity");
    expect(screen.getByText("finished")).toHaveClass("shrink-0");
    expect(screen.getByText("finished")).not.toHaveAttribute("role", "button");
    expect(document.querySelector('[data-subagent-identity-glyph="Implementer"]')).toHaveClass("size-4");
    expect(container.querySelector("[data-lucide='chevron-right']")).not.toBeInTheDocument();

    await userEvent.click(sourceButton);
    await userEvent.click(targetButton);
    expect(openSubagentDetail).toHaveBeenNthCalledWith(1, "agent-source");
    expect(openSubagentDetail).toHaveBeenNthCalledWith(2, "agent-target");
  });
});
