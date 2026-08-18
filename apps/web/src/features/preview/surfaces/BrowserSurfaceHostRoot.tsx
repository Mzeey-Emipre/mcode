import { useCallback, useEffect } from "react";
import {
  BrowserSurfaceHost,
  type BrowserSurfaceIdentity,
  ElectronWebviewBrowserSurfaceAdapter,
  normalizeElectronWebviewSurfaceAddress,
  WebIframeBrowserSurfaceAdapter,
} from "../browser-surfaces";
import {
  invalidateBrowserAutomationTargetObservation,
  parseBrowserAutomationScopeKey,
  parseBrowserAutomationTargetKey,
  useBrowserAutomationStore,
} from "../automation/browserAutomationStore";
import { usePreviewTabsStore } from "../state/previewTabsStore";
import { BrowserSurfacePresentationCoordinator } from "./BrowserSurfacePresentationCoordinator";

let surfaceRoot: HTMLDivElement | null = null;

/** Renderer-window Browser surface host used by the web iframe adapter. */
export const browserSurfaceHost = new BrowserSurfaceHost({
  normalizeAddress: window.desktopBridge?.preview?.surface
    ? normalizeElectronWebviewSurfaceAddress
    : undefined,
  adapterFactory: (identity, generation) => {
    const root = surfaceRoot ?? document.body;
    if (window.desktopBridge?.preview?.surface) {
      return new ElectronWebviewBrowserSurfaceAdapter(identity, generation, {
        root,
        title: "Electron browser preview",
        onHumanInput: (surfaceIdentity) => {
          if (surfaceIdentity.scope.kind !== "thread") return;
          invalidateBrowserAutomationTargetObservation(
            surfaceIdentity.workspaceId,
            surfaceIdentity.scope.id,
            surfaceIdentity.tabId,
          );
        },
      });
    }
    return new WebIframeBrowserSurfaceAdapter(identity, generation, {
      root,
      title: "Web browser preview",
      onLoad: (surfaceIdentity) => {
        useBrowserAutomationStore.getState().refreshTarget(
          surfaceIdentity.workspaceId,
          surfaceIdentity.scope.id,
          surfaceIdentity.tabId,
        );
      },
    });
  },
});

/** Renderer-only authority for Browser surface placement and input state. */
export const browserSurfacePresentationCoordinator = new BrowserSurfacePresentationCoordinator(
  browserSurfaceHost,
);

/** Mounts the single Browser surface root for this renderer window. */
export function BrowserSurfaceHostRoot() {
  const setRoot = useCallback((node: HTMLDivElement | null): void => {
    surfaceRoot = node;
  }, []);

  useEffect(() => {
    const surfaceBridge = window.desktopBridge?.preview?.surface;
    if (!surfaceBridge) return;
    const stopPopups = surfaceBridge.onPopupRequested((request) => {
      const source = browserSurfaceHost.getSnapshot(request.sourceSurface.identity);
      if (!source || source.generation !== request.sourceSurface.generation) return;
      void usePreviewTabsStore.getState().openPage(
        request.sourceSurface.identity.workspaceId,
        request.sourceSurface.identity.scope.id,
        {
          activate: request.initiator === "human",
          focusOmnibox: false,
          initialAddress: request.address,
        },
      );
    });
    const stopDiscards = surfaceBridge.onDiscardRequested((request) => {
      browserSurfaceHost.discard(request.identity, request.generation);
    });
    return () => {
      stopPopups();
      stopDiscards();
    };
  }, []);

  useEffect(() => usePreviewTabsStore.subscribe((state, previous) => {
    for (const [scopeKey, previousSet] of Object.entries(previous.tabSetByScope)) {
      if (!previousSet) continue;
      const currentSet = state.tabSetByScope[scopeKey];
      const currentIds = new Set(currentSet?.tabs.map((tab) => tab.id) ?? []);
      const scope = parseBrowserAutomationScopeKey(scopeKey);
      if (!scope) continue;
      for (const tab of previousSet.tabs) {
        if (currentIds.has(tab.id)) continue;
        browserSurfaceHost.dispose({
          workspaceId: scope.workspaceId,
          scope: { kind: "thread", id: scope.scopeId },
          tabId: tab.id,
        });
      }
    }
  }), []);

  useEffect(() => {
    const synchronizeControllers = (
      state: ReturnType<typeof useBrowserAutomationStore.getState>,
      previous?: ReturnType<typeof useBrowserAutomationStore.getState>,
    ): void => {
      const targetKeys = new Set([
        ...state.controllers.keys(),
        ...(previous?.controllers.keys() ?? []),
      ]);
      for (const targetKey of targetKeys) {
        const target = parseBrowserAutomationTargetKey(targetKey);
        if (!target) continue;
        const identity: BrowserSurfaceIdentity = {
          workspaceId: target.workspaceId,
          scope: { kind: "thread", id: target.threadId },
          tabId: target.tabId,
        };
        browserSurfaceHost.setControlled(
          identity,
          state.controllers.get(targetKey)?.controller === "agent",
        );
      }
    };
    synchronizeControllers(useBrowserAutomationStore.getState());
    const unsubscribeStore = useBrowserAutomationStore.subscribe(synchronizeControllers);
    const unsubscribeSurfaces = browserSurfaceHost.subscribeMaterialized(() => {
      synchronizeControllers(useBrowserAutomationStore.getState());
    });
    return () => {
      unsubscribeStore();
      unsubscribeSurfaces();
    };
  }, []);

  useEffect(() => {
    const releases = new Map<string, { generation: number; release: () => void }>();
    const synchronizeOperations = (
      state: ReturnType<typeof useBrowserAutomationStore.getState>,
    ): void => {
      for (const [requestKey, pinned] of releases) {
        if (state.activeRequests.has(requestKey)) continue;
        pinned.release();
        releases.delete(requestKey);
      }
      for (const [requestKey, active] of state.activeRequests) {
        const identity: BrowserSurfaceIdentity = {
          workspaceId: active.dispatch.scope.workspaceId,
          scope: { kind: "thread", id: active.dispatch.target.threadId },
          tabId: active.dispatch.target.tabId,
        };
        const metadata = browserSurfaceHost.inspect(identity);
        if (!metadata) continue;
        const generation = browserSurfaceHost.getSnapshot(identity)?.generation ??
          browserSurfaceHost.ensure(identity).generation;
        const existing = releases.get(requestKey);
        if (existing?.generation === generation) continue;
        existing?.release();
        const operation = active.dispatch.request.operation;
        const capturesSurface = operation === "snapshot" || operation === "screenshot" ||
          operation === "inspect" && active.dispatch.request.args.includeScreenshot;
        const release = capturesSurface
          ? browserSurfaceHost.pinCapture(identity, generation)
          : browserSurfaceHost.pinOperation(identity, generation);
        releases.set(requestKey, { generation, release });
      }
    };
    synchronizeOperations(useBrowserAutomationStore.getState());
    const unsubscribeStore = useBrowserAutomationStore.subscribe(synchronizeOperations);
    const unsubscribeSurfaces = browserSurfaceHost.subscribeMaterialized(() => {
      synchronizeOperations(useBrowserAutomationStore.getState());
    });
    return () => {
      unsubscribeStore();
      unsubscribeSurfaces();
      for (const pinned of releases.values()) pinned.release();
    };
  }, []);

  useEffect(() => {
    const dispose = (event: PageTransitionEvent): void => {
      if (event.persisted) return;
      browserSurfacePresentationCoordinator.dispose();
      browserSurfaceHost.disposeHost();
    };
    window.addEventListener("pagehide", dispose);
    return () => window.removeEventListener("pagehide", dispose);
  }, []);

  return (
    <div
      ref={setRoot}
      data-browser-surface-host=""
      className="pointer-events-none fixed inset-0 z-30"
    />
  );
}
