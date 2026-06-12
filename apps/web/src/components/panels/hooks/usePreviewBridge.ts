import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PreviewPageStatus } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewSuppressionStore } from "@/stores/previewSuppressionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { resolveScopeBasePath } from "@/lib/resolve-scope-path";

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

/**
 * Snapshot shown in the native view's place while an overlay suppresses it.
 * `width`/`height` are the surface's CSS-px size at capture time; the panel
 * pins the <img> to them so resizing while frozen clips instead of stretching.
 */
export interface PreviewFreezeFrame {
  /** JPEG data URL of the captured page. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** Options for the {@link usePreviewBridge} hook. */
export interface UsePreviewBridgeOptions {
  /** Thread id that owns this preview session. */
  readonly threadId: string;
  /** Active workspace id; used to resolve relative file paths and scope spill files. */
  readonly workspaceId?: string | null;
  /** Ref to the DOM element whose bounds are synced to the native BrowserView. */
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
}

/** State and callbacks returned by {@link usePreviewBridge}. */
export interface PreviewBridgeState {
  /** Current value of the omnibox input. */
  readonly inputUrl: string;
  readonly setInputUrl: (url: string) => void;
  /** User-visible navigation error, or null when no error. */
  readonly navError: string | null;
  readonly setNavError: (err: string | null) => void;
  readonly canBack: boolean;
  readonly canFwd: boolean;
  readonly previewLoading: boolean;
  readonly pageTitle: string | null;
  readonly faviconUrl: string | null;
  /** Full active-tab page status; the tab bar overlays its active entry from this. */
  readonly pageStatus: PreviewPageStatus;
  /** Persisted URL for the current thread (Zustand store). */
  readonly storedUrl: string;
  /**
   * Freeze-frame shown in the native view's place while an overlay
   * suppresses it, or null when the live view owns the surface.
   */
  readonly freezeFrame: PreviewFreezeFrame | null;
  /** Push current bounds and visibility to the native BrowserView. */
  readonly pushSync: (visible: boolean) => Promise<void>;
  /** Refresh navigation state (canGoBack / canGoForward) from IPC. */
  readonly refreshNav: () => Promise<void>;
  readonly onGoBack: () => Promise<void>;
  readonly onGoForward: () => Promise<void>;
  readonly onReload: () => Promise<void>;
  /** Hard reload that bypasses the guest cache. */
  readonly onForceReload: () => Promise<void>;
  /** Clear the preview session's cookies. */
  readonly onClearCookies: () => Promise<void>;
  /** Clear the preview session's HTTP cache. */
  readonly onClearCache: () => Promise<void>;
  /** Read the guest's current zoom factor (1 = 100%). */
  readonly onGetZoom: () => Promise<number>;
  /** Set the guest's zoom factor; resolves to the clamped factor applied. */
  readonly onSetZoom: (factor: number) => Promise<number>;
  readonly onOpenExternal: () => Promise<void>;
  /** Navigate the preview to the given URL or file path. */
  readonly onNavigate: (url: string) => void;
  /** Recover from an error state by reloading the failed page. */
  readonly onRetry: () => Promise<void>;
}

/**
 * Manages IPC connection to the Electron preview: bounds sync, navigation
 * state, ResizeObserver tracking, and navigation event listeners.
 */
export function usePreviewBridge({
  threadId,
  workspaceId,
  surfaceRef,
}: UsePreviewBridgeOptions): PreviewBridgeState {
  const [inputUrl, setInputUrl] = useState("");
  const [navError, setNavError] = useState<string | null>(null);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [pageStatus, setPageStatus] = useState<PreviewPageStatus>(() => ({
    url: null,
    title: null,
    favicon: null,
    phase: "loaded",
  }));
  const previewLoading = pageStatus.phase === "loading";
  const pageTitle = pageStatus.title;
  const faviconUrl = pageStatus.favicon;

  // Approach A seam: while the page is in an error phase we hide the native
  // WebContentsView (which paints above all HTML) so the in-chrome HTML error
  // panel is visible. pushSync reads this ref to force visible:false; the
  // phase-change effect below re-syncs on every transition into/out of error.
  const phaseRef = useRef(pageStatus.phase);
  phaseRef.current = pageStatus.phase;

  // Relative file paths typed in the omnibox resolve against the scope's local
  // checkout: the workspace root when threadless or a direct thread, the
  // thread's worktree once a worktree thread is active. `threadId` is the
  // opaque panel scope (a workspace id threadless, a thread id otherwise), so
  // the active thread is whichever thread row matches it.
  const basePath = useWorkspaceStore((s) =>
    resolveScopeBasePath(threadId, workspaceId, s.threads, s.workspaces),
  );

  const storedUrl = useDiffStore(
    (s) => s.previewUrlByThread[threadId] ?? "",
  );

  /** Stable ref to the current storedUrl, read inside pushSync to avoid
   *  adding storedUrl to pushSync's dependency array. */
  const storedUrlRef = useRef(storedUrl);
  storedUrlRef.current = storedUrl;

  useEffect(() => {
    setInputUrl(storedUrl);
    setPageStatus({ url: null, title: null, favicon: null, phase: "loaded" });
    setNavError(null);
  }, [threadId, storedUrl]);

  // Notify the native layer whenever the owning thread changes. The
  // ResizeObserver effect (primary sync driver) has empty deps and only fires
  // on layout changes — a thread switch with identical panel bounds would
  // otherwise leave the previous thread's WebContentsView visible.
  useEffect(() => {
    void pushSyncRef.current(true);
  }, [threadId]);

  const refreshNav = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const s = await preview.getNavigationState();
    setCanBack(s.canGoBack);
    setCanFwd(s.canGoForward);
  }, []);

  const pushSync = useCallback(
    async (visible: boolean) => {
      const preview = window.desktopBridge?.preview;
      if (!preview) return;
      const el = surfaceRef.current;
      const hint = storedUrlRef.current.trim() || null;
      // Suppression (overlay open) and the error panel both force the native
      // view hidden regardless of what the caller asked for, so stray
      // pushSync(true) calls (ResizeObserver, thread switch) cannot pop the
      // view back above an open overlay.
      const suppressed = usePreviewSuppressionStore.getState().count > 0;
      const effectiveVisible =
        visible && !suppressed && phaseRef.current !== "error";
      if (!effectiveVisible || !el) {
        await preview.sync({
          visible: false,
          bounds: null,
          threadId,
          resumeUrlHint: hint,
          workspaceId: workspaceId ?? null,
        });
        return;
      }
      const r = el.getBoundingClientRect();
      await preview.sync({
        visible: true,
        bounds: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
        threadId,
        resumeUrlHint: hint,
        workspaceId: workspaceId ?? null,
      });
    },
    [threadId, workspaceId, surfaceRef],
  );

  const pushSyncRef = useRef(pushSync);
  pushSyncRef.current = pushSync;
  const refreshNavRef = useRef(refreshNav);
  refreshNavRef.current = refreshNav;

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.onPageStatus) return;
    const unsub = preview.onPageStatus((status) => {
      const url = status.url;
      const isReal =
        !!url && !url.startsWith("chrome-error://") && !url.startsWith("about:");
      if (status.phase === "error") {
        // Surface the error without persisting the failed URL into the
        // per-thread store: writing it would change storedUrl and retrigger the
        // [threadId, storedUrl] reset effect below, clobbering this error back
        // to a blank "loaded" status before the panel ever renders. The omnibox
        // still shows a real failed address (for Edit URL); a chrome-error/about
        // surface reads as "nothing loaded" so its title/favicon are dropped.
        if (isReal) {
          setInputUrl(url);
          setPageStatus(status);
        } else {
          setInputUrl("");
          setPageStatus({ ...status, title: null, favicon: null });
        }
        void refreshNav();
        return;
      }
      if (isReal) {
        useDiffStore.getState().setPreviewUrlForThread(threadId, url);
        setInputUrl(url);
        setPageStatus(status);
      } else {
        // Blank / about: / chrome-error => brand-new or failed surface. Clear
        // the omnibox AND the per-thread URL store so a stale URL does not
        // bleed in, and suppress title/favicon so the chrome reads
        // "nothing loaded".
        useDiffStore.getState().setPreviewUrlForThread(threadId, "");
        setInputUrl("");
        setPageStatus({ ...status, title: null, favicon: null });
      }
      void refreshNav();
    });
    return unsub;
  }, [threadId, refreshNav]);

  // While any modal/dialog overlay is open in the renderer the native
  // WebContentsView must be detached: it composites above all HTML and would
  // occlude the overlay. Naively detaching leaves a blank hole where the page
  // was, so on the first suppressor we grab a freeze-frame of the page and let
  // it stand in. Order matters: capture while the view is still mounted
  // (capturePage needs a painted surface), commit the <img>, wait a frame so
  // it is on screen underneath the native view, then detach.
  const [freezeFrame, setFreezeFrame] = useState<PreviewFreezeFrame | null>(null);
  const suppressionCount = usePreviewSuppressionStore((s) => s.count);
  const prevSuppressionRef = useRef(0);
  useEffect(() => {
    const prev = prevSuppressionRef.current;
    prevSuppressionRef.current = suppressionCount;
    if (suppressionCount === 0) {
      // Remount first, clear the frame after: the live view paints above the
      // <img> once attached, so the swap is invisible, whereas clearing early
      // would flash the empty surface. Skip the clear if another suppressor
      // opened while the sync was in flight.
      void pushSyncRef.current(true).finally(() => {
        if (usePreviewSuppressionStore.getState().count === 0) {
          setFreezeFrame(null);
        }
      });
      return;
    }
    if (prev > 0) {
      // Nested suppressor (e.g. dialog over menu): the view is already hidden
      // and the existing freeze-frame stays valid; capturing a detached view
      // would yield an empty image.
      void pushSyncRef.current(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      let frame: string | null = null;
      // The surface rect at capture time, in CSS px. The <img> is pinned to
      // this size so a resize while the overlay is open clips/reveals like a
      // real frozen viewport instead of stretching the snapshot.
      const rect = surfaceRef.current?.getBoundingClientRect() ?? null;
      // Only a loaded page has pixels worth freezing; the empty/ports surface
      // is plain HTML that overlays already stack above.
      if (storedUrlRef.current.trim().length > 0 && rect) {
        try {
          frame = (await window.desktopBridge?.preview?.captureSnapshot?.()) ?? null;
        } catch {
          frame = null;
        }
      }
      if (cancelled) return;
      if (frame && rect) {
        setFreezeFrame({ url: frame, width: rect.width, height: rect.height });
        // Two RAFs ~= one painted frame: the <img> must be on screen before
        // the native view detaches or the surface blanks for a frame.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (cancelled) return;
      }
      void pushSyncRef.current(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [suppressionCount]);

  // Re-sync the native view on every error<->non-error transition: hide it when
  // an error panel takes over, re-show it when a retry clears the error.
  // pushSync itself defers to suppression, so a load completing while a
  // dialog/overlay is open cannot reshow the BrowserView above it.
  useEffect(() => {
    void pushSyncRef.current(true);
  }, [pageStatus.phase]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const el = surfaceRef.current;
    if (!el) return;

    let mounted = true;
    let raf = 0;
    const schedule = () => {
      if (!mounted) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!mounted) return;
        void pushSyncRef.current(true);
        void refreshNavRef.current();
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();

    window.addEventListener("resize", schedule);
    return () => {
      mounted = false;
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
      void pushSyncRef.current(false);
    };
  }, []);

  const onGoBack = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.goBack();
    await refreshNav();
  }, [pushSync, refreshNav]);

  const onGoForward = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.goForward();
    await refreshNav();
  }, [pushSync, refreshNav]);

  const onReload = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.reload();
    await refreshNav();
  }, [pushSync, refreshNav]);

  const onForceReload = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await pushSync(true);
    await preview.forceReload();
    await refreshNav();
  }, [pushSync, refreshNav]);

  const onClearCookies = useCallback(async () => {
    await window.desktopBridge?.preview?.clearCookies();
  }, []);

  const onClearCache = useCallback(async () => {
    await window.desktopBridge?.preview?.clearCache();
  }, []);

  const onGetZoom = useCallback(async () => {
    return (await window.desktopBridge?.preview?.getZoom()) ?? 1;
  }, []);

  const onSetZoom = useCallback(async (factor: number) => {
    return (await window.desktopBridge?.preview?.setZoom(factor)) ?? 1;
  }, []);

  const onOpenExternal = useCallback(async () => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    await preview.openExternal();
  }, []);

  const onRetry = useCallback(async () => {
    setNavError(null);
    await onReload();
  }, [onReload]);

  const onNavigate = useCallback(
    (url: string) => {
      const preview = window.desktopBridge?.preview;
      if (!preview) return;
      setInputUrl(url);
      setNavError(null);
      void preview.navigate(url, basePath).then((r) => {
        if (!r.ok) setNavError(formatNavError(r.error));
      }).catch(() => {
        setNavError("Navigation failed.");
      });
    },
    [basePath],
  );

  return {
    inputUrl,
    setInputUrl,
    navError,
    setNavError,
    canBack,
    canFwd,
    previewLoading,
    pageTitle,
    faviconUrl,
    pageStatus,
    storedUrl,
    freezeFrame,
    pushSync,
    refreshNav,
    onGoBack,
    onGoForward,
    onReload,
    onForceReload,
    onClearCookies,
    onClearCache,
    onGetZoom,
    onSetZoom,
    onOpenExternal,
    onNavigate,
    onRetry,
  };
}
