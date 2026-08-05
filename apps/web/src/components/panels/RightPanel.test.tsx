import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { activatePreviewPage, closePreviewPage, previewTabSet, previewTabsBridge } = vi.hoisted(() => ({
  activatePreviewPage: vi.fn(),
  closePreviewPage: vi.fn(),
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
  ActivityRail: ({
    tabInstances,
    activeTabId,
    onCloseBrowserPage,
  }: {
    tabInstances: Array<{ type: string }>;
    activeTabId: string | null;
    onCloseBrowserPage?: (pageId: string) => void;
  }) => (
    <div data-testid="activity-rail" data-open-tabs={tabInstances.map((instance) => instance.type).join(",")} data-active-tab-id={activeTabId}>
      {tabInstances.some((instance) => instance.type === "preview") && onCloseBrowserPage && (
        <button type="button" data-testid="close-browser-page" onClick={() => onCloseBrowserPage("browser-tab-1")} />
      )}
    </div>
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
      closePage: closePreviewPage,
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
import { useBrowserAutomationStore } from "@/stores/browserAutomationStore";

describe("RightPanel", () => {
  beforeEach(() => {
    previewTabSet.current = null;
    activatePreviewPage.mockReset();
    closePreviewPage.mockReset();
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
    useBrowserAutomationStore.setState({
      activeRequests: new Map(),
      lifecycleTabs: new Map(),
      liveTargets: new Map(),
      pendingAgentOpens: new Map(),
    });
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

  it("keeps an idle existing Browser page behind the default panel screen", () => {
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

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "");
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: [],
    });
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("restores an explicitly retained Browser tab when the hidden panel had no active instance", () => {
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
          visible: false,
          width: 400,
          tabInstances: [{ id: "singleton:preview", type: "preview" }],
          activeTabId: null,
        }),
      },
    });
    render(<RightPanel />);
    act(() => useDiffStore.getState().showRightPanel("workspace-1"));

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: ["preview"],
      activeTab: "preview",
    });
    expect(activatePreviewPage).toHaveBeenCalledWith("workspace-1", "browser-tab-1");
  });

  it("reveals an agent-created page while its Browser bootstrap is pending", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "default-browser-tab",
      tabs: [
        {
          id: "default-browser-tab",
          threadId: "workspace-1",
          title: "New page",
          url: null,
          faviconUrl: null,
          warm: true,
          active: true,
        },
        {
          id: "agent-browser-tab",
          threadId: "workspace-1",
          title: "Agent page",
          url: "https://example.test",
          faviconUrl: null,
          warm: true,
          active: false,
        },
      ],
    };
    useBrowserAutomationStore.setState({
      pendingAgentOpens: new Map([
        [
          "pending-browser-open",
          {
            workspaceId: "workspace-1",
            threadId: "workspace-1",
            tabId: "agent-browser-tab",
            url: "https://example.test",
            startedAt: 2,
          },
        ],
      ]),
    });

    render(<RightPanel />);
    act(() => useDiffStore.getState().showRightPanel("workspace-1"));

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "preview");
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(activatePreviewPage).toHaveBeenCalledWith("workspace-1", "agent-browser-tab");
  });

  it("does not re-open Browser while the final page close callback is synchronous", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Closing page",
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
          openTabs: ["preview"],
          activeTab: "preview",
        }),
      },
    });
    closePreviewPage.mockImplementation((
      _scopeId: string,
      _tabId: string,
      options: { onLastClose?: () => void },
    ) => {
      previewTabSet.current = null;
      options.onLastClose?.();
    });

    render(<RightPanel />);
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("close-browser-page"));

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1").openTabs).toEqual([]);
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("keeps a closed Browser scope warm while its active request settles", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Busy page",
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
          openTabs: ["preview"],
          activeTab: "preview",
        }),
      },
    });
    useBrowserAutomationStore.setState({
      activeRequests: new Map([
        [
          "active-browser-request",
          {
            dispatch: { target: { threadId: "workspace-1", tabId: "browser-tab-1" } },
            startedAt: 2,
          } as never,
        ],
      ]),
    });
    closePreviewPage.mockImplementation((
      _scopeId: string,
      _tabId: string,
      options: { onLastClose?: () => void },
    ) => {
      previewTabSet.current = null;
      options.onLastClose?.();
    });

    render(<RightPanel />);
    fireEvent.click(screen.getByTestId("close-browser-page"));

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(screen.getByTestId("preview-panel").parentElement).toHaveClass("hidden");

    act(() => useBrowserAutomationStore.setState({ activeRequests: new Map() }));

    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
  });

  it("keeps an ordinary host-published Browser page behind the default screen", () => {
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

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: [],
    });
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("does not reveal an ordinary Electron-created Browser page from a host update", async () => {
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

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("keeps an already-visible default screen after ordinary Electron publication", async () => {
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

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(activatePreviewPage).not.toHaveBeenCalled();
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
