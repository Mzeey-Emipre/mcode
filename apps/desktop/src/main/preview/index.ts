/**
 * Public surface of the preview browser subsystem.
 * Wires all IPC handlers and re-exports the symbols that main.ts needs.
 */

export { disposePreviewForWindow } from "./preview-lifecycle.js";
export type {
  PreviewPictureReferenceResult,
  PreviewContextReferenceResult,
} from "./preview-capture.js";

import { ipcMain, session } from "electron";
import { registerNavigationHandlers } from "./preview-navigation.js";
import { registerCaptureHandlers, registerWebRequestInterceptor } from "./preview-capture.js";
import { registerOverlayHandlers } from "./preview-overlay.js";
import { registerSpillHandlers } from "./preview-spill.js";
import { registerTabHandlers } from "./preview-tabs.js";
import { getPerfCounters } from "./preview-perf.js";
import { registerWebviewAdoptHandlers } from "./preview-webview-adopt.js";
import { registerDesignModeHandlers } from "./preview-design-mode.js";

/** Registers all preview:* IPC handlers. Call once at app startup. */
export function registerPreviewBrowserHandlers(): void {
  const previewPartition = session.fromPartition("persist:mcode-preview");
  previewPartition.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });

  registerNavigationHandlers();
  registerCaptureHandlers();
  registerWebRequestInterceptor(previewPartition);
  registerOverlayHandlers();
  registerSpillHandlers();
  registerTabHandlers();
  registerWebviewAdoptHandlers();
  registerDesignModeHandlers();
  ipcMain.handle("preview:get-perf-counters", () => getPerfCounters());
}
