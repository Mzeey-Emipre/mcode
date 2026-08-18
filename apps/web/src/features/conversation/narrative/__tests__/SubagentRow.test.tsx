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
    for (const lifecycle of screen.getAllByText("finished")) {
      expect(lifecycle).toHaveClass("shrink-0");
      expect(lifecycle).not.toHaveAttribute("role", "button");
    }
    expect(document.querySelector('[data-subagent-identity-glyph="Implementer"]')).toHaveClass("size-4");
    expect(container.querySelector("[data-lucide='chevron-right']")).not.toBeInTheDocument();

    await userEvent.click(sourceButton);
    await userEvent.click(targetButton);
    expect(openSubagentDetail).toHaveBeenNthCalledWith(1, "agent-source");
    expect(openSubagentDetail).toHaveBeenNthCalledWith(2, "agent-target");
  });

  it("caps sibling names at two and aggregates remaining lifecycle counts", async () => {
    const rosterOpen = vi.fn();
    const activities = [
      agent({ id: "child-a", toolInput: { agentName: "Explorer" }, isComplete: false }),
      agent({ id: "child-b", toolInput: { agentName: "Reviewer" }, isComplete: true }),
      agent({ id: "child-c", toolInput: { agentName: "Implementer" }, isComplete: false }),
      agent({ id: "child-d", toolInput: { agentName: "Tester" }, isComplete: true }),
    ].map((toolCall, index) => ({
      toolCall,
      participants: [toolCall],
      lifecycle: index === 1 || index === 3 ? "finished" as const : "updated" as const,
      children: [],
      hooks: [],
    }));

    render(
      <SubagentRow
        toolCall={activities[0]!.toolCall}
        participants={activities[0]!.participants}
        lifecycle={activities[0]!.lifecycle}
        children={[]}
        hooks={[]}
        activities={activities}
        onSubagentSelect={openSubagentDetail}
        onOpenSubagents={rosterOpen}
      />,
    );

    expect(screen.getByRole("button", { name: "Open Explorer subagent details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Reviewer subagent details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Implementer subagent details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Tester subagent details" })).not.toBeInTheDocument();
    const aggregate = screen.getByRole("button", { name: "Open full Subagents roster, +1 working, 1 finished" });
    expect(aggregate).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Explorer subagent details" })).not.toHaveTextContent("updated");

    await userEvent.click(aggregate);
    expect(rosterOpen).toHaveBeenCalledOnce();
  });

  it("keeps identity controls content-sized and permits truncation only when space is constrained", () => {
    const activities = [
      agent({ id: "child-a", toolInput: {}, isComplete: false }),
      agent({ id: "child-b", toolInput: {}, isComplete: false }),
      agent({ id: "child-c", toolInput: {}, isComplete: true }),
      agent({ id: "child-d", toolInput: {}, isComplete: true }),
    ].map((toolCall) => ({
      toolCall,
      participants: [toolCall],
      lifecycle: toolCall.isComplete ? "finished" as const : "updated" as const,
      children: [],
      hooks: [],
    }));

    render(
      <SubagentRow
        toolCall={activities[0]!.toolCall}
        participants={activities[0]!.participants}
        lifecycle={activities[0]!.lifecycle}
        children={[]}
        hooks={[]}
        activities={activities}
        onSubagentSelect={openSubagentDetail}
        onOpenSubagents={vi.fn()}
      />,
    );

    const identityButtons = screen.getAllByRole("button", { name: "Open Subagent subagent details" });
    expect(identityButtons).toHaveLength(2);
    for (const button of identityButtons) {
      expect(button).toHaveClass("shrink");
      expect(button).not.toHaveClass("flex-1");
      expect(button).not.toHaveClass("max-w-40");
      expect(button.parentElement).toHaveClass("shrink");
      expect(button.parentElement).not.toHaveClass("flex-1");
      expect(button.parentElement).not.toHaveClass("max-w-40");
    }
    expect(screen.getByRole("button", { name: "Open full Subagents roster, +2 finished" })).toHaveClass("shrink-0");
    expect(screen.getAllByText("updated")).toHaveLength(2);
  });

  it("prefixes a finished-only remaining group with plus", () => {
    const activities = [
      agent({ id: "child-a", toolInput: { agentName: "Explorer" }, isComplete: true }),
      agent({ id: "child-b", toolInput: { agentName: "Reviewer" }, isComplete: true }),
      agent({ id: "child-c", toolInput: { agentName: "Tester" }, isComplete: true }),
    ].map((toolCall) => ({
      toolCall,
      participants: [toolCall],
      lifecycle: "finished" as const,
      children: [],
      hooks: [],
    }));

    render(
      <SubagentRow
        toolCall={activities[0]!.toolCall}
        participants={activities[0]!.participants}
        lifecycle="finished"
        children={[]}
        hooks={[]}
        activities={activities}
        onOpenSubagents={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Open full Subagents roster, +1 finished" })).toBeInTheDocument();
  });
});
