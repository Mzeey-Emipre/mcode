import * as NodePath from "node:path";
import { PREVIEW_PARTITION } from "./electron-session-policy.js";

/** Mutable web preferences received with Electron's will-attach-webview event. */
export interface PreviewWebviewPreferences {
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  devTools?: boolean;
  preload?: string;
  preloadURL?: string;
}

/** Mutable attachment parameters received with Electron's will-attach-webview event. */
export interface PreviewWebviewAttachParams {
  partition?: string;
  preload?: string;
}

/** Resolves the only preload that preview webviews may execute. */
export function resolvePreviewGuestPreloadPath(mainBundleDirectory: string): string {
  return NodePath.join(mainBundleDirectory, "..", "preload", "preview-guest-preload.cjs");
}

/** Applies the fixed sandbox and preload policy to an attaching preview webview. */
export function hardenPreviewWebviewAttachment(
  webPreferences: PreviewWebviewPreferences,
  params: PreviewWebviewAttachParams,
  guestPreloadPath: string,
): void {
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.devTools = true;
  webPreferences.preload = guestPreloadPath;
  delete webPreferences.preloadURL;
  params.partition = PREVIEW_PARTITION;
  params.preload = guestPreloadPath;
}
