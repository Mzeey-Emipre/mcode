import type { WebContents } from "electron";
import { getActiveTab, sessions, type PreviewSession } from "./preview-session.js";
import { findAdoptedWebContentsForWindow } from "./preview-webview-adopt.js";

/**
 * Resolves the active Preview guest WebContents across WebContentsView and adopted webview hosts.
 */
export function resolveActivePreviewWebContents(s: PreviewSession): WebContents | null {
  const threadId = s.lastPreviewThreadId;
  if (threadId) {
    const activeTab = getActiveTab(s, threadId);
    const windowId = [...sessions].find(([, candidate]) => candidate === s)?.[0];
    const adopted = windowId === undefined
      ? null
      : findAdoptedWebContentsForWindow(windowId, threadId, activeTab.id);
    if (adopted && !adopted.isDestroyed()) return adopted;
  }
  if (s.view && !s.view.webContents.isDestroyed()) return s.view.webContents;
  return null;
}
