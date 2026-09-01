import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { resolveScopeBasePath } from "@/lib/resolve-scope-path";
import type { PreviewResolveNavigationResult } from "@/transport/desktop-bridge";

const NAV_ERROR_LABEL: Record<string, string> = {
  "no-bounds": "Wait for the panel to finish layout, then try again.",
  "invalid-url": "Only http, https URLs and local file paths are supported.",
  "empty-url": "Enter a URL or file path.",
  "no-window": "Preview is unavailable.",
  "file-not-found": "File not found.",
  "not-a-file": "Path is not a regular file.",
  "is-directory": "Path is a directory (no index.html found).",
  "sensitive-file": "Cannot preview sensitive files (.env, .git, keys, etc.).",
  "no-workspace": "Open a workspace to use relative file paths.",
};

/** Resolves an IPC error code to a short user-visible hint. */
export function formatNavError(code: string): string {
  return NAV_ERROR_LABEL[code] ?? code;
}

/** Options for the {@link usePreviewSurfaceBridge} hook. */
export interface UsePreviewSurfaceBridgeOptions {
  /** Thread id that owns this preview session. */
  readonly threadId: string;
  /** Active workspace id; used to resolve relative file paths and scope spill files. */
  readonly workspaceId?: string | null;
  /** Ref to the DOM element whose bounds define Preview visibility and layout. */
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  /** Disable desktop Preview synchronization for automation-only webviews. */
  readonly automationOnly?: boolean;
}

/** Operations the BrowserSurfaceHost needs from the desktop Preview bridge. */
export interface PreviewSurfaceBridge {
  /** Persisted URL for the current thread. */
  readonly storedUrl: string;
  /** Push current bounds and visibility to the desktop Preview policy. */
  readonly pushSync: (visible: boolean) => Promise<void>;
  /** Resolve user input to a safe Preview URL before loading the Browser page. */
  readonly resolveNavigation: (url: string) => Promise<PreviewResolveNavigationResult>;
  /** Clear cookies in the shared Preview browser session. */
  readonly clearCookies: () => Promise<void>;
  /** Clear the HTTP cache in the shared Preview browser session. */
  readonly clearCache: () => Promise<void>;
}

/**
 * Synchronizes the BrowserSurfaceHost with the desktop session and resolves
 * omnibox input against the active workspace or worktree.
 */
export function usePreviewSurfaceBridge({
  threadId,
  workspaceId,
  surfaceRef,
  automationOnly = false,
}: UsePreviewSurfaceBridgeOptions): PreviewSurfaceBridge {
  const basePath = useWorkspaceStore((s) =>
    resolveScopeBasePath(threadId, workspaceId, s.threads, s.workspaces),
  );
  const storedUrl = useDiffStore((s) => s.previewUrlByThread[threadId] ?? "");
  const storedUrlRef = useRef(storedUrl);
  storedUrlRef.current = storedUrl;

  const pushSync = useCallback(async (visible: boolean): Promise<void> => {
    if (automationOnly) return;
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    const rectangle = surfaceRef.current?.getBoundingClientRect();
    const bounds = rectangle
      ? {
          x: Math.round(rectangle.left),
          y: Math.round(rectangle.top),
          width: Math.round(rectangle.width),
          height: Math.round(rectangle.height),
        }
      : null;

    await preview.sync({
      visible: visible && bounds !== null,
      bounds,
      threadId,
      resumeUrlHint: storedUrlRef.current.trim() || null,
      workspaceId: workspaceId ?? null,
    });
  }, [automationOnly, surfaceRef, threadId, workspaceId]);

  const pushSyncRef = useRef(pushSync);
  pushSyncRef.current = pushSync;

  useEffect(() => {
    void pushSyncRef.current(true);
  }, [threadId]);

  useEffect(() => {
    if (automationOnly) return;
    if (!window.desktopBridge?.preview || !surfaceRef.current) return;

    let mounted = true;
    let animationFrame = 0;
    const scheduleSync = (): void => {
      if (!mounted) return;
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0;
        if (mounted) void pushSyncRef.current(true);
      });
    };

    const observer = new ResizeObserver(scheduleSync);
    observer.observe(surfaceRef.current);
    scheduleSync();
    window.addEventListener("resize", scheduleSync);

    return () => {
      mounted = false;
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      void pushSync(false);
    };
  }, [automationOnly, pushSync, surfaceRef, threadId, workspaceId]);

  const resolveNavigation = useCallback(
    async (url: string): Promise<PreviewResolveNavigationResult> => {
      const preview = window.desktopBridge?.preview;
      if (!preview?.resolveNavigation) return { ok: false, error: "no-window" };
      return preview.resolveNavigation(url, basePath);
    },
    [basePath],
  );

  const clearCookies = useCallback(async (): Promise<void> => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.clearCookies();
  }, [pushSync]);

  const clearCache = useCallback(async (): Promise<void> => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.clearCache();
  }, [pushSync]);

  return {
    storedUrl,
    pushSync,
    resolveNavigation,
    clearCookies,
    clearCache,
  };
}
