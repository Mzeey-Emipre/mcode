import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Globe } from "lucide-react";
import type { PreviewPageStatus } from "@mcode/contracts";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewDesignModeStore } from "@/stores/previewDesignModeStore";
import { usePreviewFocusStore } from "@/stores/previewFocusStore";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { BrowserHeader } from "./BrowserHeader";
import { LocalPortsEmptyState } from "./LocalPortsEmptyState";
import { PreviewErrorPanel } from "./PreviewErrorPanel";
import { PreviewPerfHud } from "./PreviewPerfHud";
import { PreviewWebview, type PreviewWebviewHandle } from "./PreviewWebview";
import { formatNavError, usePreviewBridge } from "./hooks/usePreviewBridge";
import {
  usePreviewCapture,
  type PreviewCaptureKind,
} from "./hooks/usePreviewCapture";
import { usePreviewTabs } from "./hooks/usePreviewTabs";

/** Human-readable label for the capture confirmation badge. */
const CAPTURE_KIND_LABEL: Record<PreviewCaptureKind, string> = {
  viewport: "screenshot",
  region: "region",
  element: "element",
  context: "page context",
};

/** How long the capture confirmation badge stays visible after a successful attach. */
const CAPTURE_CONFIRMATION_DURATION_MS = 2200;

/** Fallback tab id used until the host tab list has loaded. */
export const PREVIEW_WEBVIEW_FALLBACK_TAB_ID = "__mcode_webview_active_fallback__";

/** Returns whether the flagged webview renderer should replace the native preview surface. */
export function shouldRenderWebviewPreview(engine: string | undefined): boolean {
  return engine === "webview";
}

export interface PreviewPanelProps {
  /** Thread that owns preview state (URL memory and future captures). */
  readonly threadId: string;
  /** Active workspace id; scopes spill files under the Mcode app data dir (not the project tree). */
  readonly workspaceId?: string | null;
}

/**
 * Embedded site preview: a clean URL header above a region aligned to an
 * Electron BrowserView. The header morphs across empty / focused / loaded
 * states; when nothing is loaded the surface lists detected localhost ports as
 * one-click cards. Full viewport, drag-selected region, element-pick PNGs, or
 * fence-only page context attach to the composer. A loading banner sits between
 * the header and guest region because the BrowserView stacks above HTML and
 * would hide in-surface overlays. In web-only builds without
 * `desktopBridge.preview`, renders an explanatory empty state.
 */
export function PreviewPanel({ threadId, workspaceId }: PreviewPanelProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<PreviewWebviewHandle | null>(null);

  const designModeActive = usePreviewDesignModeStore((s) => s.modes[threadId] === true);
  const designModeToggle = usePreviewDesignModeStore((s) => s.toggle);
  const designModeSetActive = usePreviewDesignModeStore((s) => s.setActive);
  const omniboxFocusTick = usePreviewFocusStore((s) => s.omniboxFocusTick);
  const previewRenderingEngine = useSettingsStore(
    (s) => s.settings.preview.rendering.engine,
  );
  const showWebviewPreview = shouldRenderWebviewPreview(previewRenderingEngine);

  const bridge = usePreviewBridge({
    threadId,
    workspaceId,
    surfaceRef,
    forceHidden: showWebviewPreview,
  });
  const [webviewSrc, setWebviewSrc] = useState<string | null>(null);
  const webviewSrcRef = useRef<string | null>(null);
  const setTrackedWebviewSrc = useCallback((nextSrc: string | null): void => {
    webviewSrcRef.current = nextSrc;
    setWebviewSrc(nextSrc);
  }, []);
  const [webviewNavError, setWebviewNavError] = useState<string | null>(null);
  const [webviewCanBack, setWebviewCanBack] = useState(false);
  const [webviewCanFwd, setWebviewCanFwd] = useState(false);
  const [webviewPageStatus, setWebviewPageStatus] = useState<PreviewPageStatus>({
    url: null,
    title: null,
    favicon: null,
    phase: "loaded",
  });

  // Inline capture confirmation. The composer chip lives in another panel and
  // may scroll off; this badge acknowledges the action where the user is
  // looking. The timer ref lets a second capture reset the dismissal window
  // without leaving a stale badge behind.
  const [lastCapture, setLastCapture] = useState<PreviewCaptureKind | null>(null);
  const captureConfirmTimerRef = useRef<number | null>(null);
  const onCaptureSuccess = useCallback((kind: PreviewCaptureKind): void => {
    setLastCapture(kind);
    if (captureConfirmTimerRef.current !== null) {
      window.clearTimeout(captureConfirmTimerRef.current);
    }
    captureConfirmTimerRef.current = window.setTimeout(() => {
      setLastCapture(null);
      captureConfirmTimerRef.current = null;
    }, CAPTURE_CONFIRMATION_DURATION_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (captureConfirmTimerRef.current !== null) {
        window.clearTimeout(captureConfirmTimerRef.current);
      }
    };
  }, []);

  const capture = usePreviewCapture({
    threadId,
    pushSync: bridge.pushSync,
    onSuccess: onCaptureSuccess,
  });
  // Subscribes the scope's tab set into usePreviewTabsStore and exposes the
  // "New page" action for the header. Page switching/closing is driven from the
  // activity rail (the page switcher), so this panel no longer renders a strip.
  const tabs = usePreviewTabs(threadId);
  const activeWebviewTabId =
    tabs.tabSet?.activeTabId ?? PREVIEW_WEBVIEW_FALLBACK_TAB_ID;

  useEffect(() => {
    webviewSrcRef.current = webviewSrc;
  }, [webviewSrc]);

  useEffect(() => {
    if (!showWebviewPreview) return;
    const stored = bridge.storedUrl.trim();
    if (!stored) {
      setTrackedWebviewSrc(null);
      setWebviewPageStatus({ url: null, title: null, favicon: null, phase: "loaded" });
      return;
    }
    if (webviewRef.current?.getUrl() === stored) return;
    if (webviewSrcRef.current === stored) return;
    setTrackedWebviewSrc(stored);
  }, [bridge.storedUrl, setTrackedWebviewSrc, showWebviewPreview, threadId]);

  const onWebviewPageStatus = useCallback((status: PreviewPageStatus): void => {
    setWebviewPageStatus(status);
    if (status.url) {
      useDiffStore.getState().setPreviewUrlForThread(threadId, status.url);
    }
  }, [threadId]);

  const onWebviewNavigate = useCallback(
    (url: string): void => {
      setWebviewNavError(null);
      setWebviewPageStatus((status) => ({ ...status, phase: "loading" }));
      void bridge.resolveNavigation(url).then((result) => {
        if (!result.ok) {
          setWebviewPageStatus((status) => ({ ...status, phase: "loaded" }));
          setWebviewNavError(formatNavError(result.error));
          return;
        }
        useDiffStore.getState().setPreviewUrlForThread(threadId, result.url);
        setWebviewPageStatus({
          url: result.url,
          title: null,
          favicon: null,
          phase: "loading",
        });
        const liveUrl = webviewRef.current?.getUrl();
        const mountedSrc = webviewSrcRef.current;
        if (liveUrl === result.url) {
          webviewRef.current?.reload();
          return;
        }
        if (mountedSrc === result.url) {
          webviewRef.current?.navigate(result.url);
          return;
        }
        setTrackedWebviewSrc(result.url);
      });
    },
    [bridge, setTrackedWebviewSrc, threadId],
  );

  const onWebviewOpenExternal = useCallback((): void => {
    const url = webviewRef.current?.getUrl() || webviewSrc;
    if (url) void window.desktopBridge?.openExternalUrl(url);
  }, [webviewSrc]);

  const onWebviewGetZoom = useCallback(async (): Promise<number> => {
    return (await webviewRef.current?.getZoom()) ?? 1;
  }, []);

  const onWebviewSetZoom = useCallback(async (factor: number): Promise<number> => {
    return (await webviewRef.current?.setZoom(factor)) ?? factor;
  }, []);

  const effectivePageStatus = showWebviewPreview ? webviewPageStatus : bridge.pageStatus;
  const effectiveInputUrl =
    showWebviewPreview ? (webviewPageStatus.url ?? webviewSrc ?? "") : bridge.inputUrl;
  const effectivePageTitle = showWebviewPreview ? webviewPageStatus.title : bridge.pageTitle;
  const effectiveFaviconUrl = showWebviewPreview ? webviewPageStatus.favicon : bridge.faviconUrl;
  const effectiveCanBack = showWebviewPreview ? webviewCanBack : bridge.canBack;
  const effectiveCanFwd = showWebviewPreview ? webviewCanFwd : bridge.canFwd;
  const effectivePreviewLoading = showWebviewPreview
    ? webviewPageStatus.phase === "loading"
    : bridge.previewLoading;
  const effectiveNavError = showWebviewPreview ? webviewNavError : bridge.navError;
  const effectiveNavigate = showWebviewPreview ? onWebviewNavigate : bridge.onNavigate;
  const effectiveGoBack = showWebviewPreview
    ? () => webviewRef.current?.goBack()
    : bridge.onGoBack;
  const effectiveGoForward = showWebviewPreview
    ? () => webviewRef.current?.goForward()
    : bridge.onGoForward;
  const effectiveReload = showWebviewPreview
    ? () => webviewRef.current?.reload()
    : bridge.onReload;
  const effectiveForceReload = showWebviewPreview
    ? () => webviewRef.current?.forceReload()
    : bridge.onForceReload;
  const effectiveOpenExternal = showWebviewPreview ? onWebviewOpenExternal : bridge.onOpenExternal;
  const effectiveGetZoom = showWebviewPreview ? onWebviewGetZoom : bridge.onGetZoom;
  const effectiveSetZoom = showWebviewPreview ? onWebviewSetZoom : bridge.onSetZoom;

  // Page events flow through `preview:page-status`, not `preview:tabs-updated`
  // (P2), so the host-truth tab set lags the active page's live chrome. Publish
  // it to the store so the rail's page switcher and Browser glyph reflect the
  // active page as it navigates, without re-serializing the whole tab set on
  // every favicon tick. Clear on unmount so a backgrounded scope falls back to
  // each tab's own persisted favicon rather than a stale overlay.
  useEffect(() => {
    usePreviewTabsStore.getState().setLiveChrome(threadId, {
      title: effectivePageStatus.title,
      url: effectivePageStatus.url,
      favicon: effectivePageStatus.favicon,
    });
  }, [threadId, effectivePageStatus]);
  useEffect(() => {
    return () => {
      usePreviewTabsStore.getState().setLiveChrome(threadId, null);
    };
  }, [threadId]);

  // Design mode is a single state: "next click on the page captures the
  // element under the cursor, repeat until you turn the mode off." Toggling it
  // off cancels any in-flight capture so the picker never sticks.
  const onToggleDesignMode = () => {
    const willActivate = !designModeActive;
    designModeToggle(threadId);
    if (!willActivate) {
      void window.desktopBridge?.preview?.cancelCapture();
    }
  };

  useEffect(() => {
    if (!designModeActive) return;
    let cancelled = false;
    const loop = async (): Promise<void> => {
      while (!cancelled) {
        if (!usePreviewDesignModeStore.getState().isActive(threadId)) return;
        const result = await capture.onAddElementPickPictureReference();
        if (cancelled) return;
        if (!result.ok) {
          // Cancel / error / Esc-in-guest: exit the mode entirely so the
          // user has a single, consistent way to escape a sticky picker.
          designModeSetActive(threadId, false);
          return;
        }
        // Successful pick attached an element; loop body re-arms for the
        // next click. Yield to the event loop between iterations so the
        // re-arm cannot starve other work if the hook ever resolves
        // synchronously (defensive: today it waits on a guest click, but
        // a future fast-path could resolve without a real await).
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };
    void loop();
    return () => {
      cancelled = true;
    };
  }, [
    designModeActive,
    threadId,
    capture.onAddElementPickPictureReference,
    designModeSetActive,
  ]);

  // Esc must exit design mode no matter where focus is. The global
  // escape.handle binding (default-keybindings.json) closes the current
  // thread on Esc, which would yank the user out of their workspace mid
  // pick session. We attach at capture phase with stopImmediatePropagation
  // so this listener fires before the global keybinding-manager dispatch.
  useEffect(() => {
    if (!designModeActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      designModeSetActive(threadId, false);
      void window.desktopBridge?.preview?.cancelCapture();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [designModeActive, designModeSetActive, threadId]);

  if (!window.desktopBridge?.preview) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground"
        data-testid="preview-panel-unavailable"
      >
        <Globe className="size-8 opacity-50" aria-hidden />
        <p className="max-w-xs text-balance">
          Embedded preview runs in the desktop app. Open Mcode from Electron to
          browse http and https sites alongside this thread.
        </p>
      </div>
    );
  }

  const hasLoadedPage = showWebviewPreview
    ? !!(webviewSrc ?? webviewPageStatus.url)
    : bridge.storedUrl.trim().length > 0;
  const pageError =
    effectivePageStatus.phase === "error" ? effectivePageStatus.error : undefined;
  const showLocalPorts = !hasLoadedPage && !effectivePreviewLoading && !pageError;

  return (
    <div
      data-testid="preview-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className={cn(showWebviewPreview && "relative z-20")}>
        <BrowserHeader
          url={effectiveInputUrl}
          pageTitle={effectivePageTitle}
          faviconUrl={effectiveFaviconUrl}
          hasLoadedPage={hasLoadedPage}
          canBack={effectiveCanBack}
          canFwd={effectiveCanFwd}
          threadId={threadId}
          designModeActive={designModeActive}
          elementPickBusy={capture.elementPickBusy}
          captureBusy={capture.captureBusy}
          regionBusy={capture.regionBusy}
          focusRequest={omniboxFocusTick}
          onNavigate={effectiveNavigate}
          onGoBack={effectiveGoBack}
          onGoForward={effectiveGoForward}
          onReload={effectiveReload}
          onOpenExternal={effectiveOpenExternal}
          onToggleDesign={onToggleDesignMode}
          onScreenshot={capture.onAddPictureReference}
          onNewPage={tabs.newTab}
          onForceReload={effectiveForceReload}
          onRegionCapture={capture.onAddRegionPictureReference}
          onDumpContent={capture.onAddPageContextOnly}
          onClearCookies={bridge.onClearCookies}
          onClearCache={bridge.onClearCache}
          onGetZoom={effectiveGetZoom}
          onSetZoom={effectiveSetZoom}
          suppressPreviewForOverlays={!showWebviewPreview}
        />
      </div>

      {effectiveNavError ? (
        <p className="flex-none px-3 py-1 text-xs text-destructive" role="status">
          {effectiveNavError}
        </p>
      ) : null}

      {/* Surface aligned to the native BrowserView. When nothing is loaded the
          localhost-ports list owns the surface; once a page loads the native
          guest paints over it. */}
      <div
        ref={surfaceRef}
        role="region"
        aria-label="Page preview"
        data-testid="preview-surface"
        className={cn(
          "relative min-h-[min(40vh,20rem)] min-w-0 flex-1",
          showWebviewPreview
            ? "z-0 overflow-hidden rounded-tl-md"
            : "mx-2 mb-2 mt-1 rounded-md border border-border/40 bg-muted/10",
          showLocalPorts && "overflow-y-auto",
        )}
      >
        {/* Loading: thin indeterminate progress bar at top of content area.
            motion-safe gates the animation so users with prefers-reduced-motion
            get a static bar instead of a perpetual sweep. */}
        {effectivePreviewLoading ? (
          <div
            data-testid="preview-loading-banner"
            className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden rounded-t-md"
            role="status"
            aria-live="polite"
            aria-label="Page loading"
          >
            <div className="h-full w-1/3 motion-safe:animate-preview-loading rounded-full bg-primary/80" />
          </div>
        ) : null}
        {lastCapture ? (
          // Brief acknowledgement of a successful attachment. Sits in the
          // bottom-right so it never overlaps the loading banner at the top
          // and never blocks the page's interactive area. Auto-dismiss after
          // ~2.2s via the host timer.
          <div
            role="status"
            aria-live="polite"
            data-testid="preview-capture-confirmation"
            className={cn(
              "pointer-events-none absolute right-2 bottom-2 z-10 flex items-center gap-1.5",
              // No backdrop-blur: the BrowserView paints opaque underneath
              // anyway, so the blur is a no-op render cost. bg-background/90
              // gives enough contrast over any guest page color.
              "rounded-sm border border-primary/30 bg-background/90 px-2 py-1 shadow-sm",
              "font-mono text-[11px] uppercase tracking-[0.14em] text-primary",
              "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
            )}
          >
            <Check size={11} aria-hidden />
            <span>attached</span>
            <span className="text-primary/60">{"\u00b7"}</span>
            <span>{CAPTURE_KIND_LABEL[lastCapture]}</span>
          </div>
        ) : null}
        {showWebviewPreview ? (
          <div
            data-testid="preview-webview-surface"
            className="absolute inset-0 z-0 overflow-hidden rounded-tl-md"
          >
            {webviewSrc ? (
              <PreviewWebview
                ref={webviewRef}
                threadId={threadId}
                tabId={activeWebviewTabId}
                src={webviewSrc}
                className="relative z-0 h-full w-full"
                onPageStatus={onWebviewPageStatus}
                onNavigationStateChange={(state) => {
                  setWebviewCanBack(state.canGoBack);
                  setWebviewCanFwd(state.canGoForward);
                }}
              />
            ) : null}
          </div>
        ) : null}
        {pageError ? (
          // Approach A: the native view is hidden (bridge syncs visible:false
          // while phase === "error"), so this HTML panel owns the surface and
          // names the failure with recovery actions.
          <PreviewErrorPanel
            error={pageError}
            url={effectivePageStatus.url}
            canBack={effectiveCanBack}
            onRetry={() => void effectiveReload()}
            onGoBack={() => void effectiveGoBack()}
          />
        ) : null}
        {showLocalPorts ? (
          <LocalPortsEmptyState
            active={showLocalPorts}
            onOpenPort={(port) => effectiveNavigate(`http://localhost:${port}`)}
          />
        ) : null}
      </div>
      <PreviewPerfHud />
    </div>
  );
}
