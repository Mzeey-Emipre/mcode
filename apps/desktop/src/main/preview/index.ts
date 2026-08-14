/**
 * Public surface of the preview browser subsystem.
 * Wires all IPC handlers and re-exports the symbols that main.ts needs.
 */

export type {
  PreviewPictureReferenceResult,
  PreviewContextReferenceResult,
} from "../../features/preview/capture/handlers.js";

import { ipcMain } from "electron";
import { registerNavigationHandlers } from "../../features/preview/navigation/handlers.js";
import { registerCaptureHandlers, registerWebRequestInterceptor } from "../../features/preview/capture/handlers.js";
import { registerOverlayHandlers } from "../../features/preview/capture/overlay.js";
import { registerSpillHandlers } from "../../features/preview/capture/spill-store.js";
import { registerTabHandlers } from "../../features/preview/tabs/handlers.js";
import { getPerfCounters } from "../../features/preview/observability/perf-counters.js";
import { registerPreviewSurfaceHandlers } from "../../features/preview/surfaces/registry.js";
import { registerDesignModeHandlers } from "../../features/preview/design/handlers.js";
import {
  disposeBrowserAutomationForWindow,
  registerBrowserAutomationHandlers,
} from "../../features/preview/automation/index.js";
import { registerPreviewSessionPolicy } from "../../features/preview/security/electron-session-policy.js";
import { abortOverlayCapture } from "../../features/preview/capture/overlay.js";
import { sessions } from "../../features/preview/state/window-session.js";
import { clearDiscardTimers } from "../../features/preview/tabs/discard-scheduler.js";
import { disposePreviewSurfacesForWindow } from "../../features/preview/surfaces/registry.js";

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
} from "../../features/preview/security/electron-session-policy.js";
export { PREVIEW_POPUP_REQUESTED_CHANNEL } from "../../features/preview/contracts/popup.js";
export type { PreviewPopupRequest } from "../../features/preview/contracts/popup.js";
export { disposeBrowserAutomationForWindow };
