import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "workspace-1";
const { transport, workspaceState } = vi.hoisted(() => ({
  transport: {
    terminalCreate: vi.fn(),
    terminalKill: vi.fn().mockResolvedValue(undefined),
  },
  workspaceState: {
    threads: [],
    workspaces: [{ id: "workspace-1" }],
  },
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));
vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => workspaceState },
}));

import { useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { createTerminalForScope } from "./ensure-terminal";

const ERROR_ATTRIBUTE = "data-terminal-release-test-bootstrap-error";

function setReleaseTestEnabled(enabled: boolean): void {
  (window as unknown as Record<string, unknown>).desktopBridge = enabled
    ? { terminalReleaseTest: { enabled: true } }
    : {};
}

describe("createTerminalForScope release-test diagnostics", () => {
  beforeEach(() => {
    transport.terminalCreate.mockReset();
    transport.terminalKill.mockClear();
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
    });
    useTerminalStore.setState({
      terminals: {},
      terminalPanelByThread: {},
      ptyToThread: {},
      terminalSearchByPty: {},
    });
    document.documentElement.removeAttribute(ERROR_ATTRIBUTE);
    setReleaseTestEnabled(true);
    useDiffStore.getState().showRightPanel(WORKSPACE_ID);
  });

  it("surfaces a bounded message for an asynchronous release-test failure", async () => {
    const detail = "async failure ".repeat(100);
    transport.terminalCreate.mockRejectedValueOnce(new Error(detail));

    createTerminalForScope(WORKSPACE_ID);

    await vi.waitFor(() => {
      const message = document.documentElement.getAttribute(ERROR_ATTRIBUTE);
      expect(message).toBe(
        `Terminal creation failed: ${detail}`.slice(0, 512),
      );
      expect(message?.length).toBeLessThanOrEqual(512);
    });
  });

  it("surfaces a message for a synchronous release-test failure", async () => {
    transport.terminalCreate.mockImplementationOnce(() => {
      throw new Error("sync failure");
    });

    createTerminalForScope(WORKSPACE_ID);

    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(ERROR_ATTRIBUTE)).toBe(
        "Terminal creation failed: sync failure",
      );
    });
  });

  it("does not expose a rejection in normal mode", async () => {
    setReleaseTestEnabled(false);
    transport.terminalCreate.mockRejectedValueOnce(new Error("normal failure"));

    createTerminalForScope(WORKSPACE_ID);

    await vi.waitFor(() => expect(transport.terminalCreate).toHaveBeenCalledOnce());
    expect(document.documentElement).not.toHaveAttribute(ERROR_ATTRIBUTE);
  });

  it("clears a prior release-test error after accepting terminal creation", async () => {
    document.documentElement.setAttribute(ERROR_ATTRIBUTE, "old failure");
    transport.terminalCreate.mockResolvedValueOnce({
      ptyId: "pty-1",
      shell: "pwsh",
    });

    createTerminalForScope(WORKSPACE_ID);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().terminals[WORKSPACE_ID]).toEqual([
        {
          id: "pty-1",
          threadId: WORKSPACE_ID,
          label: "pwsh",
          state: "running",
        },
      ]);
      expect(
        useDiffStore.getState().getRightPanel(WORKSPACE_ID).openTabs,
      ).toEqual(["terminal"]);
      expect(document.documentElement).not.toHaveAttribute(ERROR_ATTRIBUTE);
    });
  });
});
