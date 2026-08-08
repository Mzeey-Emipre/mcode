import { useCallback, useEffect } from "react";
import {
  BrowserSurfaceHost,
  type BrowserSurfaceIdentity,
  ElectronWebviewBrowserSurfaceAdapter,
  normalizeElectronWebviewSurfaceAddress,
  WebIframeBrowserSurfaceAdapter,
} from "@/services/browser-surfaces";
import {
  invalidateBrowserAutomationTargetObservation,
  useBrowserAutomationStore,
} from "@/stores/browserAutomationStore";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";

let surfaceRoot: HTMLDivElement | null = null;

function parsePreviewScopeKey(scopeKey: string): { workspaceId: string; scopeId: string } | null {
  try {
    const parsed = JSON.parse(scopeKey) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) return null;
    return { workspaceId: parsed[0], scopeId: parsed[1] };
  } catch {
    return null;
  }
}

function parseBrowserTargetKey(targetKey: string): BrowserSurfaceIdentity | null {
  try {
    const parsed = JSON.parse(targetKey) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed.some((value) => typeof value !== "string")
    ) return null;
    return {
      workspaceId: parsed[0] as string,
      scope: { kind: "thread", id: parsed[1] as string },
      tabId: parsed[2] as string,
    };
  } catch {
    return null;
  }
}

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
          renderingHost: "webview",
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
      const scope = parsePreviewScopeKey(scopeKey);
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
        const identity = parseBrowserTargetKey(targetKey);
        if (!identity) continue;
        browserSurfaceHost.setControlled(
          identity,
          state.controllers.get(targetKey)?.controller === "agent",
        );
      }
    };
    synchronizeControllers(useBrowserAutomationStore.getState());
    return useBrowserAutomationStore.subscribe(synchronizeControllers);
  }, []);

  useEffect(() => {
    const releases = new Map<string, () => void>();
    const synchronizeOperations = (
      state: ReturnType<typeof useBrowserAutomationStore.getState>,
    ): void => {
      for (const [requestKey, release] of releases) {
        if (state.activeRequests.has(requestKey)) continue;
        release();
        releases.delete(requestKey);
      }
      for (const [requestKey, active] of state.activeRequests) {
        if (releases.has(requestKey)) continue;
        const identity: BrowserSurfaceIdentity = {
          workspaceId: active.dispatch.scope.workspaceId,
          scope: { kind: "thread", id: active.dispatch.target.threadId },
          tabId: active.dispatch.target.tabId,
        };
        const generation = browserSurfaceHost.getSnapshot(identity)?.generation;
        if (generation === undefined) continue;
        const operation = active.dispatch.request.operation;
        const capturesSurface = operation === "snapshot" || operation === "screenshot" ||
          operation === "inspect" && active.dispatch.request.args.includeScreenshot;
        releases.set(
          requestKey,
          capturesSurface
            ? browserSurfaceHost.pinCapture(identity, generation)
            : browserSurfaceHost.pinOperation(identity, generation),
        );
      }
    };
    synchronizeOperations(useBrowserAutomationStore.getState());
    const unsubscribe = useBrowserAutomationStore.subscribe(synchronizeOperations);
    return () => {
      unsubscribe();
      for (const release of releases.values()) release();
    };
  }, []);

  useEffect(() => {
    const dispose = (): void => browserSurfaceHost.disposeHost();
    window.addEventListener("beforeunload", dispose);
    return () => window.removeEventListener("beforeunload", dispose);
  }, []);

  return (
    <div
      ref={setRoot}
      data-browser-surface-host=""
      className="pointer-events-none fixed inset-0 z-30"
    />
  );
}
