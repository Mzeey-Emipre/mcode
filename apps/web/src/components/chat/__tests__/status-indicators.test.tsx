import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Store mocks must be declared before importing the components under test.

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeThreadId: "thread-1" })
  ),
}));

vi.mock("@/features/terminal", () => ({
  useTerminalStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      terminals: { "thread-1": [{ id: "pty-1" }, { id: "pty-2" }] },
      toggleTerminalPanel: vi.fn(),
    })
  ),
}));

import { StreamingIndicator } from "../StreamingIndicator";
import { TerminalStatusIndicator } from "../TerminalStatusIndicator";

describe("StreamingIndicator", () => {
  it("renders a pulse dot while streaming", () => {
    render(<StreamingIndicator startTime={Date.now()} />);
    const dot = document.querySelector(".animate-pulse");
    expect(dot).toBeInTheDocument();
  });

  it("does not use animate-shimmer-text", () => {
    render(<StreamingIndicator startTime={Date.now()} />);
    expect(document.querySelector(".animate-shimmer-text")).not.toBeInTheDocument();
  });

  it("shows a phase label", () => {
    render(<StreamingIndicator startTime={Date.now()} />);
    // No active tool calls => default "Thinking..." label
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });
});

describe("TerminalStatusIndicator", () => {
  it("renders a pulse dot when terminals are active", () => {
    render(<TerminalStatusIndicator />);
    const dot = document.querySelector(".animate-pulse");
    expect(dot).toBeInTheDocument();
  });

  it("does not use animate-shimmer-text", () => {
    render(<TerminalStatusIndicator />);
    expect(document.querySelector(".animate-shimmer-text")).not.toBeInTheDocument();
  });

  it("shows the terminal count label", () => {
    render(<TerminalStatusIndicator />);
    expect(screen.getByText(/2 active terminals/)).toBeInTheDocument();
  });
});
