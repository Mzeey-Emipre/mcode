import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { PreviewPageStatus } from "@mcode/contracts";
import type {
  BrowserSurfaceIdentity,
  BrowserSurfacePageState,
} from "../browser-surfaces";
import {
  browserAutomationTargetKey,
  useBrowserAutomationStore,
} from "../automation/browserAutomationStore";
import { browserSurfaceHost } from "./BrowserSurfaceHostRoot";
import { DEFAULT_VIEWPORT_SIZE } from "../automation/services/viewportCoordinator";
import {
  getOrCreateViewportCoordinator,
  waitForViewportLayout,
} from "../automation/services/viewportCoordinatorFactory";

/** Properties for one hosted renderer Browser surface. */
export interface PreviewWebviewProps {
  readonly active?: boolean;
  readonly workspaceId?: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly src: string;
  readonly className?: string;
  /** Keep an off-screen automation surface presented inside its dedicated inert host. */
  readonly allowHiddenPresentation?: boolean;
  /** Width covered by floating panel chrome at the left edge. */
  readonly coveredLeft?: number;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly onPageStatus?: (status: PreviewPageStatus) => void;
  readonly onNavigationStateChange?: (state: {
    canGoBack: boolean;
    canGoForward: boolean;
  }) => void;
}

/** Imperative controls for one hosted renderer Browser surface. */
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

function visibleAddress(state: BrowserSurfacePageState): string | null {
  const address = state.committedAddress ?? state.pendingAddress;
  return !address || address.startsWith("about:") || address.startsWith("chrome-error:")
    ? null
    : address;
}

function previewStatus(state: BrowserSurfacePageState): PreviewPageStatus {
  const committedBlank = state.committedAddress?.startsWith("about:") === true;
  return {
    url: visibleAddress(state),
    title: state.title || null,
    favicon: state.favicon,
    phase: committedBlank ? "loaded" : state.phase,
    ...(state.mainFrameError
      ? {
          error: {
            kind: "network" as const,
            code: "ERR_FAILED",
            message: state.mainFrameError,
          },
        }
      : {}),
  };
}

function supportedInitialAddress(address: string): string | undefined {
  return /^(https?|file):\/\//i.test(address) ? address : undefined;
}

/** Placement controller for a surface owned by the renderer-window BrowserSurfaceHost. */
export const PreviewWebview = forwardRef<PreviewWebviewHandle, PreviewWebviewProps>(
  function PreviewWebview(
    {
      active = true,
      threadId,
      workspaceId = threadId,
      tabId,
      src,
      className,
      allowHiddenPresentation = false,
      coveredLeft = 0,
      viewport,
      onPageStatus,
      onNavigationStateChange,
    },
    forwardedRef,
  ) {
    const placementRef = useRef<HTMLDivElement | null>(null);
    const stateRef = useRef<BrowserSurfacePageState | null>(null);
    const initialAddressRef = useRef(supportedInitialAddress(src));
    const callbacksRef = useRef({ onPageStatus, onNavigationStateChange });
    callbacksRef.current = { onPageStatus, onNavigationStateChange };
    const identity = useMemo<BrowserSurfaceIdentity>(() => ({
      workspaceId,
      scope: { kind: "thread", id: threadId },
      tabId,
    }), [tabId, threadId, workspaceId]);
    const initialViewportRef = useRef(viewport ?? DEFAULT_VIEWPORT_SIZE);

    const ensureViewportCoordinator = useCallback((targetGeneration: number) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      const store = useBrowserAutomationStore.getState();
      const existing = store.viewportCoordinators.get(key);
      return getOrCreateViewportCoordinator({
        existing,
        target: { threadId, tabId },
        initial: store.viewportStateByTarget.get(key)?.confirmed ??
          store.viewportByTarget.get(key) ?? initialViewportRef.current,
        mode: store.viewportStateByTarget.get(key)?.mode,
        presentation: store.viewportStateByTarget.get(key)?.presentation,
        targetGeneration,
        surface: {
          setViewport: (size, operation, coordinator) => useBrowserAutomationStore.getState().applyViewportIfCurrent(
            workspaceId,
            threadId,
            tabId,
            coordinator,
            operation.targetGeneration,
            size,
          ),
          resetViewport: (operation, coordinator) => useBrowserAutomationStore.getState().resetViewportIfCurrent(
            workspaceId,
            threadId,
            tabId,
            coordinator,
            operation.targetGeneration,
          ),
          readViewport: () => useBrowserAutomationStore.getState().viewportByTarget.get(key) ?? null,
          waitForLayout: waitForViewportLayout,
          isCurrent: (operation, coordinator) => {
            const current = useBrowserAutomationStore.getState();
            return current.viewportCoordinators.get(key) === coordinator &&
              current.liveTargets.get(key)?.revision === operation.targetGeneration;
          },
        },
        readConfirmed: () =>
          useBrowserAutomationStore.getState().viewportStateByTarget.get(key)?.confirmed ??
          useBrowserAutomationStore.getState().viewportByTarget.get(key) ?? null,
        onStateChange: (state, coordinator) => useBrowserAutomationStore.getState().setViewportState(
          workspaceId,
          threadId,
          tabId,
          state,
          coordinator,
        ),
        onCreated: (created) => useBrowserAutomationStore.getState().setViewportCoordinator(
          workspaceId,
          threadId,
          tabId,
          created,
        ),
      });
    }, [tabId, threadId, workspaceId]);

    const currentSurface = useCallback(() => {
      const state = browserSurfaceHost.getSnapshot(identity);
      stateRef.current = state;
      return state;
    }, [identity]);

    const navigateMain = useCallback((kind: "back" | "forward" | "reload" | "force-reload"): void => {
      const surface = currentSurface();
      if (!surface) return;
      void window.desktopBridge?.preview?.surface.navigate({
        surface: { identity, generation: surface.generation },
        navigation: { kind },
      });
    }, [currentSurface, identity]);

    useImperativeHandle(forwardedRef, () => ({
      navigate(url: string) {
        browserSurfaceHost.navigate(identity, url);
      },
      reload() {
        navigateMain("reload");
      },
      forceReload() {
        navigateMain("force-reload");
      },
      goBack() {
        navigateMain("back");
      },
      goForward() {
        navigateMain("forward");
      },
      canGoBack() {
        return currentSurface()?.navigation?.canGoBack ?? false;
      },
      canGoForward() {
        return currentSurface()?.navigation?.canGoForward ?? false;
      },
      getUrl() {
        const state = currentSurface();
        return state ? visibleAddress(state) ?? "" : "";
      },
      async getZoom() {
        return window.desktopBridge?.preview?.getZoom?.() ?? 1;
      },
      async setZoom(factor: number) {
        return window.desktopBridge?.preview?.setZoom?.(factor) ?? factor;
      },
    }), [currentSurface, identity, navigateMain]);

    useLayoutEffect(() => {
      useBrowserAutomationStore.getState().registerTarget(workspaceId, threadId, tabId);
      const targetGeneration = useBrowserAutomationStore.getState().liveTargets.get(
        browserAutomationTargetKey(workspaceId, threadId, tabId),
      )?.revision ?? 1;
      ensureViewportCoordinator(targetGeneration);
      const initial = browserSurfaceHost.ensure(identity, {
        address: initialAddressRef.current,
      });
      stateRef.current = initial;
      callbacksRef.current.onPageStatus?.(previewStatus(initial));
      const unsubscribe = browserSurfaceHost.subscribe(identity, (state) => {
        stateRef.current = state;
        callbacksRef.current.onPageStatus?.(previewStatus(state));
        callbacksRef.current.onNavigationStateChange?.(state.navigation ?? {
          canGoBack: false,
          canGoForward: false,
        });
      });
      return () => {
        unsubscribe();
        browserSurfaceHost.hide(identity);
      };
    }, [ensureViewportCoordinator, identity, tabId, threadId, workspaceId]);

    useEffect(() => {
      const address = supportedInitialAddress(src);
      if (!address) return;
      const current = currentSurface();
      if (current?.pendingAddress === address || current?.committedAddress === address) return;
      browserSurfaceHost.navigate(identity, address);
    }, [currentSurface, identity, src]);

    useLayoutEffect(() => {
      const placement = placementRef.current;
      if (!placement) return;
      if (!active) {
        browserSurfaceHost.hide(identity);
        return;
      }
      const update = (): void => {
        const bounds = placement.getBoundingClientRect();
        if (
          bounds.width <= 0 ||
          bounds.height <= 0 ||
          (!allowHiddenPresentation && placement.closest("[inert], [aria-hidden='true']"))
        ) {
          browserSurfaceHost.hide(identity);
          return;
        }
        const intrinsicWidth = viewport?.width ?? bounds.width;
        const intrinsicHeight = viewport?.height ?? bounds.height;
        browserSurfaceHost.present(identity, {
          left: bounds.left,
          top: bounds.top,
          width: intrinsicWidth,
          height: intrinsicHeight,
          scale: viewport ? Math.min(bounds.width / intrinsicWidth, bounds.height / intrinsicHeight) : 1,
          zIndex: 31,
          coveredLeft,
        });
      };
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
      observer?.observe(placement);
      window.addEventListener("resize", update);
      update();
      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", update);
        browserSurfaceHost.hide(identity);
      };
    }, [active, allowHiddenPresentation, coveredLeft, identity, viewport]);

    return (
      <div
        {...({ src } as Record<string, string>)}
        ref={placementRef}
        data-testid="preview-webview"
        data-workspace-id={workspaceId}
        data-thread-id={threadId}
        data-tab-id={tabId}
        className={className}
        style={{
          width: viewport?.width ?? "100%",
          height: viewport?.height ?? "100%",
          minWidth: 0,
          minHeight: 0,
        }}
      />
    );
  },
);
