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
import { registerBrowserAutomationHandlers } from "../browser-automation/index.js";
import { registerPreviewClipboardPermissionHandlers } from "./preview-clipboard-trust.js";

/** Registers all preview:* IPC handlers. Call once at app startup. */
export function registerPreviewBrowserHandlers(): void {
  const previewPartition = session.fromPartition("persist:mcode-preview");
  registerPreviewClipboardPermissionHandlers(previewPartition, ipcMain);
  previewPartition.on("will-download", (event) => event.preventDefault());

  registerNavigationHandlers();
  registerCaptureHandlers();
  registerWebRequestInterceptor(previewPartition);
  registerOverlayHandlers();
  registerSpillHandlers();
  registerTabHandlers();
  registerWebviewAdoptHandlers();
  registerDesignModeHandlers();
  registerBrowserAutomationHandlers();
  ipcMain.handle("preview:get-perf-counters", () => getPerfCounters());
}
