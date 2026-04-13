import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalStore } from "@/stores/terminalStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { TerminalStatusIndicator } from "@/components/chat/TerminalStatusIndicator";

describe("TerminalStatusIndicator", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
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

  it("shows '1 active terminal' when one terminal is active", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("1 active terminal")).toBeInTheDocument();
  });

  it("shows '2 active terminals' when two terminals are active", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [
          { id: "pty-1", threadId: "thread-1", label: "Terminal 1" },
          { id: "pty-2", threadId: "thread-1", label: "Terminal 2" },
        ],
      },
    });

    render(<TerminalStatusIndicator />);
    expect(screen.getByText("2 active terminals")).toBeInTheDocument();
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
    expect(screen.getByText("1 active terminal")).toBeInTheDocument();
  });

  it("toggles terminal panel when clicked", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
      },
      terminalPanelByThread: { "thread-1": { visible: false, height: 300, activeTerminalId: null } },
    });

    render(<TerminalStatusIndicator />);
    fireEvent.click(screen.getByRole("button"));

    expect(useTerminalStore.getState().terminalPanelByThread["thread-1"]?.visible).toBe(true);
  });

  it("toggles panel off when clicked while panel is visible", () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
      },
      terminalPanelByThread: { "thread-1": { visible: true, height: 300, activeTerminalId: null } },
    });

    render(<TerminalStatusIndicator />);
    fireEvent.click(screen.getByRole("button"));

    expect(useTerminalStore.getState().terminalPanelByThread["thread-1"]?.visible).toBe(false);
  });
});
