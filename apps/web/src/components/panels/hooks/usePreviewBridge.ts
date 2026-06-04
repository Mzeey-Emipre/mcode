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
  /** Push current bounds and visibility to the native BrowserView. */
  readonly pushSync: (visible: boolean) => Promise<void>;
  /** Refresh navigation state (canGoBack / canGoForward) from IPC. */
  readonly refreshNav: () => Promise<void>;
  readonly onGoBack: () => Promise<void>;
  readonly onGoForward: () => Promise<void>;
  readonly onReload: () => Promise<void>;
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

  const workspacePath = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.path ?? null,
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
      // Keep the native view hidden while an error panel owns the surface.
      const effectiveVisible = visible && phaseRef.current !== "error";
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

  // Hide the native WebContentsView while any modal/dialog overlay is open
  // in the renderer. Without this the native view paints above all HTML and
  // covers Dialog/CommandPalette/etc. The bounds are remembered on the host
  // (s.lastBounds), so reattach is seamless.
  const suppressionCount = usePreviewSuppressionStore((s) => s.count);
  useEffect(() => {
    if (suppressionCount > 0) {
      void pushSyncRef.current(false);
    } else {
      void pushSyncRef.current(true);
    }
  }, [suppressionCount]);

  // Re-sync the native view on every error<->non-error transition: hide it when
  // an error panel takes over, re-show it when a retry clears the error. Defer to
  // suppression: a load completing while a dialog/overlay is open must not reshow
  // the BrowserView above it, so respect suppressionCount instead of forcing true.
  useEffect(() => {
    void pushSyncRef.current(suppressionCount === 0);
  }, [pageStatus.phase, suppressionCount]);

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
      void preview.navigate(url, workspacePath).then((r) => {
        if (!r.ok) setNavError(formatNavError(r.error));
      }).catch(() => {
        setNavError("Navigation failed.");
      });
    },
    [workspacePath],
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
    pushSync,
    refreshNav,
    onGoBack,
    onGoForward,
    onReload,
    onOpenExternal,
    onNavigate,
    onRetry,
  };
}
