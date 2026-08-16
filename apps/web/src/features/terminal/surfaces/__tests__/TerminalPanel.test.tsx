import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub the transport before TerminalPanel imports it. Storing on globalThis
// keeps the mock observable from the test body without tripping hoisting.
const terminalKillByThread = vi.fn().mockResolvedValue(undefined);
const terminalKill = vi.fn().mockResolvedValue(undefined);
const terminalCreate = vi.fn().mockResolvedValue({ ptyId: "pty-new", shell: "pwsh" });
const terminalHasChildren = vi.fn().mockResolvedValue({ hasChildren: false });

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => ({
      terminalKillByThread,
      terminalKill,
      terminalCreate,
      terminalHasChildren,
    }),
  };
});

// TerminalView pulls in xterm and dynamic addon imports. We don't need its
// behaviour here — the toolbar action is what we're verifying.
vi.mock("../TerminalView", () => ({
  TerminalView: () => null,
}));

import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { TerminalPanel } from "../TerminalPanel";

describe("TerminalPanel", () => {
  beforeEach(() => {
    terminalKillByThread.mockClear();
    terminalKill.mockClear();
    terminalCreate.mockClear();
    terminalHasChildren.mockClear();
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      splitMode: false,
    });
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
  });

  // Regression guard for issue #303: clicking the bin button must kill the
  // PTY processes AND collapse the panel (previously left an empty panel open).
  it("hides the panel after closing all terminals via the bin button", async () => {
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "Terminal 1" }],
      },
      terminalPanelByThread: {
        "thread-1": { visible: true, height: 300, activeTerminalId: "pty-1" },
      },
    });

    render(<TerminalPanel />);

    const bin = screen.getByRole("button", { name: /kill all terminals/i });
    fireEvent.click(bin);

    await waitFor(() => {
      expect(terminalHasChildren).toHaveBeenCalledWith("pty-1");
      expect(terminalKillByThread).toHaveBeenCalledWith("thread-1");
    });

    const panel = useTerminalStore.getState().terminalPanelByThread["thread-1"];
    expect(panel?.visible).toBe(false);
    // Height is preserved so the next open restores the previous size.
    expect(panel?.height).toBe(300);
  });
});
