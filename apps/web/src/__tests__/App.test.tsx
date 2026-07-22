import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { App } from "../app/App";
import { useUiStore } from "@/stores/uiStore";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as typeof ResizeObserver;
}

// Mock the transport module to prevent WebSocket initialization during tests
vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  initTransport: vi.fn().mockResolvedValue({}),
  getTransport: () => ({
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    createAndSendMessage: vi
      .fn()
      .mockResolvedValue({ id: "t1", title: "test", model: null }),
    updateThreadTitle: vi.fn().mockResolvedValue(true),
    createWorkspace: vi.fn().mockResolvedValue({}),
    deleteWorkspace: vi.fn().mockResolvedValue(true),
    createThread: vi.fn().mockResolvedValue({}),
    deleteThread: vi.fn().mockResolvedValue(true),
    stopAgent: vi.fn().mockResolvedValue(undefined),
    getActiveAgentCount: vi.fn().mockResolvedValue(0),
    discoverConfig: vi.fn().mockResolvedValue({}),
    getVersion: vi.fn().mockResolvedValue("0.2.0"),
    touchLastOpened: vi.fn().mockResolvedValue(undefined),
    pinWorkspace: vi.fn().mockResolvedValue(undefined),
    removeRecent: vi.fn().mockResolvedValue(undefined),
    enrichWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
    filesystemBrowse: vi.fn().mockResolvedValue({
      path: "/",
      parent: null,
      entries: [],
      isExactDirectory: true,
    }),
    getSettings: vi.fn().mockResolvedValue({}),
    getPullRequestCapabilities: vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "unauthenticated",
        message: "GitHub authentication required",
      },
    }),
    listPullRequests: vi.fn().mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      snapshotVersion: "test",
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2026-07-11T12:00:30.000Z",
      limitations: [],
    }),
    cancelPullRequestOperation: vi
      .fn()
      .mockResolvedValue({ ok: true, cancelled: false }),
  }),
}));

// Mock ScrollArea since @base-ui/react may not work in jsdom
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
  ScrollBar: () => null,
}));

// Keep cold transform time outside the test timeout; this suite verifies navigation, not chunk loading.
await import("@/components/pull-requests/PullRequestSurface");

describe("App", () => {
  beforeEach(() => {
    useUiStore.setState({
      primarySurface: "chat",
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: false,
    });
  });

  it("renders the sidebar logo", async () => {
    render(<App />);
    await waitFor(() => {
      const sidebar =
        screen.queryByTestId("sidebar-docked") ??
        screen.getByTestId("sidebar-floating");
      expect(
        within(sidebar).getByRole("img", { name: "Mcode" }),
      ).toBeInTheDocument();
    });
  });

  it("renders the landing screen when no workspace is active", async () => {
    render(<App />);
    await waitFor(() => {
      const main = screen.getByRole("main");
      expect(
        within(main).getByRole("img", { name: "Mcode" }),
      ).toBeInTheDocument();
    });
  });

  it("gives the floating sidebar an opaque page surface", () => {
    useUiStore.setState({
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      sidebarFloating: true,
    });

    render(<App />);

    const floatingSidebar = screen.getByTestId("sidebar-floating");
    expect(floatingSidebar).toHaveClass("bg-page");
    expect(floatingSidebar.firstElementChild).toHaveClass(
      "w-full",
      "max-w-none",
    );
  });

  it("opens the lazy Pull requests surface from primary navigation", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Pull requests" }));

    await waitFor(() => {
      expect(
        within(screen.getByRole("main")).getByRole("heading", {
          name: "Pull requests",
        }),
      ).toBeInTheDocument();
    });
  });

  it("renders the persistent navigation title bar only for Electron", () => {
    (window as unknown as Record<string, unknown>).desktopBridge = {
      window: {
        platform: "win32",
        isDevelopment: false,
        perform: vi.fn(),
      },
    };

    const { unmount } = render(<App />);
    const titleBar = screen.getByTestId("desktop-title-bar");
    expect(titleBar).toHaveClass("h-10", "bg-page");
    expect(
      within(titleBar).getByRole("button", { name: "Back" }),
    ).toBeDisabled();
    expect(
      within(titleBar).getByRole("button", { name: "Forward" }),
    ).toBeDisabled();

    unmount();
    delete (window as unknown as Record<string, unknown>).desktopBridge;
  });
});
