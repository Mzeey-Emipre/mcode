import { useCallback, useEffect } from "react";
import {
  BrowserSurfaceHost,
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
    return surfaceBridge.onPopupRequested((request) => {
      const source = browserSurfaceHost.getSnapshot(request.sourceSurface.identity);
      if (!source || source.generation !== request.sourceSurface.generation) return;
      void usePreviewTabsStore.getState().openPage(request.sourceSurface.identity.scope.id, {
        activate: request.initiator === "human",
        focusOmnibox: false,
        initialAddress: request.address,
        renderingHost: "webview",
      });
    });
  }, []);

  return (
    <div
      ref={setRoot}
      data-browser-surface-host=""
      className="pointer-events-none fixed inset-0 z-30"
    />
  );
}
