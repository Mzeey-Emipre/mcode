/**
 * Tests for usePreviewBridge.
 *
 * Verifies IPC wiring to window.desktopBridge.preview: initial state,
 * bounds sync on mount/unmount, navigation actions, event subscriptions,
 * and cleanup on unmount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePreviewBridge, formatNavError } from "../usePreviewBridge";

// ---------------------------------------------------------------------------
// diffStore mock – avoid pulling in the full Zustand store and its deps.
// The hook reads s.previewUrlByThread[threadId] and calls
// useDiffStore.getState().setPreviewUrlForThread. Both are stubbed here.
// ---------------------------------------------------------------------------
const mockSetPreviewUrlForThread = vi.fn();

vi.mock("@/stores/diffStore", () => ({
  useDiffStore: vi.fn((selector: (s: { previewUrlByThread: Record<string, string> }) => unknown) =>
    selector({ previewUrlByThread: {} }),
  ),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: vi.fn(
    (selector: (s: { workspaces: Array<{ id: string; path: string }> }) => unknown) =>
      selector({ workspaces: [] }),
  ),
}));

// Make useDiffStore.getState() available for the onDidNavigate handler.
import { useDiffStore } from "@/stores/diffStore";
(useDiffStore as unknown as { getState: () => unknown }).getState = () => ({
  setPreviewUrlForThread: mockSetPreviewUrlForThread,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a surfaceRef pointing at a div with fixed dimensions. */
function makeSurfaceRef() {
  const el = document.createElement("div");
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ left: 10, top: 20, width: 800, height: 600 }),
    writable: true,
  });
  return { current: el };
}

/** Default mock implementation for window.desktopBridge.preview. */
function makeMockPreview() {
  return {
    sync: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue({ ok: true }),
    goBack: vi.fn().mockResolvedValue(undefined),
    goForward: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    getNavigationState: vi.fn().mockResolvedValue({ canGoBack: false, canGoForward: false }),
    onPageStatus: vi.fn().mockReturnValue(() => {}),
    cancelCapture: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Global stubs
// ---------------------------------------------------------------------------

let mockRo: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mockRo = { observe: vi.fn(), disconnect: vi.fn() };
  // Must be a real constructor (class/function), not an arrow fn, for `new ResizeObserver(...)` to work.
  const captured = mockRo;
  vi.stubGlobal("ResizeObserver", function ResizeObserver() {
    return captured;
  });

  // Use fake timers so requestAnimationFrame resolves synchronously via
  // vi.runAllTimers() / vi.advanceTimersByTime().
  vi.useFakeTimers();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).desktopBridge;
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// formatNavError (pure helper)
// ---------------------------------------------------------------------------

describe("formatNavError", () => {
  it("returns a known label for recognised error codes", () => {
    expect(formatNavError("no-bounds")).toBe(
      "Wait for the panel to finish layout, then try again.",
    );
    expect(formatNavError("invalid-url")).toBe(
      "Only http, https URLs and local file paths are supported.",
    );
    expect(formatNavError("empty-url")).toBe("Enter a URL or file path.");
    expect(formatNavError("no-window")).toBe("Preview is unavailable.");
  });

  it("echoes unknown codes through unchanged", () => {
    expect(formatNavError("some-unknown-code")).toBe("some-unknown-code");
  });
});

// ---------------------------------------------------------------------------
// usePreviewBridge
// ---------------------------------------------------------------------------

describe("usePreviewBridge", () => {
  /** Run the RAF scheduled by the ResizeObserver effect. */
  async function flushRaf() {
    await act(async () => {
      vi.runAllTimers();
    });
  }

  it("returns correct initial state when desktopBridge is absent", () => {
    const { result } = renderHook(() =>
      usePreviewBridge({
        threadId: "t-1",
        workspaceId: "ws-1",
        surfaceRef: makeSurfaceRef(),
      }),
    );

    expect(result.current.inputUrl).toBe("");
    expect(result.current.navError).toBeNull();
    expect(result.current.canBack).toBe(false);
    expect(result.current.canFwd).toBe(false);
    expect(result.current.previewLoading).toBe(false);
    expect(result.current.pageTitle).toBeNull();
    expect(result.current.faviconUrl).toBeNull();
  });

  it("calls preview.sync with visible:true on mount (via ResizeObserver RAF)", async () => {
    const mockPreview = makeMockPreview();
    window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

    renderHook(() =>
      usePreviewBridge({
        threadId: "t-1",
        workspaceId: "ws-1",
        surfaceRef: makeSurfaceRef(),
      }),
    );

    await flushRaf();

    expect(mockPreview.sync).toHaveBeenCalledWith(
      expect.objectContaining({ visible: true, threadId: "t-1" }),
    );
  });

  it("calls preview.sync with visible:false on unmount", async () => {
    const mockPreview = makeMockPreview();
    window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

    const { unmount } = renderHook(() =>
      usePreviewBridge({
        threadId: "t-1",
        workspaceId: "ws-1",
        surfaceRef: makeSurfaceRef(),
      }),
    );

    await flushRaf();
    mockPreview.sync.mockClear();

    await act(async () => {
      unmount();
    });

    expect(mockPreview.sync).toHaveBeenCalledWith(
      expect.objectContaining({ visible: false, threadId: "t-1" }),
    );
  });

  it("calls preview.goBack when onGoBack is invoked", async () => {
    const mockPreview = makeMockPreview();
    window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

    const { result } = renderHook(() =>
      usePreviewBridge({
        threadId: "t-1",
        workspaceId: "ws-1",
        surfaceRef: makeSurfaceRef(),
      }),
    );

    await act(async () => {
      await result.current.onGoBack();
    });

    expect(mockPreview.goBack).toHaveBeenCalledOnce();
  });

  it("calls preview.goForward when onGoForward is invoked", async () => {
    const mockPreview = makeMockPreview();
    window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

    const { result } = renderHook(() =>
      usePreviewBridge({
        threadId: "t-1",
        workspaceId: "ws-1",
        surfaceRef: makeSurfaceRef(),
      }),
    );

    await act(async () => {
      await result.current.onGoForward();
    });

    expect(mockPreview.goForward).toHaveBeenCalledOnce();
  });

  it("calls preview.reload when onReload is invoked", async () => {
    const mockPreview = makeMockPreview();
    window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

    const { result } = renderHook(() =>
      usePreviewBridge({
        threadId: "t-1",
        workspaceId: "ws-1",
        surfaceRef: makeSurfaceRef(),
      }),
    );

    await act(async () => {
      await result.current.onReload();
    });

    expect(mockPreview.reload).toHaveBeenCalledOnce();
  });

  it("calls preview.openExternal when onOpenExternal is invoked", async () => {
    const mockPreview = makeMockPreview();
    window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

    const { result } = renderHook(() =>
      usePreviewBridge({
        threadId: "t-1",
        workspaceId: "ws-1",
        surfaceRef: makeSurfaceRef(),
      }),
    );

    await act(async () => {
      await result.current.onOpenExternal();
    });

    expect(mockPreview.openExternal).toHaveBeenCalledOnce();
  });

  describe("onNavigate", () => {
    it("calls preview.navigate with the given URL", async () => {
      const mockPreview = makeMockPreview();
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { result } = renderHook(() =>
        usePreviewBridge({
          threadId: "t-1",
          workspaceId: "ws-1",
          surfaceRef: makeSurfaceRef(),
        }),
      );

      await act(async () => {
        result.current.onNavigate("https://example.com");
        // Flush microtasks so the navigate promise resolves.
        await Promise.resolve();
      });

      expect(mockPreview.navigate).toHaveBeenCalledWith("https://example.com", null);
    });

    it("sets navError when navigate returns ok:false", async () => {
      const mockPreview = makeMockPreview();
      mockPreview.navigate.mockResolvedValue({ ok: false, error: "invalid-url" });
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { result } = renderHook(() =>
        usePreviewBridge({
          threadId: "t-1",
          workspaceId: "ws-1",
          surfaceRef: makeSurfaceRef(),
        }),
      );

      await act(async () => {
        result.current.onNavigate("ftp://bad.url");
        await Promise.resolve();
      });

      expect(result.current.navError).toBe("Only http, https URLs and local file paths are supported.");
    });

    it("does not set navError when navigate succeeds", async () => {
      const mockPreview = makeMockPreview();
      mockPreview.navigate.mockResolvedValue({ ok: true });
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { result } = renderHook(() =>
        usePreviewBridge({
          threadId: "t-1",
          workspaceId: "ws-1",
          surfaceRef: makeSurfaceRef(),
        }),
      );

      await act(async () => {
        result.current.onNavigate("https://ok.example.com");
        await Promise.resolve();
      });

      expect(mockPreview.navigate).toHaveBeenCalled();
      expect(result.current.navError).toBeNull();
    });
  });

  describe("onPageStatus subscription", () => {
    type StatusCb = (s: import("@mcode/contracts").PreviewPageStatus) => void;

    function captureStatusCb(mockPreview: ReturnType<typeof makeMockPreview>) {
      let cb: StatusCb | null = null;
      mockPreview.onPageStatus.mockImplementation((fn: StatusCb) => {
        cb = fn;
        return () => {};
      });
      return () => cb;
    }

    it("derives inputUrl, pageTitle, faviconUrl, and previewLoading from status", async () => {
      const mockPreview = makeMockPreview();
      const getCb = captureStatusCb(mockPreview);
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { result } = renderHook(() =>
        usePreviewBridge({ threadId: "t-1", workspaceId: "ws-1", surfaceRef: makeSurfaceRef() }),
      );
      expect(getCb()).not.toBeNull();

      await act(async () => {
        getCb()!({
          url: "https://example.com",
          title: "Example Page",
          favicon: "https://example.com/fav.ico",
          phase: "loading",
        });
      });

      expect(result.current.inputUrl).toBe("https://example.com");
      expect(result.current.pageTitle).toBe("Example Page");
      expect(result.current.faviconUrl).toBe("https://example.com/fav.ico");
      expect(result.current.previewLoading).toBe(true);

      await act(async () => {
        getCb()!({
          url: "https://example.com",
          title: "Example Page",
          favicon: "https://example.com/fav.ico",
          phase: "loaded",
        });
      });
      expect(result.current.previewLoading).toBe(false);
    });

    it("clears title and favicon when the URL is a chrome-error:// URL", async () => {
      const mockPreview = makeMockPreview();
      const getCb = captureStatusCb(mockPreview);
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { result } = renderHook(() =>
        usePreviewBridge({ threadId: "t-1", workspaceId: "ws-1", surfaceRef: makeSurfaceRef() }),
      );

      await act(async () => {
        getCb()!({
          url: "https://example.com",
          title: "Example",
          favicon: "https://example.com/fav.ico",
          phase: "loaded",
        });
      });
      expect(result.current.pageTitle).toBe("Example");

      await act(async () => {
        getCb()!({ url: "chrome-error://chromewebdata", title: "Error", favicon: null, phase: "error" });
      });
      expect(result.current.pageTitle).toBeNull();
      expect(result.current.faviconUrl).toBeNull();
    });

    it("calls the cleanup function returned by onPageStatus on unmount", async () => {
      const cleanup = vi.fn();
      const mockPreview = makeMockPreview();
      mockPreview.onPageStatus.mockReturnValue(cleanup);
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { unmount } = renderHook(() =>
        usePreviewBridge({ threadId: "t-1", workspaceId: "ws-1", surfaceRef: makeSurfaceRef() }),
      );

      await act(async () => {
        unmount();
      });
      expect(cleanup).toHaveBeenCalled();
    });
  });

  describe("thread switch", () => {
    it("calls preview.sync with the new threadId immediately when threadId changes", async () => {
      const mockPreview = makeMockPreview();
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const surfaceRef = makeSurfaceRef();
      const { rerender } = renderHook(
        ({ threadId }: { threadId: string }) =>
          usePreviewBridge({ threadId, workspaceId: "ws-1", surfaceRef }),
        { initialProps: { threadId: "t-1" } },
      );

      // Flush the initial RAF so t-1's mount sync fires.
      await flushRaf();
      mockPreview.sync.mockClear();

      // Switch to a different thread.
      await act(async () => {
        rerender({ threadId: "t-2" });
      });

      // The new threadId effect must fire synchronously (no RAF needed) so
      // the native layer swaps views even when panel bounds are unchanged.
      expect(mockPreview.sync).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, threadId: "t-2" }),
      );
    });
  });

  describe("ResizeObserver effect", () => {
    it("observes the surface element", () => {
      const mockPreview = makeMockPreview();
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const surfaceRef = makeSurfaceRef();

      renderHook(() =>
        usePreviewBridge({
          threadId: "t-1",
          workspaceId: "ws-1",
          surfaceRef,
        }),
      );

      expect(mockRo.observe).toHaveBeenCalledWith(surfaceRef.current);
    });

    it("disconnects the ResizeObserver on unmount", async () => {
      const mockPreview = makeMockPreview();
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { unmount } = renderHook(() =>
        usePreviewBridge({
          threadId: "t-1",
          workspaceId: "ws-1",
          surfaceRef: makeSurfaceRef(),
        }),
      );

      await act(async () => {
        unmount();
      });

      expect(mockRo.disconnect).toHaveBeenCalled();
    });

    it("passes bounds from getBoundingClientRect to preview.sync", async () => {
      const mockPreview = makeMockPreview();
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      renderHook(() =>
        usePreviewBridge({
          threadId: "t-1",
          workspaceId: "ws-1",
          surfaceRef: makeSurfaceRef(),
        }),
      );

      await flushRaf();

      expect(mockPreview.sync).toHaveBeenCalledWith(
        expect.objectContaining({
          visible: true,
          bounds: { x: 10, y: 20, width: 800, height: 600 },
        }),
      );
    });

    it("skips sync entirely when desktopBridge is absent", async () => {
      // No desktopBridge set — should not throw and sync is never called.
      expect(() =>
        renderHook(() =>
          usePreviewBridge({
            threadId: "t-1",
            workspaceId: "ws-1",
            surfaceRef: makeSurfaceRef(),
          }),
        ),
      ).not.toThrow();
    });
  });

  describe("refreshNav", () => {
    it("updates canBack and canFwd from getNavigationState", async () => {
      const mockPreview = makeMockPreview();
      mockPreview.getNavigationState.mockResolvedValue({
        canGoBack: true,
        canGoForward: true,
      });
      window.desktopBridge = { preview: mockPreview } as unknown as typeof window.desktopBridge;

      const { result } = renderHook(() =>
        usePreviewBridge({
          threadId: "t-1",
          workspaceId: "ws-1",
          surfaceRef: makeSurfaceRef(),
        }),
      );

      await act(async () => {
        await result.current.refreshNav();
      });

      expect(result.current.canBack).toBe(true);
      expect(result.current.canFwd).toBe(true);
    });
  });
});
