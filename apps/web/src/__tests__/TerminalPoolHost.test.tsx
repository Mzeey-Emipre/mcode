import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalPool = vi.hoisted(() => ({
  slot: null as HTMLDivElement | null,
  setActiveTerminal: vi.fn(),
}));

vi.mock("@/components/terminal/TerminalPoolSlotContext", () => ({
  useTerminalPoolSlot: () => ({
    slotEl: terminalPool.slot,
    offScreenEl: terminalPool.slot,
  }),
}));

vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: ({ shellLabel }: { readonly shellLabel?: string }) => (
    <div data-shell-label={shellLabel} data-testid="terminal-view" />
  ),
  loadXtermModules: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/terminal/safeFit", () => ({
  isContainerReadyForFit: () => false,
}));

vi.mock("@/components/terminal/terminalPoolRefit", () => ({
  dispatchTerminalPoolRefit: vi.fn(),
}));

vi.mock("@/components/terminal/resolveActiveTerminalId", () => ({
  resolveActiveTerminalId: () => "pty-1",
}));

vi.mock("@/components/terminal/ptyDataRegistry", () => ({
  onPtyExit: () => () => {},
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: { activeThreadId: string; activeWorkspaceId: string; threads: readonly []; workspaces: readonly [] }) => unknown) =>
      selector({
        activeThreadId: "thread-1",
        activeWorkspaceId: "workspace-1",
        threads: [],
        workspaces: [],
      }),
    {
      getState: () => ({
        activeThreadId: "thread-1",
        activeWorkspaceId: "workspace-1",
        threads: [],
        workspaces: [],
      }),
    },
  ),
}));

vi.mock("@/stores/diffStore", () => ({
  useDiffStore: (selector: (state: { getRightPanel: () => { visible: boolean; activeTab: string; openTabs: readonly string[] } }) => unknown) =>
    selector({
      getRightPanel: () => ({
        visible: true,
        activeTab: "terminal",
        openTabs: ["terminal"],
      }),
    }),
}));

vi.mock("@/stores/terminalStore", () => {
  const state = {
    terminals: {
      "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "pwsh" }],
    },
    terminalPanelByThread: {
      "thread-1": { visible: true, height: 300, activeTerminalId: "pty-1" },
    },
    setActiveTerminal: terminalPool.setActiveTerminal,
    removeTerminal: vi.fn(),
  };
  return {
    TERMINAL_PANEL_DEFAULTS: { visible: false, height: 300, activeTerminalId: null },
    useTerminalStore: Object.assign(
      (selector: (store: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

import { TerminalPoolHost } from "@/components/terminal/TerminalPoolHost";

describe("TerminalPoolHost", () => {
  beforeEach(() => {
    terminalPool.slot = document.createElement("div");
    document.body.append(terminalPool.slot);
  });

  afterEach(() => {
    cleanup();
    terminalPool.slot?.remove();
    terminalPool.slot = null;
  });

  it("passes the active shell identity to the terminal renderer", () => {
    render(<TerminalPoolHost />);

    expect(screen.getByTestId("terminal-view")).toHaveAttribute(
      "data-shell-label",
      "pwsh",
    );
  });
});
