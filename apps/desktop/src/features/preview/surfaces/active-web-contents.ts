import type { WebContents } from "electron";
import { getActiveTab, sessions, type PreviewSession } from "../state/window-session.js";
import { findAdoptedWebContentsForWindow } from "./registry.js";

/**
 * Resolves the active Preview guest WebContents for one window from the exact adopted surface.
 */
export function resolveActivePreviewWebContentsForWindow(windowId: number, s: PreviewSession): WebContents | null {
  const threadId = s.lastPreviewThreadId;
  if (!threadId) return null;
  const activeTab = getActiveTab(s, threadId);
  const adopted = findAdoptedWebContentsForWindow(windowId, threadId, activeTab.id);
  return adopted && !adopted.isDestroyed() ? adopted : null;
}

/** Resolves the active Preview guest WebContents from the exact adopted surface. */
export function resolveActivePreviewWebContents(s: PreviewSession): WebContents | null {
  const windowId = [...sessions].find(([, candidate]) => candidate === s)?.[0];
  return windowId === undefined ? null : resolveActivePreviewWebContentsForWindow(windowId, s);
}
