/**
 * Navigation IPC handlers for BrowserSurfaceHost-owned Preview surfaces:
 * sync, navigate, go-back, go-forward, reload, force-reload, open-external,
 * get-navigation-state, plus the secondary browser tools surfaced in the header
 * overflow kebab (clear-cookies, clear-cache, get-zoom, set-zoom).
 */

import { BrowserWindow, ipcMain, shell, type WebContents } from "electron";
import { logger } from "@mcode/shared";
import {
  ensureThreadTabSet,
  getActiveTab,
  getSession,
  getThreadTabSet,
  isAllowedHttpUrl,
  isAllowedPreviewUrl,
  setPreviewLoading,
} from "./preview-session.js";
import { type Bounds, type PreviewSession } from "./preview-session.js";
import { bumpPerf } from "./preview-perf.js";
import {
  resolveLocalFileUrl,
  resolveMcodeWorkspacePreviewUrl,
  looksLikeFilePath,
  validateResumeUrl,
  trustMainProcessFileNavigation,
} from "./preview-local-file.js";
import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";
import { onPreviewHidden, onPreviewVisible } from "./preview-discard-scheduler.js";
import { previewSessionAdapter } from "./preview-session-adapter.js";
import { findAdoptedWebContentsForWindow } from "./preview-webview-adopt.js";

/** Lower bound on the preview zoom factor (25%), matching Chromium's floor. */
const MIN_ZOOM_FACTOR = 0.25;
/** Upper bound on the preview zoom factor (500%), matching Chromium's ceiling. */
const MAX_ZOOM_FACTOR = 5;

type PreviewResolveNavigationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Clamp a requested zoom factor to the supported range and snap to whole percent. */
function clampZoomFactor(factor: number): number {
  const safe = Number.isFinite(factor) ? factor : 1;
  const bounded = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, safe));
  return Math.round(bounded * 100) / 100;
}

/** Return the exact active adopted guest without creating or selecting another surface. */
function getActiveGuest(win: BrowserWindow, session: PreviewSession): WebContents | null {
  const threadId = session.lastPreviewThreadId;
  if (!threadId) return null;
  const tabSet = getThreadTabSet(session, threadId);
  const tab = tabSet?.tabs.find((candidate) => candidate.id === tabSet.activeTabId);
  if (!tab || tab.rendererSurfaceGeneration == null) return null;
  return findAdoptedWebContentsForWindow(
    win.id,
    threadId,
    tab.id,
    tab.rendererSurfaceGeneration,
  );
}

/**
 * True when `input` looks like a bare host (e.g. `example.com`, `sub.x.io/path`,
 * `localhost:3000`) rather than a free-form search query. Heuristic: no
 * whitespace, and the part before the first `/` either contains a dot or is
 * `localhost`/IP and matches `host[:port]` characters. Strings that fail the
 * check fall through to a Google search.
 */
export function looksLikeBareDomain(input: string): boolean {
  if (/\s/.test(input)) return false;
  const hostPart = input.split("/", 1)[0]!;
  if (hostPart.length === 0) return false;
  if (!/^[a-z0-9.\-:]+$/i.test(hostPart)) return false;
  if (hostPart === "localhost" || /^localhost:\d+$/.test(hostPart)) return true;
  // Accept IPv4 dotted quads.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart)) return true;
  // Generic host: must contain at least one dot and end on a non-numeric TLD-ish run.
  if (!hostPart.includes(".")) return false;
  const tld = hostPart.split(":")[0]!.split(".").pop() ?? "";
  return /^[a-z][a-z0-9-]{1,}$/i.test(tld);
}

/** Resolve user omnibox input to a safe preview URL without loading it. */
export async function resolvePreviewNavigationTarget(
  url: string,
  workspacePath?: string | null,
): Promise<PreviewResolveNavigationResult> {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: "empty-url" };

  let target: string;

  if (isMcodeWorkspacePreviewUrl(trimmed)) {
    const resolved = await resolveMcodeWorkspacePreviewUrl(
      trimmed,
      workspacePath?.trim() ?? null,
    );
    if (!resolved.ok) return resolved;
    target = resolved.url;
  } else if (/^https?:\/\//i.test(trimmed)) {
    target = trimmed;
  } else if (/^file:\/\//i.test(trimmed)) {
    const resolved = await resolveLocalFileUrl(trimmed, workspacePath?.trim() ?? null);
    if (!resolved.ok) return resolved;
    target = resolved.url;
  } else if (looksLikeFilePath(trimmed)) {
    const resolved = await resolveLocalFileUrl(trimmed, workspacePath?.trim() ?? null);
    if (!resolved.ok) return resolved;
    target = resolved.url;
  } else if (looksLikeBareDomain(trimmed)) {
    target = `https://${trimmed}`;
  } else {
    target = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }

  if (!isAllowedPreviewUrl(target)) {
    return { ok: false, error: "invalid-url" };
  }
  return { ok: true, url: target };
}

/**
 * Registers all navigation-related IPC handlers:
 * preview:sync, preview:navigate, preview:go-back, preview:go-forward,
 * preview:reload, preview:open-external, preview:get-navigation-state.
 * Call once at app startup.
 */
export function registerNavigationHandlers(): void {
  ipcMain.handle(
    "preview:sync",
    async (
      _event,
      payload: {
        visible: boolean;
        bounds: Bounds | null;
        threadId?: string | null;
        resumeUrlHint?: string | null;
        workspaceId?: string | null;
      },
    ) => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return;

      const s = getSession(win);
      const ws = payload.workspaceId;
      s.workspaceId = typeof ws === "string" && ws.trim().length > 0 ? ws.trim() : null;
      const b = payload.bounds;
      bumpPerf("setPanelBoundsCalls");
      const hasValidBounds = b && b.width >= 4 && b.height >= 4;
      const tid = payload.threadId ?? null;
      const incomingBounds = hasValidBounds
        ? {
            x: Math.round(b.x),
            y: Math.round(b.y),
            width: Math.round(b.width),
            height: Math.round(b.height),
          }
        : null;
      if (hasValidBounds) {
        s.lastBounds = incomingBounds;
        if (tid != null) {
          ensureThreadTabSet(s, tid);
        }
        s.lastPreviewThreadId = tid;
      }
      if (!payload.visible || !incomingBounds) {
        onPreviewHidden(win, s);
        return;
      }

      const hintRaw = payload.resumeUrlHint?.trim() ?? "";
      const hint = hintRaw.length > 0 && isAllowedPreviewUrl(hintRaw) ? hintRaw : null;
      const safeHint = await validateResumeUrl(hint);
      if (tid == null) return;
      const activeTab = getActiveTab(s, tid);
      if (!activeTab.resumeUrl && !activeTab.userCreatedBlank && safeHint) {
        activeTab.resumeUrl = safeHint;
      }
      s.resumePreviewUrl = activeTab.resumeUrl;
      s.lastFavicons = activeTab.faviconUrl ? [activeTab.faviconUrl] : [];
      onPreviewVisible(win, s);
    },
  );

  ipcMain.handle(
    "preview:resolve-navigation",
    async (
      _event,
      url: string,
      workspacePath?: string | null,
    ): Promise<PreviewResolveNavigationResult> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      return resolvePreviewNavigationTarget(url, workspacePath);
    },
  );

  ipcMain.handle(
    "preview:navigate",
    async (
      _event,
      url: string,
      workspacePath?: string | null,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const resolved = await resolvePreviewNavigationTarget(url, workspacePath);
      if (!resolved.ok) return resolved;
      const target = resolved.url;

      const s = getSession(win);
      const guest = getActiveGuest(win, s);
      if (!guest) return { ok: false, error: "preview-unavailable" };
      const activeTab = s.lastPreviewThreadId ? getActiveTab(s, s.lastPreviewThreadId) : null;
      logger.info("Preview: user navigated", { url: target });
      setPreviewLoading(win, s, true);
      trustMainProcessFileNavigation(s, target);
      void guest.loadURL(target);
      s.resumePreviewUrl = target;
      if (activeTab) activeTab.resumeUrl = target;
      return { ok: true };
    },
  );

  ipcMain.handle("preview:go-back", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return false;
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) return false;
    if (guest.canGoBack()) {
      setPreviewLoading(win, s, true);
      guest.goBack();
      return true;
    }
    return false;
  });

  ipcMain.handle("preview:go-forward", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return false;
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) return false;
    if (guest.canGoForward()) {
      setPreviewLoading(win, s, true);
      guest.goForward();
      return true;
    }
    return false;
  });

  ipcMain.handle("preview:reload", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) return;
    setPreviewLoading(win, s, true);
    guest.reload();
  });

  ipcMain.handle("preview:force-reload", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) return;
    setPreviewLoading(win, s, true);
    guest.reloadIgnoringCache();
  });

  ipcMain.handle("preview:clear-cookies", async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    await previewSessionAdapter.clearCookies();
  });

  ipcMain.handle("preview:clear-cache", async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    await previewSessionAdapter.clearCache();
  });

  ipcMain.handle("preview:get-zoom", (_event): number => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return 1;
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) return 1;
    return clampZoomFactor(guest.getZoomFactor());
  });

  ipcMain.handle("preview:set-zoom", (_event, factor: number): number => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return 1;
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) return 1;
    const clamped = clampZoomFactor(factor);
    guest.setZoomFactor(clamped);
    return clamped;
  });

  ipcMain.handle("preview:open-external", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) return;
    const current = guest.getURL();
    if (isAllowedHttpUrl(current)) {
      void shell.openExternal(current).catch(() => {
        /* shell may reject the URL */
      });
    }
  });

  ipcMain.handle("preview:get-navigation-state", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return { canGoBack: false, canGoForward: false };
    const s = getSession(win);
    const guest = getActiveGuest(win, s);
    if (!guest) {
      return { canGoBack: false, canGoForward: false };
    }
    return {
      canGoBack: guest.canGoBack(),
      canGoForward: guest.canGoForward(),
    };
  });
}
