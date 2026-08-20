import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  activatePreviewPage,
  closePreviewPage,
  previewPanelRender,
  previewTabSet,
  previewTabsBridge,
} = vi.hoisted(() => ({
  activatePreviewPage: vi.fn(),
  closePreviewPage: vi.fn(),
  previewPanelRender: vi.fn(),
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
  ACTIVITY_RAIL_FLOATING_OVERLAP_PX: 112,
  ActivityRail: ({
    tabInstances,
    activeTabId,
    terminalLabels,
    onCloseBrowserPage,
    onExpandedChange,
    onTogglePanel,
  }: {
    tabInstances: Array<{ type: string }>;
    activeTabId: string | null;
    terminalLabels?: Record<string, string>;
    onCloseBrowserPage?: (pageId: string) => void;
    onExpandedChange?: (expanded: boolean) => void;
    onTogglePanel?: () => void;
  }) => (
    <div
      data-testid="activity-rail"
      data-open-tabs={tabInstances.map((instance) => instance.type).join(",")}
      data-active-tab-id={activeTabId}
      data-terminal-labels={JSON.stringify(terminalLabels ?? {})}
    >
      <button type="button" data-testid="expand-activity-rail" onClick={() => onExpandedChange?.(true)} />
      <button type="button" data-testid="toggle-right-panel" onClick={onTogglePanel} />
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
  ResizableRightPanel: ({
    children,
    inert,
    testId,
    ...props
  }: {
    children: React.ReactNode;
    inert?: boolean;
    testId?: string;
    "aria-hidden"?: boolean;
    "data-right-panel-root"?: string;
  }) => (
    <div
      data-testid={testId}
      aria-hidden={props["aria-hidden"]}
      data-right-panel-root={props["data-right-panel-root"]}
      inert={inert ? true : undefined}
    >
      {children}
    </div>
  ),
}));
vi.mock("@/features/subagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/subagents")>()),
  SubagentsPanel: () => <div />,
}));
vi.mock("./CoordinationPanel", () => ({
  CoordinationPanel: ({ workspaceId, threadId }: { workspaceId: string; threadId: string }) => (
    <div data-testid="coordination-panel-integration">{workspaceId}:{threadId}</div>
  ),
}));
vi.mock("./plan", () => ({ PlanPanel: () => <div /> }));
vi.mock("@/components/diff", () => ({ DiffPanel: () => <div /> }));
vi.mock("@/features/preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/preview")>()),
  PreviewPanel: (props: Record<string, unknown>) => {
    previewPanelRender(props);
    return <div data-testid="preview-panel" data-covered-left={props.coveredLeft ?? 0} />;
  },
}));
vi.mock("@/features/terminal/surfaces/TerminalPoolSlotContext", () => ({
  TerminalPoolSlot: () => <div data-testid="terminal-pool-slot" />,
}));
vi.mock("@/features/preview/state/previewTabsStore", () => ({
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

import { reconcileWarmPreviewScopes, RightPanel } from "./RightPanel";
import { createRightPanelState, useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  browserAutomationScopeKey,
  browserSurfacePresentationCoordinator,
  useBrowserAutomationStore,
} from "@/features/preview";

describe("RightPanel", () => {
  beforeEach(() => {
    previewTabSet.current = null;
    activatePreviewPage.mockReset();
    closePreviewPage.mockReset();
    previewPanelRender.mockReset();
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
      hostedScopeIds: new Set(),
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

  it("projects workspace panel state without Terminal instances when switching to an untouched thread", () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 520,
          tabInstances: [
            { id: "singleton:changes", type: "changes" },
            { id: "terminal:workspace-pty-1", type: "terminal" },
            { id: "singleton:preview", type: "preview" },
            { id: "terminal:workspace-pty-2", type: "terminal" },
          ],
          activeTabId: "singleton:changes",
        }),
      },
    });
    useTerminalStore.setState({
      terminals: {
        "workspace-1": [
          { id: "workspace-pty-1", threadId: "workspace-1", label: "Build shell" },
          { id: "workspace-pty-2", threadId: "workspace-1", label: "Test shell" },
        ],
      },
    });

    const { rerender } = render(<RightPanel />);

    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-open-tabs",
      "changes,terminal,preview,terminal",
    );
    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-terminal-labels",
      JSON.stringify({
        "terminal:workspace-pty-1": "Build shell",
        "terminal:workspace-pty-2": "Test shell",
      }),
    );

    act(() => useWorkspaceStore.setState({ activeThreadId: "thread-untouched" }));
    rerender(<RightPanel />);

    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-open-tabs",
      "changes,preview",
    );
    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-active-tab-id",
      "singleton:changes",
    );
    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-terminal-labels",
      "{}",
    );
  });

  it("preserves warm-scope identity when reconciliation changes nothing", () => {
    const scopes = [{ scopeId: "workspace-1", workspaceId: "workspace-1", lastUsedAt: 1 }];

    expect(reconcileWarmPreviewScopes(scopes, scopes[0]!, new Set())).toBe(scopes);
  });

  it("keeps equal scope ids from different workspaces as distinct warm surfaces", () => {
    const first = { scopeId: "shared-scope", workspaceId: "workspace-a", lastUsedAt: 1 };
    const second = { scopeId: "shared-scope", workspaceId: "workspace-b", lastUsedAt: 2 };

    expect(reconcileWarmPreviewScopes([first], second, new Set())).toEqual([second, first]);
  });

  it("releases focus before making the right panel inert", () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({ visible: true, width: 400 }),
      },
    });
    render(<RightPanel />);
    const toggle = screen.getByTestId("toggle-right-panel");
    toggle.focus();
    expect(toggle).toHaveFocus();

    act(() => useDiffStore.getState().hideRightPanel("workspace-1"));

    expect(toggle).not.toHaveFocus();
    expect(screen.getByTestId("right-panel")).toHaveAttribute("inert");
    expect(screen.getByTestId("right-panel")).not.toHaveAttribute("aria-hidden");
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
    expect(activatePreviewPage).not.toHaveBeenCalled();
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
    expect(activatePreviewPage).toHaveBeenCalledWith(
      "workspace-1",
      "workspace-1",
      "agent-browser-tab",
    );
  });

  it("switches an already-open panel to an agent-created Browser page", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "existing-browser-tab",
      tabs: [
        {
          id: "existing-browser-tab",
          threadId: "workspace-1",
          title: "Existing page",
          url: "https://existing.example.test",
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
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["tasks"],
          activeTab: "tasks",
        }),
      },
    });
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

    const { rerender } = render(<RightPanel />);

    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-open-tabs",
      "tasks,preview",
    );
    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-active-tab-id",
      "singleton:preview",
    );
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      openTabs: ["tasks", "preview"],
      activeTab: "preview",
    });
    expect(activatePreviewPage).toHaveBeenCalledWith(
      "workspace-1",
      "workspace-1",
      "agent-browser-tab",
    );

    rerender(<RightPanel />);

    expect(activatePreviewPage).toHaveBeenCalledTimes(1);
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
      _workspaceId: string,
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

  it("covers the visible Browser edge without changing its layout geometry", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Visible page",
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

    render(<RightPanel />);
    expect(screen.getByTestId("preview-panel")).toHaveAttribute(
      "data-covered-left",
      "0",
    );

    fireEvent.click(screen.getByTestId("expand-activity-rail"));

    expect(browserSurfacePresentationCoordinator.getActivityRailOverlap()).toBe(112);
  });

  it("publishes the covered edge on the automation Browser dock", async () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Visible page",
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
      hostedScopeIds: new Set([browserAutomationScopeKey("workspace-1", "workspace-1")]),
    });

    render(<RightPanel />);
    await waitFor(() => expect(screen.queryByTestId("automation-preview-dock")).not.toBeNull());
    const dock = screen.getByTestId("automation-preview-dock");
    expect(dock).not.toBeNull();
    expect(browserSurfacePresentationCoordinator.getActivityRailOverlap()).toBe(0);

    fireEvent.click(screen.getByTestId("expand-activity-rail"));

    await waitFor(() => expect(browserSurfacePresentationCoordinator.getActivityRailOverlap()).toBe(112));
  });

  it("does not render the active Browser surface for another scope's request", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Visible page",
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
    render(<RightPanel />);
    const renderCount = previewPanelRender.mock.calls.length;

    act(() => useBrowserAutomationStore.setState({
      activeRequests: new Map([
        [
          "other-scope-request",
          {
            dispatch: {
              request: { workspaceId: "workspace-1" },
              target: { threadId: "other-scope", tabId: "other-tab" },
            },
            startedAt: 2,
          } as never,
        ],
      ]),
    }));

    expect(previewPanelRender).toHaveBeenCalledTimes(renderCount);
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
            dispatch: {
              request: { workspaceId: "workspace-1" },
              target: { threadId: "workspace-1", tabId: "browser-tab-1" },
            },
            startedAt: 2,
          } as never,
        ],
      ]),
    });
    closePreviewPage.mockImplementation((
      _workspaceId: string,
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
