/**
 * Tab IPC handlers for the embedded preview WebContentsView.
 *
 * Phase A scope (this PR): the host still owns a single backing WebContentsView per
 * window. These handlers maintain a per-thread tab set whose **active** tab
 * mirrors that single view, and surface a stable wire format so the renderer
 * can build a tab bar today. Future PRs replace the single backing view with
 * one WebContentsView per warm tab; the wire contract here does not change.
 */

import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserTabSet } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  ensureThreadTabSet,
  getSession,
  syncActiveTabFromSession,
  toBrowserTabSet,
  type PreviewSession,
} from "./preview-session.js";
import { bumpPerf } from "./preview-perf.js";
import {
  disposeTabView,
  ensureTabView,
  mountView,
  unmountView,
} from "./preview-lifecycle.js";
import {
  isAllowedPreviewUrl,
  applyPageStatus,
  type TabState,
} from "./preview-session.js";
import { trustMainProcessFileNavigation } from "./preview-local-file.js";

type TabIpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

function normaliseThreadId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normaliseTabId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sendTabsUpdated(win: BrowserWindow, set: BrowserTabSet): void {
  if (win.isDestroyed()) return;
  bumpPerf("stateEmitCalls");
  try {
    win.webContents.send("preview:tabs-updated", set);
  } catch {
    bumpPerf("stateEmitSkips");
  }
}

/**
 * Mount `tab`'s WebContentsView in the window, unmounting whichever tab is
 * currently active. Each tab keeps its own live webContents across switches,
 * so this is purely a swap - no reload. The view is created on first mount
 * and the tab's `resumeUrl` (if any) is loaded ONCE at that point.
 */
function activateTabView(
  win: BrowserWindow,
  s: PreviewSession,
  tab: TabState,
): void {
  // Unmount whatever's currently mounted for this session (the prior active
  // tab's view). Keep its webContents alive so switching back is instant.
  if (s.view && s.view !== tab.view) {
    unmountView(win, s.view);
  }

  const isFirstMount = !tab.view || tab.view.webContents.isDestroyed();
  const view = ensureTabView(win, s, tab);
  s.view = view;
  s.resumePreviewUrl = tab.resumeUrl;
  s.lastFavicons = tab.faviconUrl ? [tab.faviconUrl] : [];

  if (s.lastBounds) view.setBounds(s.lastBounds);
  mountView(win, view);

  let loadingKicked = false;
  if (isFirstMount && tab.resumeUrl && isAllowedPreviewUrl(tab.resumeUrl)) {
    // Brand-new view for a tab that already had a saved URL (e.g. thread
    // restore). Load it once; subsequent activates of the same tab skip this
    // entirely so the user keeps their scroll / form state.
    loadingKicked = true;
    if (tab.resumeUrl.startsWith("file:")) {
      trustMainProcessFileNavigation(s, tab.resumeUrl);
    }
    void view.webContents.loadURL(tab.resumeUrl);
  }

  // Single page-status emit replaces the old loading-state + did-navigate +
  // did-update-favicon trio. The phase reflects whether we just kicked off a
  // load; without this the user sees a stale URL/title until the next page
  // event fires on the (warm) webContents - which may never happen for a
  // long-lived page.
  if (!win.isDestroyed()) {
    const wc = view.webContents;
    if (!wc.isDestroyed()) {
      const liveUrl = wc.getURL();
      applyPageStatus(win, s, {
        type: "reset",
        status: {
          url: loadingKicked ? tab.resumeUrl : (liveUrl.length > 0 ? liveUrl : null),
          title: loadingKicked ? tab.title : (wc.getTitle() || null),
          favicon: tab.faviconUrl ?? null,
          phase: loadingKicked ? "loading" : "loaded",
        },
      });
    }
  }
}

/**
 * Phase A: returns the active thread's tab set, but only meaningfully when
 * `threadId` matches the session's current thread. For inactive threads we
 * still materialise their saved tab set so the renderer can preview the list
 * before switching.
 */
function buildTabSet(s: PreviewSession, threadId: string): BrowserTabSet {
  if (threadId === s.lastPreviewThreadId) {
    syncActiveTabFromSession(s);
  }
  return toBrowserTabSet(s, threadId);
}

export function registerTabHandlers(): void {
  ipcMain.handle(
    "preview:tabs.list",
    (_event, payload: { threadId?: unknown }): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      const s = getSession(win);
      return { ok: true, data: buildTabSet(s, tid) };
    },
  );

  ipcMain.handle(
    "preview:tabs.create",
    (
      _event,
      payload: { threadId?: unknown; activate?: unknown },
    ): TabIpcResult<{ tabId: string; tabs: BrowserTabSet }> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      const activate = payload?.activate !== false; // default: true

      const s = getSession(win);
      const set = ensureThreadTabSet(s, tid);
      const tabId = randomUUID();
      set.tabs.push({
        id: tabId,
        threadId: tid,
        view: null,
        resumeUrl: null,
        title: null,
        faviconUrl: null,
      });

      if (activate && tid === s.lastPreviewThreadId) {
        // Brand-new tab on the active thread: build its own view and swap
        // it in. ensureTabView starts at about:blank so the user sees a
        // clean slate without disturbing the previously-active tab's
        // webContents.
        set.activeTabId = tabId;
        const newTab = set.tabs[set.tabs.length - 1]!;
        activateTabView(win, s, newTab);
      } else if (activate) {
        set.activeTabId = tabId;
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab created", { threadId: tid, tabId, activate });
      return { ok: true, data: { tabId, tabs } };
    },
  );

  ipcMain.handle(
    "preview:tabs.activate",
    (
      _event,
      payload: { threadId?: unknown; tabId?: unknown },
    ): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const tabId = normaliseTabId(payload?.tabId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };

      const s = getSession(win);
      const set = ensureThreadTabSet(s, tid);
      const tab = set.tabs.find((t) => t.id === tabId);
      if (!tab) return { ok: false, error: "tab-not-found" };

      if (set.activeTabId !== tabId) {
        set.activeTabId = tabId;
        if (tid === s.lastPreviewThreadId) {
          // Swap which per-tab WebContentsView is mounted. No reload - the
          // target tab's webContents is already alive with its own URL,
          // scroll, and form state preserved across the switch.
          activateTabView(win, s, tab);
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab activated", { threadId: tid, tabId });
      return { ok: true, data: tabs };
    },
  );

  ipcMain.handle(
    "preview:tabs.close",
    (
      _event,
      payload: { threadId?: unknown; tabId?: unknown },
    ): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const tabId = normaliseTabId(payload?.tabId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };

      const s = getSession(win);
      const set = ensureThreadTabSet(s, tid);
      const idx = set.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return { ok: false, error: "tab-not-found" };

      const wasActive = set.activeTabId === tabId;
      const removedTab = set.tabs[idx]!;
      set.tabs.splice(idx, 1);

      // Always dispose the closed tab's webContents so memory comes back.
      disposeTabView(win, s, removedTab);

      if (set.tabs.length === 0) {
        // Always keep at least one tab so the renderer never sees an empty bar.
        const fallbackId = randomUUID();
        const fallback: TabState = {
          id: fallbackId,
          threadId: tid,
          view: null,
          resumeUrl: null,
          title: null,
          faviconUrl: null,
        };
        set.tabs.push(fallback);
        set.activeTabId = fallbackId;
        if (tid === s.lastPreviewThreadId) {
          activateTabView(win, s, fallback);
        }
      } else if (wasActive) {
        const nextActive = set.tabs[Math.min(idx, set.tabs.length - 1)]!;
        set.activeTabId = nextActive.id;
        if (tid === s.lastPreviewThreadId) {
          activateTabView(win, s, nextActive);
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab closed", { threadId: tid, tabId, wasActive });
      return { ok: true, data: tabs };
    },
  );
}
