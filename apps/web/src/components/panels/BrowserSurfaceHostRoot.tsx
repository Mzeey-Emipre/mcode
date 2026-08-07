import { useCallback } from "react";
import {
  BrowserSurfaceHost,
  WebIframeBrowserSurfaceAdapter,
} from "@/services/browser-surfaces";
import { useBrowserAutomationStore } from "@/stores/browserAutomationStore";

let surfaceRoot: HTMLDivElement | null = null;

/** Renderer-window Browser surface host used by the web iframe adapter. */
export const browserSurfaceHost = new BrowserSurfaceHost({
  adapterFactory: (identity, generation) => new WebIframeBrowserSurfaceAdapter(
    identity,
    generation,
    {
      root: surfaceRoot ?? document.body,
      title: "Web browser preview",
      onLoad: (surfaceIdentity) => {
        useBrowserAutomationStore.getState().refreshTarget(
          surfaceIdentity.scope.id,
          surfaceIdentity.tabId,
        );
      },
    },
  ),
});

/** Mounts the single Browser surface root for this renderer window. */
export function BrowserSurfaceHostRoot() {
  const setRoot = useCallback((node: HTMLDivElement | null): void => {
    surfaceRoot = node;
  }, []);

  return (
    <div
      ref={setRoot}
      data-browser-surface-host=""
      className="pointer-events-none fixed inset-0 z-30"
    />
  );
}
