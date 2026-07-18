/**
 * Navigation IPC handlers for the embedded preview WebContentsView:
 * sync, navigate, go-back, go-forward, reload, force-reload, open-external,
 * get-navigation-state, plus the secondary browser tools surfaced in the header
 * overflow kebab (clear-cookies, clear-cache, get-zoom, set-zoom).
 */

import { BrowserWindow, ipcMain, session as electronSession, shell } from "electron";
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
import { onPreviewHidden, onPreviewVisible } from "./preview-discard-scheduler.js";

/** Lower bound on the preview zoom factor (25%), matching Chromium's floor. */
const MIN_ZOOM_FACTOR = 0.25;
/** Upper bound on the preview zoom factor (500%), matching Chromium's ceiling. */
const MAX_ZOOM_FACTOR = 5;
/** Shared Electron storage partition for native and renderer-hosted previews. */
const PREVIEW_PARTITION = "persist:mcode-preview";

type PreviewResolveNavigationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Clamp a requested zoom factor to the supported range and snap to whole percent. */
function clampZoomFactor(factor: number): number {
  const safe = Number.isFinite(factor) ? factor : 1;
  const bounded = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, safe));
  return Math.round(bounded * 100) / 100;
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

/** Returns the shared storage session used by both preview rendering hosts. */
function getPreviewStorageSession(): Electron.Session {
  return electronSession.fromPartition(PREVIEW_PARTITION);
}

/** Resolve user omnibox input to a safe preview URL without loading it. */
async function resolvePreviewNavigationTarget(
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
        hideReason?: "renderer-webview" | null;
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
      const switchedThread = tid != null && tid !== s.lastPreviewThreadId;
      const prevBounds = s.lastBounds;
      // The renderer measures in CSS pixels but setBounds expects DIPs; they
      // only match at zoom factor 1. Chromium persists per-origin zoom, so an
      // accidental Ctrl+-/Ctrl+= would otherwise skew the view permanently.
      const rawZoom = _event.sender.getZoomFactor();
      const zoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;
      const incomingBounds = hasValidBounds
        ? {
            x: Math.round(b.x * zoom),
            y: Math.round(b.y * zoom),
            width: Math.round(b.width * zoom),
            height: Math.round(b.height * zoom),
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
        hidePreview(win, s);
        if (payload.hideReason !== "renderer-webview") {
          onPreviewHidden(win, s);
        }
        return;
      }

      const bounds = incomingBounds;
      const sameBounds =
        prevBounds !== null &&
        prevBounds.x === bounds.x &&
        prevBounds.y === bounds.y &&
        prevBounds.width === bounds.width &&
        prevBounds.height === bounds.height;
      if (sameBounds) {
        bumpPerf("setPanelBoundsNoopSkips");
      } else {
        bumpPerf("setPanelBoundsViewportUpdates");
      }

      const hintRaw = payload.resumeUrlHint?.trim() ?? "";
      const hint = hintRaw.length > 0 && isAllowedPreviewUrl(hintRaw) ? hintRaw : null;
      const safeHint = await validateResumeUrl(hint);

      // Detach the prior thread's active view BEFORE picking the new one so
      // we never have two views mounted simultaneously.
      if (switchedThread && s.view) {
        unmountView(win, s.view);
      }
      // ensureView resolves the (now-current) thread's active tab and either
      // returns its existing webContents or creates a fresh one. On a thread
      // switch this picks up the warm WebContentsView the user left behind,
      // so their scroll/form state survives.
      const view = ensureView(win, s);
      view.setBounds(bounds);
      mountView(win, view);

      const wc = view.webContents;
      if (!wc.isDestroyed()) {
        const current = wc.getURL();
        const activeTab = tid != null ? getActiveTab(s, tid) : null;

        // Decide whether to navigate. The principle: only navigate when the
        // view is blank/error (just created) and we have a URL worth loading.
        // A warm tab that already has its document loaded must NOT be touched.
        const needsRestore = guestUrlNeedsHttpRestore(current);
        // The tab's own resumeUrl is authoritative; the per-thread hint is only
        // a cold-start fallback. A page the user opened blank stays blank — it
        // must never adopt the thread's last URL via the hint.
        const restoreTarget = needsRestore
          ? (activeTab?.resumeUrl ?? (activeTab?.userCreatedBlank ? null : safeHint))
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
    if (s.view && !s.view.webContents.isDestroyed()) {
      setPreviewLoading(win, s, true);
      s.view.webContents.reload();
      resetIdle(win, s);
      return;
    }
    // The view was torn down (e.g. a renderer crash surfaced as an error panel,
    // and the crash-cooldown skipped auto-recovery). Retry must re-create the
    // view rather than no-op. A fresh tab can crash before it ever navigated, so
    // resumePreviewUrl may be null; fall back to a blank guest so Retry still
    // remounts a working surface instead of leaving the error panel stuck.
    if (!s.lastBounds) return;
    const url = s.resumePreviewUrl ?? "about:blank";
    const view = ensureView(win, s);
    view.setBounds(s.lastBounds);
    mountView(win, view);
    setPreviewLoading(win, s, true);
    trustMainProcessFileNavigation(s, url);
    void view.webContents.loadURL(url);
    resetIdle(win, s);
  });

  ipcMain.handle("preview:force-reload", (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (s.view && !s.view.webContents.isDestroyed()) {
      setPreviewLoading(win, s, true);
      // Hard reload: drop the disk/memory cache so the guest re-fetches every
      // resource. This is the only difference from preview:reload.
      s.view.webContents.reloadIgnoringCache();
      resetIdle(win, s);
      return;
    }
    // View torn down (renderer crash → error panel): recreate and load fresh.
    // A brand-new load already bypasses the cache, so it honours the intent.
    if (!s.lastBounds) return;
    const url = s.resumePreviewUrl ?? "about:blank";
    const view = ensureView(win, s);
    view.setBounds(s.lastBounds);
    mountView(win, view);
    setPreviewLoading(win, s, true);
    trustMainProcessFileNavigation(s, url);
    void view.webContents.loadURL(url);
    resetIdle(win, s);
  });

  ipcMain.handle("preview:clear-cookies", async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    await getPreviewStorageSession().clearStorageData({ storages: ["cookies"] });
  });

  ipcMain.handle("preview:clear-cache", async (_event) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return;
    await getPreviewStorageSession().clearCache();
  });

  ipcMain.handle("preview:get-zoom", (_event): number => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return 1;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return 1;
    return clampZoomFactor(s.view.webContents.getZoomFactor());
  });

  ipcMain.handle("preview:set-zoom", (_event, factor: number): number => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) return 1;
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed()) return 1;
    const clamped = clampZoomFactor(factor);
    s.view.webContents.setZoomFactor(clamped);
    return clamped;
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
