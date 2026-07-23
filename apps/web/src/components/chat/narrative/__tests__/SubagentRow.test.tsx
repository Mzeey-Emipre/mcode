import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubagentRow } from "../SubagentRow";
import type { ToolCall } from "@/transport/types";
import { getSubagentIdentityPaletteIndex } from "@/components/subagents/SubagentIdentityGlyph";

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
  return render(<SubagentRow toolCall={toolCall} children={children} hooks={[]} />);
}

describe("SubagentRow", () => {
  it("shows explicit identity and Started without delegated task text", () => {
    renderRow(agent());

    expect(screen.getByRole("button", { name: "Open Explorer subagent details, Started" })).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-lifecycle-dot")).toHaveClass("bg-primary", "status-pulse");
    expect(screen.queryByText("Read detection module")).not.toBeInTheDocument();
    expect(document.querySelector('[data-subagent-identity-glyph="Explorer"]')).toBeInTheDocument();
  });

  it("keeps one identity color stable across rerenders", () => {
    const view = renderRow(agent());
    const firstPalette = document.querySelector('[data-subagent-identity-glyph="Explorer"]')?.getAttribute("data-subagent-palette");

    view.rerender(<SubagentRow toolCall={agent({ output: "Provider update" })} children={[]} hooks={[]} />);

    expect(document.querySelector('[data-subagent-identity-glyph="Explorer"]')).toHaveAttribute("data-subagent-palette", firstPalette);
  });

  it("uses the bounded identity palette across distinct agents", () => {
    const identities = ["Explorer", "Reviewer", "Implementer"];
    const paletteSlots = identities.map(getSubagentIdentityPaletteIndex);

    expect(new Set(paletteSlots).size).toBeGreaterThan(1);
    expect(paletteSlots.every((slot) => slot >= 0 && slot < 5)).toBe(true);
  });

  it("shows Update received only for non-empty running provider output", () => {
    renderRow(agent({ output: "Provider update" }));

    expect(screen.getByText("Update received")).toBeInTheDocument();
    expect(screen.queryByText("Provider update")).not.toBeInTheDocument();
  });

  it.each([
    [{ isComplete: true }, "Finished"],
    [{ isComplete: true, isError: true }, "Errored"],
    [{ isComplete: true, isCancelled: true }, "Cancelled"],
  ] as const)("renders the terminal lifecycle %s", (overrides, label) => {
    renderRow(agent(overrides));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("falls back to Subagent and never uses prompt or description as identity", () => {
    renderRow(agent({ toolInput: { prompt: "Private prompt", description: "Private task" }, isComplete: true }));

    expect(screen.getByRole("button", { name: "Open Subagent subagent details, Finished" })).toBeInTheDocument();
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
});
