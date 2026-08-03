import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { activatePreviewPage, previewTabSet, previewTabsBridge } = vi.hoisted(() => ({
  activatePreviewPage: vi.fn(),
  previewTabSet: { current: null as {
    threadId: string;
    activeTabId: string | null;
    tabs: Array<{
      id: string;
      threadId: string;
      title: string | null;
      url: string | null;
      faviconUrl: string | null;
      warm: boolean;
      active: boolean;
    }>;
  } | null },
  previewTabsBridge: {
    list: vi.fn(),
    onUpdated: vi.fn(),
    updatedListener: { current: null as ((payload: unknown) => void) | null },
  },
}));

vi.mock("./ActivityRail", () => ({
  ActivityRail: ({ tabInstances, activeTabId }: { tabInstances: Array<{ type: string }>; activeTabId: string | null }) => (
    <div data-testid="activity-rail" data-open-tabs={tabInstances.map((instance) => instance.type).join(",")} data-active-tab-id={activeTabId} />
  ),
}));
vi.mock("./PanelEmptyState", () => ({
  PanelEmptyState: () => <div data-testid="panel-empty-state" />,
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
vi.mock("@/components/panels/PreviewPanel", () => ({ PreviewPanel: () => <div data-testid="preview-panel" /> }));
vi.mock("@/components/terminal/TerminalPoolSlotContext", () => ({
  TerminalPoolSlot: () => <div data-testid="terminal-pool-slot" />,
}));
vi.mock("@/stores/previewTabsStore", () => ({
  usePreviewDisplayTabSet: () => previewTabSet.current,
  usePreviewTabsStore: {
    getState: () => ({
      activatePage: activatePreviewPage,
      closePage: vi.fn(),
      setTabSet: (_scopeId: string, tabSet: typeof previewTabSet.current) => {
        previewTabSet.current = tabSet;
      },
    }),
  },
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
    previewTabSet.current = null;
    activatePreviewPage.mockReset();
    previewTabsBridge.list.mockReset();
    previewTabsBridge.list.mockResolvedValue({ ok: true, data: null });
    previewTabsBridge.updatedListener.current = null;
    previewTabsBridge.onUpdated.mockReset();
    previewTabsBridge.onUpdated.mockImplementation((listener: (payload: unknown) => void) => {
      previewTabsBridge.updatedListener.current = listener;
      return vi.fn();
    });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        preview: {
          tabs: {
            list: previewTabsBridge.list,
            onUpdated: previewTabsBridge.onUpdated,
          },
        },
      },
    });
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

  it("reveals an existing Browser page when the user opens an empty hidden panel", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Background page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };

    render(<RightPanel />);
    expect(useDiffStore.getState().getRightPanelVisible("workspace-1")).toBe(false);
    expect(useDiffStore.getState().getRightPanel("workspace-1").openTabs).toEqual([]);

    act(() => useDiffStore.getState().showRightPanel("workspace-1"));

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "preview");
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: ["preview"],
      activeTab: "preview",
    });
    expect(activatePreviewPage).toHaveBeenCalledWith("workspace-1", "browser-tab-1");
  });

  it("reveals a Browser page that is published after the empty panel opens", () => {
    const { rerender } = render(<RightPanel />);

    act(() => useDiffStore.getState().showRightPanel("workspace-1"));
    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();

    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Background page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    rerender(<RightPanel />);

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: ["preview"],
      activeTab: "preview",
    });
    expect(activatePreviewPage).toHaveBeenCalledWith("workspace-1", "browser-tab-1");
  });

  it("subscribes while empty so an Electron-created Browser page replaces the default screen", async () => {
    const { rerender } = render(<RightPanel />);

    act(() => useDiffStore.getState().showRightPanel("workspace-1"));
    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();

    await waitFor(() => expect(previewTabsBridge.updatedListener.current).toBeTypeOf("function"));
    act(() => {
      previewTabsBridge.updatedListener.current?.({
        threadId: "workspace-1",
        activeTabId: "browser-tab-1",
        tabs: [{
          id: "browser-tab-1",
          threadId: "workspace-1",
          title: "Agent page",
          url: "https://example.test",
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      });
    });
    rerender(<RightPanel />);

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
  });

  it("replaces an already-visible default screen when Electron publishes a Browser page", async () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: [],
        }),
      },
    });
    const { rerender } = render(<RightPanel />);
    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();

    await waitFor(() => expect(previewTabsBridge.updatedListener.current).toBeTypeOf("function"));
    act(() => {
      previewTabsBridge.updatedListener.current?.({
        threadId: "workspace-1",
        activeTabId: "browser-tab-1",
        tabs: [{
          id: "browser-tab-1",
          threadId: "workspace-1",
          title: "Agent page",
          url: "https://example.test",
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      });
    });
    rerender(<RightPanel />);

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
  });

  it("does not let a background Browser page alter an existing active panel tab", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Background page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["changes"],
          activeTab: "changes",
        }),
      },
    });

    render(<RightPanel />);

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "changes");
    expect(useDiffStore.getState().getRightPanel("workspace-1").activeTab).toBe("changes");
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });
});
