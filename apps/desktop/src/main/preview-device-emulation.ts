import type { WebContents } from "electron";

/** CSS viewport and visual scale applied to one native preview guest. */
export interface PreviewViewportEmulationOptions {
  readonly active: boolean;
  readonly cssViewport: { readonly width: number; readonly height: number };
  readonly scale: number;
}

/** Apply or clear Chromium device emulation for the native preview guest. */
export function applyPreviewViewportEmulation(
  webContents: WebContents,
  options: PreviewViewportEmulationOptions,
): void {
  if (webContents.isDestroyed()) return;
  // Chromium can crash on Windows when either emulation API is called before
  // a real document has loaded. The next sync or did-finish-load event applies
  // the requested state after the guest leaves about:blank.
  const guestUrl = webContents.getURL();
  if (!guestUrl || guestUrl.startsWith("about:")) return;
  if (!options.active) {
    webContents.disableDeviceEmulation();
    return;
  }
  const viewport = {
    width: options.cssViewport.width,
    height: options.cssViewport.height,
  };
  webContents.enableDeviceEmulation({
    screenPosition: "mobile",
    screenSize: viewport,
    viewPosition: { x: 0, y: 0 },
    viewSize: viewport,
    deviceScaleFactor: 1,
    scale: options.scale,
  });
}
