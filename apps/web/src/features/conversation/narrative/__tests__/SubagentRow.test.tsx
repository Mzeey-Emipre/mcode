import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentRow } from "../SubagentRow";
import type { ToolCall } from "@/transport/types";
import { getSubagentIdentityPaletteIndex } from "@/components/ui/SubagentIdentityGlyph";
import { createSubagentPresentation } from "@mcode/contracts";

const { openSubagentDetail } = vi.hoisted(() => ({ openSubagentDetail: vi.fn() }));

function agent(overrides: Partial<ToolCall> = {}): ToolCall {
  const toolCall: ToolCall = {
    id: "agent-1",
    toolName: "Agent",
    toolInput: { agentName: "Explorer", description: "Read detection module" },
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
  return {
    ...toolCall,
    subagentPresentation: overrides.subagentPresentation
      ?? createSubagentPresentation(toolCall.toolInput, toolCall.id),
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
  beforeEach(() => {
    openSubagentDetail.mockReset();
  });

  it("shows explicit identity and exact lowercase lifecycle copy without delegated task text", () => {
    renderRow(agent());

    expect(screen.getByRole("button", { name: "Open Explorer subagent details" })).toBeInTheDocument();
    expect(screen.getByText("started working")).toBeInTheDocument();
    expect(screen.queryByTestId("subagent-lifecycle-dot")).not.toBeInTheDocument();
    expect(screen.queryByText("Read detection module")).not.toBeInTheDocument();
    expect(document.querySelector('[data-subagent-identity-glyph="Explorer"]')).toBeInTheDocument();
  });

  it("formats a provider identity as a sentence title", () => {
    renderRow(agent({ toolInput: { agentName: "direct_detail_worker" } }));

    expect(screen.getByRole("button", { name: "Open Direct detail worker subagent details" })).toBeInTheDocument();
    expect(screen.queryByText("direct_detail_worker")).not.toBeInTheDocument();
  });

  it("renders only the normalized presentation when raw provider input conflicts", () => {
    renderRow(agent({
      toolInput: { agentName: "wrong_raw_identity", prompt: "Private task" },
      subagentPresentation: {
        displayName: "Correct identity",
        hasExplicitIdentity: true,
        identityKey: "child-correct",
      },
    }));

    expect(screen.getByRole("button", { name: "Open Correct identity subagent details" })).toBeInTheDocument();
    expect(screen.queryByText("wrong_raw_identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Private task")).not.toBeInTheDocument();
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

  it.each([
    [{ isComplete: true }, "Completed"],
    [{ isComplete: true, isError: true }, "Failed"],
    [{ isComplete: true, isCancelled: true }, "Interrupted"],
  ] as const)("announces the canonical terminal status", (overrides, status) => {
    const finishedAgent = agent(overrides);
    render(<SubagentRow toolCall={finishedAgent} participants={[finishedAgent]} lifecycle="finished" children={[]} hooks={[]} onSubagentSelect={openSubagentDetail} />);
    expect(screen.getByRole("status")).toHaveTextContent(status);
  });

  it("does not infer interruption from child output text", () => {
    const finishedAgent = agent({ isComplete: true, output: "The word cancelled appears in the report." });
    render(<SubagentRow toolCall={finishedAgent} participants={[finishedAgent]} lifecycle="finished" children={[]} hooks={[]} onSubagentSelect={openSubagentDetail} />);
    expect(screen.getByRole("status")).toHaveTextContent("Completed");
  });

  it("falls back to Subagent and never uses prompt or description as identity", () => {
    const anonymousAgent = agent({ toolInput: { prompt: "Private prompt", description: "Private task" }, isComplete: true });
    render(<SubagentRow toolCall={anonymousAgent} participants={[anonymousAgent]} lifecycle="finished" children={[]} hooks={[]} onSubagentSelect={openSubagentDetail} />);

    expect(screen.getByRole("button", { name: "Open Subagent subagent details" })).toBeInTheDocument();
    expect(screen.queryByText("Private prompt")).not.toBeInTheDocument();
    expect(screen.queryByText("Private task")).not.toBeInTheDocument();
    const glyph = document.querySelector('[data-subagent-identity-glyph="Subagent"]');
    expect(glyph).toHaveAttribute(
      "data-subagent-palette",
      String(getSubagentIdentityPaletteIndex("agent-1")),
    );
    expect(glyph?.getAttribute("style")).toContain("--subagent-identity-color");
  });

  it("gives anonymous agents stable per-agent colors", () => {
    const first = agent({ id: "agent-1", toolInput: {} });
    const second = agent({ id: "agent-2", toolInput: {} });
    render(
      <SubagentRow
        toolCall={first}
        participants={[first, second]}
        lifecycle="started"
        children={[]}
        hooks={[]}
      />,
    );

    const palettes = [...document.querySelectorAll('[data-subagent-identity-glyph="Subagent"]')]
      .map((glyph) => glyph.getAttribute("data-subagent-palette"));
    expect(palettes).toEqual(["0", "4"]);
  });

  it("reserves one color and detail target for repeated turns on the same native subagent", async () => {
    const firstTurn = agent({
      id: "spawn-worker",
      toolInput: { receiverThreadIds: ["child-worker"] },
    });
    const secondTurn = agent({
      id: "follow-up-worker",
      toolInput: { receiverThreadIds: ["child-worker"] },
    });
    render(
      <SubagentRow
        toolCall={firstTurn}
        participants={[firstTurn, secondTurn]}
        lifecycle="finished"
        children={[]}
        hooks={[]}
        onSubagentSelect={openSubagentDetail}
      />,
    );

    const palettes = [...document.querySelectorAll('[data-subagent-identity-glyph="Subagent"]')]
      .map((glyph) => glyph.getAttribute("data-subagent-palette"));
    expect(palettes).toEqual([
      String(getSubagentIdentityPaletteIndex("child-worker")),
      String(getSubagentIdentityPaletteIndex("child-worker")),
    ]);

    await userEvent.click(screen.getAllByRole("button", { name: "Open Subagent subagent details" })[1]!);
    expect(openSubagentDetail).toHaveBeenLastCalledWith("child-worker", "finished");
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
    expect(openSubagentDetail).toHaveBeenNthCalledWith(1, "agent-source", "finished");
    expect(openSubagentDetail).toHaveBeenNthCalledWith(2, "agent-target", "finished");
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
    expect(rosterOpen).toHaveBeenCalledTimes(1);
    expect(rosterOpen).toHaveBeenCalledWith("active");
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

  it("opens the finished roster for a finished-only remaining group", async () => {
    const rosterOpen = vi.fn();
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
        onOpenSubagents={rosterOpen}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open full Subagents roster, +1 finished" }));
    expect(rosterOpen).toHaveBeenCalledTimes(1);
    expect(rosterOpen).toHaveBeenCalledWith("finished");
  });
});
