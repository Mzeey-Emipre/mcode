import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isModifierClick,
  isPreviewableUrl,
  isEmptyPreviewTabUrl,
  openUrlInPreview,
  openGitHubUrl,
} from "../open-url-in-preview";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { createMockWorkspace, createMockThread } from "@/__tests__/mocks/transport";

describe("isModifierClick", () => {
  it("returns true for ctrl+click", () => {
    expect(isModifierClick({ ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("returns true for cmd+click", () => {
    expect(isModifierClick({ ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("returns false for plain click", () => {
    expect(isModifierClick({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("isPreviewableUrl", () => {
  it("accepts https URLs", () => {
    expect(isPreviewableUrl("https://example.com")).toBe(true);
  });

  it("accepts mcode-workspace URLs", () => {
    expect(isPreviewableUrl("mcode-workspace:///page.html")).toBe(true);
  });

  it("rejects mailto URLs", () => {
    expect(isPreviewableUrl("mailto:test@example.com")).toBe(false);
  });
});

describe("isEmptyPreviewTabUrl", () => {
  it("treats null, blank, and about: URLs as empty", () => {
    expect(isEmptyPreviewTabUrl(null)).toBe(true);
    expect(isEmptyPreviewTabUrl("")).toBe(true);
    expect(isEmptyPreviewTabUrl("about:blank")).toBe(true);
  });

  it("treats loaded http(s) URLs as non-empty", () => {
    expect(isEmptyPreviewTabUrl("https://example.com")).toBe(false);
  });
});

function mockTabList(activeUrl: string | null) {
  return vi.fn().mockResolvedValue({
    ok: true,
    data: {
      threadId: "thread-1",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          threadId: "thread-1",
          title: activeUrl ? "Loaded" : null,
          url: activeUrl,
          faviconUrl: null,
          warm: true,
          active: true,
        },
      ],
    },
  });
}

describe("openUrlInPreview", () => {
  let mockOpen: ReturnType<typeof vi.fn>;
  let mockNavigate: ReturnType<typeof vi.fn>;
  let mockResolveNavigation: ReturnType<typeof vi.fn>;
  let showRightPanel: ReturnType<typeof vi.fn>;
  let setRightPanelTab: ReturnType<typeof vi.fn>;
  let setPreviewUrlForThread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockOpen = vi.fn().mockResolvedValue({ ok: true, data: { tabId: "tab-2", tabs: {} } });
    mockNavigate = vi.fn().mockResolvedValue({ ok: true });
    mockResolveNavigation = vi.fn(async (url: string) => ({ ok: true, url }));
    showRightPanel = vi.fn();
    setRightPanelTab = vi.fn();
    setPreviewUrlForThread = vi.fn();

    useDiffStore.setState({
      showRightPanel,
      setRightPanelTab,
      setPreviewUrlForThread,
    } as Partial<ReturnType<typeof useDiffStore.getState>>);

    const ws = createMockWorkspace({ id: "ws-1", path: "/tmp/workspace" });
    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      activeThreadId: "thread-1",
      threads: [createMockThread({ id: "thread-1", workspace_id: ws.id })],
    });

    window.desktopBridge = {
      preview: {
        tabs: { open: mockOpen, list: mockTabList("https://example.com") },
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
      },
    } as unknown as typeof window.desktopBridge;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      activeThreadId: null,
    });
  });

  it("creates a new tab then navigates when the active tab already has a page", async () => {
    openUrlInPreview({ url: "https://example.com/pr/1", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(showRightPanel).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(setRightPanelTab).toHaveBeenCalledWith("ws-1", "thread-1", "preview");
    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", {
      activate: true,
      initialAddress: "https://example.com/pr/1",
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com/pr/1");
  });

  it("reuses an empty active tab instead of creating another", async () => {
    window.desktopBridge = {
      preview: {
        tabs: { open: mockOpen, list: mockTabList(null) },
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
      },
    } as unknown as typeof window.desktopBridge;

    openUrlInPreview({ url: "https://example.com/pr/1", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", {
      activate: true,
      tabId: "tab-1",
      initialAddress: "https://example.com/pr/1",
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com/pr/1");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates active tab without creating when newTab is false", async () => {
    openUrlInPreview({
      url: "https://example.com",
      threadId: "thread-1",
      newTab: false,
    });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", {
      activate: true,
      tabId: "tab-1",
      initialAddress: "https://example.com",
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("falls back to window.open when preview bridge is missing", () => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    openUrlInPreview({ url: "https://example.com", threadId: "thread-1" });

    expect(mockOpen).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });

  it("does not change the hosted surface when URL resolution fails", async () => {
    mockResolveNavigation.mockResolvedValue({ ok: false, error: "invalid-url" });
    window.desktopBridge = {
      preview: {
        tabs: { open: mockOpen, list: mockTabList("https://example.com") },
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
      },
    } as unknown as typeof window.desktopBridge;

    openUrlInPreview({ url: "https://example.com", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).not.toHaveBeenCalled();
    expect(setPreviewUrlForThread).not.toHaveBeenCalled();
  });

  it("does not navigate the active tab when exact new-tab creation fails", async () => {
    mockOpen.mockResolvedValue({ ok: false, error: "tab-unavailable" });

    openUrlInPreview({ url: "https://example.com/next", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalled();
    expect(setPreviewUrlForThread).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe("openGitHubUrl", () => {
  let mockOpenExternal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOpenExternal = vi.fn();
    window.desktopBridge = {
      openExternalUrl: mockOpenExternal,
      preview: {
        tabs: {
          open: vi.fn().mockResolvedValue({ ok: true, data: {} }),
          list: mockTabList("https://github.com/org/repo/pull/1"),
        },
        navigate: vi.fn().mockResolvedValue({ ok: true }),
        resolveNavigation: vi.fn(async (url: string) => ({ ok: true, url })),
      },
    } as unknown as typeof window.desktopBridge;

    useDiffStore.setState({
      showRightPanel: vi.fn(),
      setRightPanelTab: vi.fn(),
      setPreviewUrlForThread: vi.fn(),
    } as Partial<ReturnType<typeof useDiffStore.getState>>);

    useWorkspaceStore.setState({ activeThreadId: "thread-1", workspaces: [], activeWorkspaceId: null });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).desktopBridge;
  });

  it("opens in system browser on plain click", () => {
    openGitHubUrl("https://github.com/org/repo/pull/1", "thread-1");
    expect(mockOpenExternal).toHaveBeenCalledWith("https://github.com/org/repo/pull/1");
  });

  it("falls back to window.open when desktopBridge is missing on plain click", () => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    openGitHubUrl("https://github.com/org/repo/pull/1", "thread-1");

    expect(mockOpen).toHaveBeenCalledWith(
      "https://github.com/org/repo/pull/1",
      "_blank",
      "noopener,noreferrer",
    );
    vi.unstubAllGlobals();
  });

  it("opens in preview on ctrl+click", async () => {
    const mockOpen = vi.mocked(window.desktopBridge!.preview!.tabs!.open);
    openGitHubUrl(
      "https://github.com/org/repo/pull/1",
      "thread-1",
      { ctrlKey: true, metaKey: false },
    );
    await vi.runAllTimersAsync();
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalled();
  });
});
