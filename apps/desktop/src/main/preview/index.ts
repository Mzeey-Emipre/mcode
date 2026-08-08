/**
 * Public surface of the preview browser subsystem.
 * Wires all IPC handlers and re-exports the symbols that main.ts needs.
 */

export { disposePreviewForWindow } from "./preview-lifecycle.js";
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
