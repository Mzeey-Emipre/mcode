import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalKill = vi.fn();
const terminalKillByThread = vi.fn();
const terminalHasChildren = vi.fn();
const terminalCreate = vi.fn();

vi.mock("@/transport", () => ({
  getTransport: () => ({
    terminalKill,
    terminalKillByThread,
    terminalHasChildren,
    terminalCreate,
  }),
}));

import { TerminalTabContent } from "../TerminalTabContent";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";

function seedTerminal(): void {
  useTerminalStore.setState({
    terminals: {
      "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "PowerShell" }],
    },
    terminalPanelByThread: {
      "thread-1": { visible: true, height: 300, activeTerminalId: "pty-1" },
    },
    ptyToThread: { "pty-1": "thread-1" },
    splitMode: true,
  });
}

function seedTwoTerminals(): void {
  useTerminalStore.setState({
    terminals: {
      "thread-1": [
        { id: "pty-1", threadId: "thread-1", label: "PowerShell" },
        { id: "pty-2", threadId: "thread-1", label: "Command Prompt" },
      ],
    },
    terminalPanelByThread: {
      "thread-1": { visible: true, height: 300, activeTerminalId: "pty-1" },
    },
    ptyToThread: { "pty-1": "thread-1", "pty-2": "thread-1" },
    splitMode: true,
  });
}

describe("TerminalTabContent process-tree close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalKill.mockResolvedValue(undefined);
    terminalKillByThread.mockResolvedValue(undefined);
    terminalCreate.mockResolvedValue({ ptyId: "new", shell: "pwsh" });
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      ptyToThread: {},
      splitMode: true,
    });
    seedTerminal();
  });

  it("closes an idle terminal without showing confirmation", async () => {
    terminalHasChildren.mockResolvedValue({ hasChildren: false });
    render(<TerminalTabContent threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Close PowerShell" }));

    await waitFor(() => expect(terminalKill).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
  });

  it("cancels an active-tree close and restores focus to its close control", async () => {
    terminalHasChildren.mockResolvedValue({ hasChildren: true });
    render(<TerminalTabContent threadId="thread-1" />);
    const close = screen.getByRole("button", { name: "Close PowerShell" });

    fireEvent.click(close);
    expect(await screen.findByText("Close PowerShell?")).toBeInTheDocument();
    expect(screen.getByText(/entire process tree/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(close).toHaveFocus());
    expect(terminalKill).not.toHaveBeenCalled();
    expect(screen.getByText("PowerShell")).toBeInTheDocument();
  });

  it("guards duplicate confirmation and removes the terminal once", async () => {
    terminalHasChildren.mockResolvedValue({ hasChildren: true });
    let resolveKill!: () => void;
    terminalKill.mockReturnValue(new Promise<void>((resolve) => { resolveKill = resolve; }));
    render(<TerminalTabContent threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Close PowerShell" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close process tree" }));
    const pending = screen.getByRole("button", { name: "Closing..." });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(terminalKill).toHaveBeenCalledOnce();

    await act(async () => resolveKill());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(terminalKill).toHaveBeenCalledOnce();
    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
  });

  it("blocks Escape and outside dismissal while termination is pending", async () => {
    terminalHasChildren.mockResolvedValue({ hasChildren: true });
    let resolveKill!: () => void;
    terminalKill.mockReturnValue(new Promise<void>((resolve) => { resolveKill = resolve; }));
    render(<TerminalTabContent threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Close PowerShell" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close process tree" }));
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]');
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop!);
    fireEvent.click(backdrop!);

    expect(dialog).toBeInTheDocument();
    expect(terminalKill).toHaveBeenCalledOnce();

    await act(async () => resolveKill());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("restores focus to the kill-all control after cancellation", async () => {
    seedTwoTerminals();
    terminalHasChildren.mockResolvedValue({ hasChildren: true });
    render(<TerminalTabContent threadId="thread-1" />);
    const killAll = screen.getByRole("button", { name: "Kill all terminals" });

    fireEvent.click(killAll);
    expect(await screen.findByText("Close 2 terminals?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(killAll).toHaveFocus());
    expect(terminalKillByThread).not.toHaveBeenCalled();
  });

  it("confirms sequential active-child terminal closes", async () => {
    seedTwoTerminals();
    terminalHasChildren.mockResolvedValue({ hasChildren: true });
    render(<TerminalTabContent threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Close PowerShell" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close process tree" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const secondClose = screen.getByRole("button", { name: "Close Command Prompt" });
    expect(secondClose).toBeEnabled();
    fireEvent.click(secondClose);
    const secondConfirm = await screen.findByRole("button", { name: "Close process tree" });
    expect(secondConfirm).toBeEnabled();
    fireEvent.click(secondConfirm);

    await waitFor(() => expect(terminalKill).toHaveBeenCalledTimes(2));
    expect(terminalKill).toHaveBeenNthCalledWith(1, "pty-1");
    expect(terminalKill).toHaveBeenNthCalledWith(2, "pty-2");
    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
  });

  it("fails closed to confirmation when descendant inspection fails", async () => {
    terminalHasChildren.mockRejectedValue(new Error("inspection unavailable"));
    render(<TerminalTabContent threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Close PowerShell" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(terminalKill).not.toHaveBeenCalled();
  });
});
