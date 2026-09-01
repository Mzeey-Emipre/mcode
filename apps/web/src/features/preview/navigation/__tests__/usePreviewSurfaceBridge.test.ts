import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { formatNavError, usePreviewSurfaceBridge } from "../usePreviewSurfaceBridge";

const { previewUrlByThread, threads, workspaces } = vi.hoisted(() => ({
  previewUrlByThread: {} as Record<string, string>,
  threads: [] as Array<{ id: string; mode: "direct" | "worktree"; worktree_path: string | null }>,
  workspaces: [] as Array<{ id: string; path: string }>,
}));

vi.mock("@/stores/diffStore", () => ({
  useDiffStore: vi.fn((selector: (state: { previewUrlByThread: Record<string, string> }) => unknown) =>
    selector({ previewUrlByThread }),
  ),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (state: { threads: typeof threads; workspaces: typeof workspaces }) => unknown) =>
    selector({ threads, workspaces }),
  ),
}));

function makeSurfaceRef() {
  const surface = document.createElement("div");
  Object.defineProperty(surface, "getBoundingClientRect", {
    value: () => ({ left: 10, top: 20, width: 800, height: 600 }),
  });
  return { current: surface };
}

function makePreview() {
  return {
    sync: vi.fn().mockResolvedValue(undefined),
    resolveNavigation: vi.fn().mockResolvedValue({ ok: true, url: "https://example.test" }),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
  };
}

let resizeObserver: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

beforeEach(() => {
  Object.keys(previewUrlByThread).forEach((key) => delete previewUrlByThread[key]);
  threads.length = 0;
  workspaces.length = 0;
  resizeObserver = { observe: vi.fn(), disconnect: vi.fn() };
  const observer = resizeObserver;
  vi.stubGlobal("ResizeObserver", function ResizeObserver() {
    return observer;
  });
  vi.useFakeTimers();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).desktopBridge;
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("formatNavError", () => {
  it("explains known errors and leaves unknown errors intact", () => {
    expect(formatNavError("invalid-url")).toBe("Only http, https URLs and local file paths are supported.");
    expect(formatNavError("unlisted-error")).toBe("unlisted-error");
  });
});

describe("usePreviewSurfaceBridge", () => {
  it("synchronizes the visible surface with its scoped URL hint", async () => {
    const preview = makePreview();
    previewUrlByThread["thread-1"] = "https://saved.example";
    window.desktopBridge = { preview } as unknown as typeof window.desktopBridge;

    renderHook(() => usePreviewSurfaceBridge({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      surfaceRef: makeSurfaceRef(),
    }));

    await act(async () => {
      vi.runAllTimers();
    });

    expect(resizeObserver.observe).toHaveBeenCalledOnce();
    expect(preview.sync).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      threadId: "thread-1",
      resumeUrlHint: "https://saved.example",
      workspaceId: "workspace-1",
    });
  });

  it("resolves address-bar input against a worktree", async () => {
    const preview = makePreview();
    threads.push({ id: "thread-1", mode: "worktree", worktree_path: "C:\\worktrees\\thread-1" });
    workspaces.push({ id: "workspace-1", path: "C:\\workspace" });
    window.desktopBridge = { preview } as unknown as typeof window.desktopBridge;

    const { result } = renderHook(() => usePreviewSurfaceBridge({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      surfaceRef: makeSurfaceRef(),
    }));

    await act(async () => {
      await expect(result.current.resolveNavigation("report.html")).resolves.toEqual({
        ok: true,
        url: "https://example.test",
      });
    });

    expect(preview.resolveNavigation).toHaveBeenCalledWith("report.html", "C:\\worktrees\\thread-1");
  });

  it("syncs before clearing shared browser data", async () => {
    const preview = makePreview();
    window.desktopBridge = { preview } as unknown as typeof window.desktopBridge;

    const { result } = renderHook(() => usePreviewSurfaceBridge({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      surfaceRef: makeSurfaceRef(),
    }));

    await act(async () => {
      await result.current.clearCookies();
      await result.current.clearCache();
    });

    expect(preview.clearCookies).toHaveBeenCalledOnce();
    expect(preview.clearCache).toHaveBeenCalledOnce();
    expect(preview.sync).toHaveBeenCalledWith(expect.objectContaining({
      visible: true,
      threadId: "thread-1",
    }));
  });

  it("does not synchronize an automation-only surface", () => {
    const preview = makePreview();
    window.desktopBridge = { preview } as unknown as typeof window.desktopBridge;

    renderHook(() => usePreviewSurfaceBridge({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      surfaceRef: makeSurfaceRef(),
      automationOnly: true,
    }));

    expect(preview.sync).not.toHaveBeenCalled();
  });

  it("hides the surface when the panel unmounts", async () => {
    const preview = makePreview();
    window.desktopBridge = { preview } as unknown as typeof window.desktopBridge;

    const { unmount } = renderHook(() => usePreviewSurfaceBridge({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      surfaceRef: makeSurfaceRef(),
    }));

    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    expect(preview.sync).toHaveBeenCalledWith({
      visible: false,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      threadId: "thread-1",
      resumeUrlHint: null,
      workspaceId: "workspace-1",
    });
  });
});
