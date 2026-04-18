import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Store mocks must be declared before importing the components under test.

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeThreadId: "thread-1" })
  ),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeSubagentsByThread: { "thread-1": 2 } })
  ),
}));

vi.mock("@/stores/terminalStore", () => ({
  useTerminalStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      terminals: { "thread-1": [{ id: "pty-1" }, { id: "pty-2" }] },
      toggleTerminalPanel: vi.fn(),
    })
  ),
}));

import { AgentStatusBar } from "../AgentStatusBar";
import { StreamingIndicator } from "../StreamingIndicator";
import { TerminalStatusIndicator } from "../TerminalStatusIndicator";

describe("AgentStatusBar", () => {
  it("renders a pulse dot when subagents are active", () => {
    render(<AgentStatusBar />);
    const dot = document.querySelector(".animate-pulse");
    expect(dot).toBeInTheDocument();
  });

  it("does not use animate-shimmer-text", () => {
    render(<AgentStatusBar />);
    expect(document.querySelector(".animate-shimmer-text")).not.toBeInTheDocument();
  });

  it("shows the subagent count label", () => {
    render(<AgentStatusBar />);
    expect(screen.getByText(/2 subagents running/)).toBeInTheDocument();
  });
});

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
