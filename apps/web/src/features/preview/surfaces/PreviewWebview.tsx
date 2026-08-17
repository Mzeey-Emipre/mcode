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
import {
  browserSurfaceHost,
  browserSurfacePresentationCoordinator,
} from "./BrowserSurfaceHostRoot";
import type {
  BrowserSurfacePresentationRegistration,
  BrowserSurfacePresentationSource,
} from "./BrowserSurfacePresentationCoordinator";
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
  /** Whether this mounted surface currently owns the visible panel presentation. */
  readonly presentationActive?: boolean;
  /** Renderer path that owns this surface's presentation intent. */
  readonly presentationSource?: BrowserSurfacePresentationSource;
  /** Optional explicit overlap retained for focused renderer coverage. */
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
      presentationActive = true,
      presentationSource = "panel",
      coveredLeft,
      viewport,
      onPageStatus,
      onNavigationStateChange,
    },
    forwardedRef,
  ) {
    const placementRef = useRef<HTMLDivElement | null>(null);
    const presentationRegistrationRef = useRef<BrowserSurfacePresentationRegistration | null>(null);
    const presentationIntentRef = useRef({
      active,
      allowHiddenPresentation,
      coveredLeft,
      presentationActive,
      presentationSource,
      viewport,
    });
    presentationIntentRef.current = {
      active,
      allowHiddenPresentation,
      coveredLeft,
      presentationActive,
      presentationSource,
      viewport,
    };
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
    const publishPresentation = useCallback((pageState: BrowserSurfacePageState | null): void => {
      const current = presentationIntentRef.current;
      const placement = placementRef.current;
      const activePresentation = current.allowHiddenPresentation ||
        (current.active && current.presentationActive);
      browserSurfacePresentationCoordinator.publish(identity, {
        source: current.presentationSource,
        active: activePresentation && (current.allowHiddenPresentation || !placement?.closest("[inert], [aria-hidden='true']")),
        anchor: placement,
        pageState,
        viewport: current.viewport,
        ...(current.coveredLeft === undefined ? {} : { coveredLeft: current.coveredLeft }),
        inputEnabled: current.presentationSource === "panel",
        accessible: current.presentationSource === "panel",
      }, presentationRegistrationRef.current?.token);
    }, [identity]);

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
      const registration = placementRef.current
        ? browserSurfacePresentationCoordinator.registerAnchor(identity, presentationSource, placementRef.current)
        : null;
      presentationRegistrationRef.current = registration;
      stateRef.current = initial;
      callbacksRef.current.onPageStatus?.(previewStatus(initial));
      publishPresentation(initial);
      const unsubscribe = browserSurfaceHost.subscribe(identity, (state) => {
        stateRef.current = state;
        callbacksRef.current.onPageStatus?.(previewStatus(state));
        callbacksRef.current.onNavigationStateChange?.(state.navigation ?? {
          canGoBack: false,
          canGoForward: false,
        });
        publishPresentation(state);
      });
      return () => {
        unsubscribe();
        if (presentationRegistrationRef.current === registration) {
          registration?.release();
          presentationRegistrationRef.current = null;
        }
      };
    }, [ensureViewportCoordinator, identity, presentationSource, publishPresentation, tabId, threadId, workspaceId]);

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
      const update = (): void => {
        publishPresentation(stateRef.current);
      };
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
      observer?.observe(placement);
      window.addEventListener("resize", update);
      update();
      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", update);
      };
    }, [active, allowHiddenPresentation, coveredLeft, identity, presentationActive, presentationSource, publishPresentation, viewport]);

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
          pointerEvents: "none",
        }}
      />
    );
  },
);
