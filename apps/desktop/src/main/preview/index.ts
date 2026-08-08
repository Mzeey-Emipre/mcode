/**
 * Public surface of the preview browser subsystem.
 * Wires all IPC handlers and re-exports the symbols that main.ts needs.
 */

export type {
  PreviewPictureReferenceResult,
  PreviewContextReferenceResult,
} from "./preview-capture.js";

import { ipcMain } from "electron";
import { registerNavigationHandlers } from "./preview-navigation.js";
import { registerCaptureHandlers, registerWebRequestInterceptor } from "./preview-capture.js";
import { registerOverlayHandlers } from "./preview-overlay.js";
import { registerSpillHandlers } from "./preview-spill.js";
import { registerTabHandlers } from "./preview-tabs.js";
import { getPerfCounters } from "./preview-perf.js";
import { registerPreviewSurfaceHandlers } from "./preview-webview-adopt.js";
import { registerDesignModeHandlers } from "./preview-design-mode.js";
import { registerBrowserAutomationHandlers } from "../browser-automation/index.js";
import { registerPreviewSessionPolicy } from "./preview-session-adapter.js";
import { abortOverlayCapture } from "./preview-overlay.js";
import { clearDiscardTimers, sessions } from "./preview-session.js";
import { disposePreviewSurfacesForWindow } from "./preview-webview-adopt.js";

/** Releases Preview resources owned by one closing renderer window. */
export function disposePreviewForWindow(win: import("electron").BrowserWindow): void {
  const session = sessions.get(win.id);
  if (session) {
    abortOverlayCapture(session, "capture-interrupted");
    clearDiscardTimers(session);
    session.consoleBuffer.length = 0;
    session.failedRequestBuffer.length = 0;
    sessions.delete(win.id);
  }
  disposePreviewSurfacesForWindow(win.id);
}

/** Registers all preview:* IPC handlers. Call once at app startup. */
export function registerPreviewBrowserHandlers(): void {
  const previewPartition = registerPreviewSessionPolicy();

  registerNavigationHandlers();
  registerCaptureHandlers();
  registerWebRequestInterceptor(previewPartition);
  registerOverlayHandlers();
  registerSpillHandlers();
  registerTabHandlers();
  registerPreviewSurfaceHandlers();
  registerDesignModeHandlers();
  registerBrowserAutomationHandlers();
  ipcMain.handle("preview:get-perf-counters", () => getPerfCounters());
}

export {
  PREVIEW_PARTITION,
  PreviewSessionAdapter,
  previewSessionAdapter,
} from "./preview-session-adapter.js";
export { PREVIEW_POPUP_REQUESTED_CHANNEL } from "./preview-popup-contract.js";
export type { PreviewPopupRequest } from "./preview-popup-contract.js";
