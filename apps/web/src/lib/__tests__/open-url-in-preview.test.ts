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
import { createMockWorkspace } from "@/__tests__/mocks/transport";

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
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockNavigate: ReturnType<typeof vi.fn>;
  let showRightPanel: ReturnType<typeof vi.fn>;
  let setRightPanelTab: ReturnType<typeof vi.fn>;
  let setPreviewUrlForThread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCreate = vi.fn().mockResolvedValue({ ok: true, data: { tabId: "tab-2", tabs: {} } });
    mockNavigate = vi.fn().mockResolvedValue({ ok: true });
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
    });

    window.desktopBridge = {
      preview: {
        tabs: { create: mockCreate, list: mockTabList("https://example.com") },
        navigate: mockNavigate,
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

    expect(showRightPanel).toHaveBeenCalledWith("thread-1");
    expect(setRightPanelTab).toHaveBeenCalledWith("thread-1", "preview");
    expect(mockCreate).toHaveBeenCalledWith("thread-1", true);
    expect(mockNavigate).toHaveBeenCalledWith("https://example.com/pr/1", "/tmp/workspace");
    expect(setPreviewUrlForThread).not.toHaveBeenCalled();
  });

  it("reuses an empty active tab instead of creating another", async () => {
    window.desktopBridge = {
      preview: {
        tabs: { create: mockCreate, list: mockTabList(null) },
        navigate: mockNavigate,
      },
    } as unknown as typeof window.desktopBridge;

    openUrlInPreview({ url: "https://example.com/pr/1", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com/pr/1");
    expect(mockNavigate).toHaveBeenCalledWith("https://example.com/pr/1", "/tmp/workspace");
  });

  it("navigates active tab without creating when newTab is false", async () => {
    openUrlInPreview({
      url: "https://example.com",
      threadId: "thread-1",
      newTab: false,
    });
    await vi.runAllTimersAsync();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com");
    expect(mockNavigate).toHaveBeenCalled();
  });

  it("falls back to window.open when preview bridge is missing", () => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    openUrlInPreview({ url: "https://example.com", threadId: "thread-1" });

    expect(mockOpen).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });

  it("stores URL when navigate rejects", async () => {
    mockNavigate.mockRejectedValue(new Error("no-bounds"));
    window.desktopBridge = {
      preview: {
        tabs: { create: mockCreate, list: mockTabList("https://example.com") },
        navigate: mockNavigate,
      },
    } as unknown as typeof window.desktopBridge;

    openUrlInPreview({ url: "https://example.com", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com");
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
          create: vi.fn().mockResolvedValue({ ok: true, data: {} }),
          list: mockTabList("https://github.com/org/repo/pull/1"),
        },
        navigate: vi.fn().mockResolvedValue({ ok: true }),
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

  it("opens in preview on ctrl+click", async () => {
    const mockCreate = vi.mocked(window.desktopBridge!.preview!.tabs!.create);
    openGitHubUrl(
      "https://github.com/org/repo/pull/1",
      "thread-1",
      { ctrlKey: true, metaKey: false },
    );
    await vi.runAllTimersAsync();
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });
});
