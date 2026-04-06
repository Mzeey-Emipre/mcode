import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalStore } from "@/stores/terminalStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { TerminalStatusIndicator } from "@/components/chat/TerminalStatusIndicator";

describe("TerminalStatusIndicator", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: {},
      activeTerminalId: null,
      panelVisible: false,
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
      terminals: { "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }] },
    });

    const { container } = render(<TerminalStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("shows 'Running 1 terminal' when one terminal is active", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("Running 1 terminal")).toBeInTheDocument();
  });

  it("shows 'Running 2 terminals' when two terminals are active", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [
          { id: "pty-1", threadId: "thread-1", label: "Terminal 1" },
          { id: "pty-2", threadId: "thread-1", label: "Terminal 2" },
        ],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("Running 2 terminals")).toBeInTheDocument();
  });

  it("only counts terminals for the active thread", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
        "thread-2": [
          { id: "pty-2", threadId: "thread-2", label: "Terminal 1" },
          { id: "pty-3", threadId: "thread-2", label: "Terminal 2" },
        ],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("Running 1 terminal")).toBeInTheDocument();
  });

  it("toggles terminal panel when clicked", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
      },
      panelVisible: false,
    });

    render(<TerminalStatusIndicator />);
    fireEvent.click(screen.getByRole("button"));

    expect(useTerminalStore.getState().panelVisible).toBe(true);
  });

  it("toggles panel off when clicked while panel is visible", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
      },
      panelVisible: true,
    });

    render(<TerminalStatusIndicator />);
    fireEvent.click(screen.getByRole("button"));

    expect(useTerminalStore.getState().panelVisible).toBe(false);
  });
});
