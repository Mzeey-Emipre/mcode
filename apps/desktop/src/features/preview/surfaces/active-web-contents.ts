import type { WebContents } from "electron";
import { getActiveTab, sessions, type PreviewSession } from "../state/window-session.js";
import { findAdoptedWebContentsForWindow } from "./registry.js";

/**
 * Resolves the active Preview guest WebContents from the exact adopted surface.
 */
export function resolveActivePreviewWebContents(s: PreviewSession): WebContents | null {
  const threadId = s.lastPreviewThreadId;
  if (!threadId) return null;
  const activeTab = getActiveTab(s, threadId);
  const windowId = [...sessions].find(([, candidate]) => candidate === s)?.[0];
  const adopted = windowId === undefined
    ? null
    : findAdoptedWebContentsForWindow(windowId, threadId, activeTab.id);
  return adopted && !adopted.isDestroyed() ? adopted : null;
}
