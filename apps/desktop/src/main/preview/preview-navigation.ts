/**
 * Navigation IPC handlers for the embedded preview WebContentsView:
 * sync, navigate, go-back, go-forward, reload, open-external, get-navigation-state.
 */

import { BrowserWindow, ipcMain, shell } from "electron";
import { logger } from "@mcode/shared";
import {
  ensureThreadTabSet,
  getActiveTab,
  getSession,
  guestUrlNeedsHttpRestore,
  isAllowedHttpUrl,
  isAllowedPreviewUrl,
  resetIdle,
  applyPageStatus,
  setPreviewLoading,
  syncActiveTabFromSession,
} from "./preview-session.js";
import { ensureView, hidePreview, mountView, unmountView } from "./preview-lifecycle.js";
import { type Bounds } from "./preview-session.js";
import { bumpPerf } from "./preview-perf.js";
import {
  resolveLocalFileUrl,
  resolveMcodeWorkspacePreviewUrl,
  looksLikeFilePath,
  validateResumeUrl,
  trustMainProcessFileNavigation,
} from "./preview-local-file.js";
import { isMcodeWorkspacePreviewUrl } from "@mcode/contracts";

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
      if (!payload.visible || !b || b.width < 4 || b.height < 4) {
        hidePreview(win, s);
        return;
      }

      const prevBounds = s.lastBounds;
      const sameBounds =
        prevBounds !== null &&
        prevBounds.x === b.x &&
        prevBounds.y === b.y &&
        prevBounds.width === b.width &&
        prevBounds.height === b.height;
      if (sameBounds) {
        bumpPerf("setPanelBoundsNoopSkips");
      } else {
        bumpPerf("setPanelBoundsViewportUpdates");
      }

      s.lastBounds = { x: b.x, y: b.y, width: b.width, height: b.height };

      const hintRaw = payload.resumeUrlHint?.trim() ?? "";
      const hint = hintRaw.length > 0 && isAllowedPreviewUrl(hintRaw) ? hintRaw : null;
      const tid = payload.threadId ?? null;
      const switchedThread = tid != null && tid !== s.lastPreviewThreadId;
      const safeHint = await validateResumeUrl(hint);

      // Detach the prior thread's active view BEFORE picking the new one so
      // we never have two views mounted simultaneously.
      if (switchedThread && s.view) {
        unmountView(win, s.view);
      }
      if (tid != null) {
        ensureThreadTabSet(s, tid);
      }
      s.lastPreviewThreadId = tid;

      // ensureView resolves the (now-current) thread's active tab and either
      // returns its existing webContents or creates a fresh one. On a thread
      // switch this picks up the warm WebContentsView the user left behind,
      // so their scroll/form state survives.
      const view = ensureView(win, s);
      view.setBounds(s.lastBounds);
      mountView(win, view);

      const wc = view.webContents;
      if (!wc.isDestroyed()) {
        const current = wc.getURL();
        const activeTab = tid != null ? getActiveTab(s, tid) : null;

        // Decide whether to navigate. The principle: only navigate when the
        // view is blank/error (just created) and we have a URL worth loading.
        // A warm tab that already has its document loaded must NOT be touched.
        const needsRestore = guestUrlNeedsHttpRestore(current);
        const restoreTarget = needsRestore
          ? (safeHint ?? activeTab?.resumeUrl ?? null)
          : null;

        if (restoreTarget) {
          logger.info("Preview: restoring URL", {
            url: restoreTarget,
            switchedThread,
            threadId: tid,
          });
          setPreviewLoading(win, s, true);
          if (restoreTarget.startsWith("file:")) {
            trustMainProcessFileNavigation(s, restoreTarget);
          }
          void wc.loadURL(restoreTarget);
          if (activeTab) activeTab.resumeUrl = restoreTarget;
          s.resumePreviewUrl = restoreTarget;
        } else if (switchedThread && activeTab) {
          // Warm tab on the new thread: mirror its state onto the session so the
          // omnibox shows the right URL without a network round-trip.
          s.resumePreviewUrl = activeTab.resumeUrl;
          s.lastFavicons = activeTab.faviconUrl ? [activeTab.faviconUrl] : [];
          const liveUrl = wc.getURL();
          applyPageStatus(win, s, {
            type: "reset",
            status: {
              url: liveUrl.length > 0 ? liveUrl : activeTab.resumeUrl,
              title: wc.getTitle() || activeTab.title,
              favicon: activeTab.faviconUrl ?? null,
              phase: "loaded",
            },
          });
        }
      }
      resetIdle(win, s);
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
        // Fallback: treat as a Google search query. Mirrors dpcode's
        // SEARCH_URL_PREFIX behavior so the omnibox "Search or enter URL"
        // affordance always lands somewhere when the user just types words.
        target = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
      }

      if (!isAllowedPreviewUrl(target)) {
        return { ok: false, error: "invalid-url" };
      }

      const s = getSession(win);
      if (!s.lastBounds) {
        return { ok: false, error: "no-bounds" };
      }

      const view = ensureView(win, s);
      view.setBounds(s.lastBounds);
      mountView(win, view);
      logger.info("Preview: user navigated", { url: target });
      setPreviewLoading(win, s, true);
      trustMainProcessFileNavigation(s, target);
      void view.webContents.loadURL(target);
      s.resumePreviewUrl = target;
      syncActiveTabFromSession(s);
      resetIdle(win, s);
      return { ok: true };
    },
  );

  ipcMain.handle("preview:go-back", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return false;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return false;
    if (s.view.webContents.canGoBack()) {
      setPreviewLoading(win, s, true);
      s.view.webContents.goBack();
      resetIdle(win, s);
      return true;
    }
    return false;
  });

  ipcMain.handle("preview:go-forward", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return false;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return false;
    if (s.view.webContents.canGoForward()) {
      setPreviewLoading(win, s, true);
      s.view.webContents.goForward();
      resetIdle(win, s);
      return true;
    }
    return false;
  });

  ipcMain.handle("preview:reload", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return;
    setPreviewLoading(win, s, true);
    s.view.webContents.reload();
    resetIdle(win, s);
  });

  ipcMain.handle("preview:open-external", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return;
    const current = s.view.webContents.getURL();
    if (isAllowedHttpUrl(current)) {
      void shell.openExternal(current).catch(() => {
        /* shell may reject the URL */
      });
    }
  });

  ipcMain.handle("preview:open-guest-devtools", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return;
    // Detached so the DevTools window does not steal pixels from the surfaceRef
    // region (which the BrowserView is locked onto).
    s.view.webContents.openDevTools({ mode: "detach" });
  });

  ipcMain.handle("preview:get-navigation-state", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return { canGoBack: false, canGoForward: false };
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) {
      return { canGoBack: false, canGoForward: false };
    }
    return {
      canGoBack: s.view.webContents.canGoBack(),
      canGoForward: s.view.webContents.canGoForward(),
    };
  });
}
