/**
 * Public surface of the Preview feature.
 * Wires all IPC handlers and re-exports the symbols that app composition roots need.
 */

export type {
  PreviewPictureReferenceResult,
  PreviewContextReferenceResult,
} from "./capture/handlers.js";

import { ipcMain } from "electron";
import { registerNavigationHandlers } from "./navigation/handlers.js";
import { registerCaptureHandlers, registerWebRequestInterceptor } from "./capture/handlers.js";
import { registerOverlayHandlers } from "./capture/overlay.js";
import { registerSpillHandlers } from "./capture/spill-store.js";
import { registerTabHandlers } from "./tabs/handlers.js";
import { getPerfCounters } from "./observability/perf-counters.js";
import { registerPreviewSurfaceHandlers } from "./surfaces/registry.js";
import { registerDesignModeHandlers } from "./design/handlers.js";
import { registerBrowserAutomationHandlers } from "./automation/index.js";
import { registerPreviewSessionPolicy } from "./security/electron-session-policy.js";
import { abortOverlayCapture } from "./capture/overlay.js";
import { sessions } from "./state/window-session.js";
import { clearDiscardTimers } from "./tabs/discard-scheduler.js";
import { disposePreviewSurfacesForWindow } from "./surfaces/registry.js";

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
export function registerPreviewBrowserHandlers(platform: NodeJS.Platform): void {
  const previewPartition = registerPreviewSessionPolicy();

  registerNavigationHandlers();
  registerCaptureHandlers();
  registerWebRequestInterceptor(previewPartition);
  registerOverlayHandlers();
  registerSpillHandlers();
  registerTabHandlers();
  registerPreviewSurfaceHandlers();
  registerDesignModeHandlers();
  registerBrowserAutomationHandlers(platform);
  ipcMain.handle("preview:get-perf-counters", () => getPerfCounters());
}

export {
  PREVIEW_PARTITION,
  PreviewSessionAdapter,
  previewSessionAdapter,
} from "./security/electron-session-policy.js";
export { PREVIEW_POPUP_REQUESTED_CHANNEL } from "./contracts/popup.js";
export type { PreviewPopupRequest } from "./contracts/popup.js";
export {
  disposeBrowserAutomationForWindow,
} from "./automation/index.js";
export {
  hardenPreviewWebviewAttachment,
  resolvePreviewGuestPreloadPath,
} from "./security/webview-attachment-policy.js";
export type {
  PreviewWebviewAttachParams,
  PreviewWebviewPreferences,
} from "./security/webview-attachment-policy.js";
export { resolveMcodeWorkspacePreviewUrl } from "./navigation/local-file.js";
