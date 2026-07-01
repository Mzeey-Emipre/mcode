import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type { PreviewPageStatus } from "@mcode/contracts";

/**
 * Renderer-hosted Electron `<webview>` that the host process can adopt by
 * `webContentsId`. Mirrors dpcode's renderer-attach flow: the renderer owns
 * the element lifetime; the host owns the WebContents lifecycle (debugger
 * attach, CDP routing) once the id is registered.
 *
 * Phase D scope: provide the adopt path so the Codex browser-use bridge can
 * drive a renderer-embedded tab via executeCdp. The component is opt-in -
 * tabs that don't request a webview keep the BrowserView path unchanged.
 */
export interface PreviewWebviewProps {
  readonly threadId: string;
  readonly tabId: string;
  readonly src: string;
  readonly className?: string;
  readonly onPageStatus?: (status: PreviewPageStatus) => void;
  readonly onNavigationStateChange?: (state: {
    canGoBack: boolean;
    canGoForward: boolean;
  }) => void;
}

/** Subset of Electron's WebviewTag API we actually call. */
interface ElectronWebviewElement {
  src: string;
  getWebContentsId(): number;
  getURL?(): string;
  getTitle?(): string;
  loadURL?(url: string): Promise<void>;
  reload?(): void;
  reloadIgnoringCache?(): void;
  canGoBack?(): boolean;
  canGoForward?(): boolean;
  goBack?(): void;
  goForward?(): void;
  getZoomFactor?(): number | Promise<number>;
  setZoomFactor?(factor: number): void | Promise<void>;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

/** Imperative controls for a live renderer-hosted preview webview. */
export interface PreviewWebviewHandle {
  navigate(url: string): void;
  reload(): void;
  forceReload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getUrl(): string;
  getZoom(): Promise<number>;
  setZoom(factor: number): Promise<number>;
}

type WebviewEvent = Event & {
  readonly url?: string;
  readonly title?: string;
  readonly favicons?: readonly string[];
  readonly validatedURL?: string;
  readonly errorCode?: number;
  readonly errorDescription?: string;
};

function realUrl(url: string | null | undefined): string | null {
  if (!url || url.startsWith("about:") || url.startsWith("chrome-error://")) {
    return null;
  }
  return url;
}

function isExpectedNavigationAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ERR_ABORTED" || candidate.errno === -3;
}

export const PreviewWebview = forwardRef<PreviewWebviewHandle, PreviewWebviewProps>(
  function PreviewWebview(
    {
      threadId,
      tabId,
      src,
      className,
      onPageStatus,
      onNavigationStateChange,
    },
    forwardedRef,
  ) {
  const ref = useRef<ElectronWebviewElement | null>(null);
  const faviconRef = useRef<string | null>(null);

  const readUrl = useCallback((): string | null => {
    const el = ref.current;
    try {
      return realUrl(el?.getURL?.() ?? el?.src ?? null);
    } catch {
      return realUrl(el?.src ?? null);
    }
  }, []);

  const readTitle = useCallback((): string | null => {
    try {
      const title = ref.current?.getTitle?.() ?? null;
      return title && title.trim().length > 0 ? title : null;
    } catch {
      return null;
    }
  }, []);

  const emitNavigationState = useCallback(() => {
    const el = ref.current;
    onNavigationStateChange?.({
      canGoBack: !!el?.canGoBack?.(),
      canGoForward: !!el?.canGoForward?.(),
    });
  }, [onNavigationStateChange]);

  const emitStatus = useCallback((phase: PreviewPageStatus["phase"]) => {
    onPageStatus?.({
      url: readUrl(),
      title: readTitle(),
      favicon: faviconRef.current,
      phase,
    });
    emitNavigationState();
  }, [emitNavigationState, onPageStatus, readTitle, readUrl]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      navigate(url: string) {
        const el = ref.current;
        if (!el) return;
        if (el.loadURL) {
          void el.loadURL(url).catch((error: unknown) => {
            if (isExpectedNavigationAbort(error)) return;
            onPageStatus?.({
              url: realUrl(url),
              title: null,
              favicon: null,
              phase: "error",
              error: {
                kind: "network",
                code: "ERR_FAILED",
                message: "Navigation failed.",
              },
            });
            emitNavigationState();
          });
        } else {
          el.src = url;
        }
      },
      reload() {
        ref.current?.reload?.();
      },
      forceReload() {
        const el = ref.current;
        if (el?.reloadIgnoringCache) {
          el.reloadIgnoringCache();
        } else {
          el?.reload?.();
        }
      },
      goBack() {
        if (ref.current?.canGoBack?.()) ref.current.goBack?.();
      },
      goForward() {
        if (ref.current?.canGoForward?.()) ref.current.goForward?.();
      },
      canGoBack() {
        return !!ref.current?.canGoBack?.();
      },
      canGoForward() {
        return !!ref.current?.canGoForward?.();
      },
      getUrl() {
        return readUrl() ?? "";
      },
      async getZoom() {
        return (await Promise.resolve(ref.current?.getZoomFactor?.())) ?? 1;
      },
      async setZoom(factor: number) {
        await Promise.resolve(ref.current?.setZoomFactor?.(factor));
        return (await Promise.resolve(ref.current?.getZoomFactor?.())) ?? factor;
      },
    }),
    [emitNavigationState, onPageStatus, readUrl],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.desktopBridge?.preview?.adoptWebview) return;

    let cancelled = false;
    const onAttached = (_ev: Event) => {
      if (cancelled) return;
      try {
        const wcId = el.getWebContentsId();
        if (Number.isFinite(wcId) && wcId > 0) {
          void window.desktopBridge!.preview!.adoptWebview!({
            webContentsId: wcId,
            threadId,
            tabId,
          });
        }
      } catch {
        /* webview not yet ready */
      }
    };
    el.addEventListener("did-attach", onAttached);
    onAttached(new Event("did-attach"));
    return () => {
      cancelled = true;
      try {
        el.removeEventListener("did-attach", onAttached);
      } catch {
        /* webview gone */
      }
      void window.desktopBridge?.preview?.releaseWebview?.({ threadId, tabId });
    };
  }, [threadId, tabId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onStart = () => emitStatus("loading");
    const onStop = () => emitStatus("loaded");
    const onNavigate = (ev: WebviewEvent) => {
      onPageStatus?.({
        url: realUrl(ev.url) ?? readUrl(),
        title: readTitle(),
        favicon: faviconRef.current,
        phase: "loaded",
      });
      emitNavigationState();
    };
    const onTitle = (ev: WebviewEvent) => {
      onPageStatus?.({
        url: readUrl(),
        title: ev.title && ev.title.trim().length > 0 ? ev.title : readTitle(),
        favicon: faviconRef.current,
        phase: "loaded",
      });
      emitNavigationState();
    };
    const onFavicon = (ev: WebviewEvent) => {
      faviconRef.current = ev.favicons?.[0] ?? null;
      emitStatus("loaded");
    };
    const onFail = (ev: WebviewEvent) => {
      if (ev.errorCode === -3) return;
      onPageStatus?.({
        url: realUrl(ev.validatedURL) ?? readUrl(),
        title: null,
        favicon: null,
        phase: "error",
        error: {
          kind: "network",
          code: String(ev.errorCode ?? "ERR_FAILED"),
          message: ev.errorDescription ?? "Navigation failed.",
        },
      });
      emitNavigationState();
    };

    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-navigate", onNavigate);
    el.addEventListener("did-navigate-in-page", onNavigate);
    el.addEventListener("page-title-updated", onTitle);
    el.addEventListener("page-favicon-updated", onFavicon);
    el.addEventListener("did-fail-load", onFail);
    return () => {
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-navigate", onNavigate);
      el.removeEventListener("did-navigate-in-page", onNavigate);
      el.removeEventListener("page-title-updated", onTitle);
      el.removeEventListener("page-favicon-updated", onFavicon);
      el.removeEventListener("did-fail-load", onFail);
    };
  }, [onPageStatus, onNavigationStateChange]);

  // Use createElement via React JSX since <webview> is a custom Chromium
  // element; React 19 will pass unknown attributes through unchanged.
  // We cast to any here only because @types/react does not know about <webview>.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Tag = "webview" as any;
  return (
    <Tag
      ref={ref}
      src={src}
      data-testid="preview-webview"
      data-thread-id={threadId}
      data-tab-id={tabId}
      partition="persist:mcode-preview"
      className={className}
    />
  );
});
