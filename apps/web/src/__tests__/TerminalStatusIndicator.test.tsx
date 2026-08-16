import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { TerminalStatusIndicator } from "@/components/chat/TerminalStatusIndicator";

const executeCommandMock = vi.fn((_id: string) => true);

vi.mock("@/lib/command-registry", () => ({
  executeCommand: (id: string) => executeCommandMock(id),
}));

describe("TerminalStatusIndicator", () => {
  beforeEach(() => {
    executeCommandMock.mockClear();
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      ptyToThread: {},
      splitMode: false,
    });
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
    });
  });

  it("renders nothing when no terminals exist for the active thread", () => {
    const { container } = render(<TerminalStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is no active thread", () => {
    useWorkspaceStore.setState({ activeThreadId: null });
    useTerminalStore.setState({
      terminals: { "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "pwsh" }] },
    });

    const { container } = render(<TerminalStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("shows '1 active terminal' when one terminal is active", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "pwsh" }],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("1 active terminal")).toBeInTheDocument();
  });

  it("shows '2 active terminals' when two terminals are active", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [
          { id: "pty-1", threadId: "thread-1", label: "pwsh" },
          { id: "pty-2", threadId: "thread-1", label: "cmd" },
        ],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("2 active terminals")).toBeInTheDocument();
  });

  it("only counts terminals for the active thread", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "pwsh" }],
        "thread-2": [
          { id: "pty-2", threadId: "thread-2", label: "pwsh" },
          { id: "pty-3", threadId: "thread-2", label: "cmd" },
        ],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("1 active terminal")).toBeInTheDocument();
  });

  it("invokes terminal.toggle when clicked", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "pwsh" }],
      },
    });

    render(<TerminalStatusIndicator />);
    fireEvent.click(screen.getByRole("button"));

    expect(executeCommandMock).toHaveBeenCalledWith("terminal.toggle");
  });
});
