import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ActivityRail", () => ({
  ActivityRail: () => <div data-testid="activity-rail" />,
}));
vi.mock("./PanelEmptyState", () => ({
  PanelEmptyState: () => <div />,
}));
vi.mock("./ResizableRightPanel", () => ({
  ResizableRightPanel: ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
    <div data-testid={testId}>{children}</div>
  ),
}));
vi.mock("./SubagentsPanel", () => ({ SubagentsPanel: () => <div /> }));
vi.mock("./CoordinationPanel", () => ({
  CoordinationPanel: ({ workspaceId, threadId }: { workspaceId: string; threadId: string }) => (
    <div data-testid="coordination-panel-integration">{workspaceId}:{threadId}</div>
  ),
}));
vi.mock("./plan", () => ({ PlanPanel: () => <div /> }));
vi.mock("@/components/diff", () => ({ DiffPanel: () => <div /> }));
vi.mock("@/components/panels/PreviewPanel", () => ({ PreviewPanel: () => <div /> }));
vi.mock("@/components/terminal/TerminalPoolSlotContext", () => ({
  TerminalPoolSlot: () => <div data-testid="terminal-pool-slot" />,
}));
vi.mock("@/stores/previewTabsStore", () => ({
  usePreviewDisplayTabSet: () => null,
  usePreviewTabsStore: { getState: () => ({ activatePage: vi.fn(), closePage: vi.fn() }) },
}));
vi.mock("@/lib/ensure-terminal", () => ({ createTerminalForScope: vi.fn() }));
vi.mock("@/lib/right-panel-layout", () => ({ toggleRightPanelAdaptive: vi.fn() }));
vi.mock("@/transport", () => ({ getTransport: () => ({ terminalKill: vi.fn() }) }));

import { RightPanel } from "./RightPanel";
import { createRightPanelState, useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

describe("RightPanel", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: null });
    useTerminalStore.setState({ terminals: {}, terminalPanelByThread: {}, ptyToThread: {} });
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
      snapshotsByThread: {},
    });
    useUiStore.setState({ rightPanelMaximized: false });
  });

  afterEach(() => cleanup());

  it("renders an empty workspace terminal scope without an external-store snapshot warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<RightPanel />);

    expect(screen.getByTestId("right-panel")).toBeInTheDocument();
    expect(error.mock.calls.flat().join(" ")).not.toContain(
      "The result of getSnapshot should be cached",
    );
    error.mockRestore();
  });

  it("renders coordination content for an open active thread tab", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["coordination"],
          activeTab: "coordination",
        }),
      },
    });

    render(<RightPanel />);

    expect(screen.getByTestId("coordination-panel-integration")).toHaveTextContent("workspace-1:thread-1");
  });
});
