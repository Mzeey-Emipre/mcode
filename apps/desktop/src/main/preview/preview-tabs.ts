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
import {
  PREVIEW_RENDERING_HOSTS,
  type BrowserTabSet,
  type PreviewRenderingHost,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  ensureThreadTabSet,
  applyViewportPresentation,
  getSession,
  backgroundBoundsForTarget,
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

function normaliseRenderingHost(value: unknown): PreviewRenderingHost | null {
  if (value === undefined) return "webContentsView";
  return PREVIEW_RENDERING_HOSTS.find((host) => host === value) ?? null;
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
  tab.lastActiveAt = Date.now();
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

  mountView(win, view);
  if (s.lastBounds) applyViewportPresentation(s, s.lastBounds, tab.threadId, tab.id);

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

function activateTab(
  win: BrowserWindow,
  s: PreviewSession,
  tab: TabState,
): void {
  if (tab.renderingHost === "webContentsView") {
    activateTabView(win, s, tab);
    return;
  }

  tab.lastActiveAt = Date.now();
  if (s.view) unmountView(win, s.view);
  s.view = null;
  s.resumePreviewUrl = tab.resumeUrl;
  s.lastFavicons = tab.faviconUrl ? [tab.faviconUrl] : [];
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
    (_event, payload: { threadId?: unknown; workspaceId?: unknown }): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      const workspaceId = normaliseThreadId(payload?.workspaceId);
      if (payload?.workspaceId !== undefined && !workspaceId) {
        return { ok: false, error: "invalid-workspace-id" };
      }
      const s = getSession(win);
      if (workspaceId) s.workspaceId = workspaceId;
      return { ok: true, data: buildTabSet(s, tid) };
    },
  );

  ipcMain.handle(
    "preview:tabs.open",
    (
      _event,
      payload: {
        threadId?: unknown;
        activate?: unknown;
        tabId?: unknown;
        renderingHost?: unknown;
      },
    ): TabIpcResult<{ tabId: string; tabs: BrowserTabSet }> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      const requestedTabId = payload?.tabId === undefined ? null : normaliseTabId(payload.tabId);
      if (payload?.tabId !== undefined && !requestedTabId) {
        return { ok: false, error: "invalid-tab-id" };
      }
      const renderingHost = normaliseRenderingHost(payload?.renderingHost);
      if (!renderingHost) return { ok: false, error: "invalid-rendering-host" };
      const activate = payload?.activate !== false; // default: true

      const s = getSession(win);
      const set = ensureThreadTabSet(s, tid);
      const existingTab = requestedTabId
        ? set.tabs.find((candidate) => candidate.id === requestedTabId)
        : undefined;
      if (requestedTabId && !existingTab) return { ok: false, error: "tab-not-found" };
      if (existingTab?.backgroundOpenReserved) return { ok: false, error: "tab-reserved" };

      if (existingTab && existingTab.renderingHost !== renderingHost) {
        disposeTabView(win, s, existingTab);
        existingTab.renderingHost = renderingHost;
      }

      const tabId = existingTab?.id ?? randomUUID();
      const tab = existingTab ?? {
        id: tabId,
        threadId: tid,
        view: null,
        renderingHost,
        resumeUrl: null,
        title: null,
        faviconUrl: null,
        lastActiveAt: Date.now(),
        viewportTargetGeneration: null,
        viewportOperationGeneration: null,
        // A newly-created page starts blank and must not inherit the thread's
        // last URL via the per-thread resume hint on the next sync.
        userCreatedBlank: true,
      } satisfies TabState;
      if (!existingTab) set.tabs.push(tab);
      if (existingTab && !activate) tab.backgroundOpenReserved = true;

      if (activate && tid === s.lastPreviewThreadId) {
        // Opening on the active thread builds or reuses its exact view before
        // swapping it in, without disturbing sibling webContents.
        set.activeTabId = tabId;
        activateTab(win, s, tab);
      } else if (activate) {
        set.activeTabId = tabId;
      } else if (!activate && tab.renderingHost === "webContentsView") {
        // Agent-owned tabs stay warm without selecting their view, including
        // tabs created for an inactive thread. Positive-size offscreen bounds
        // keep the guest renderer active without painting over the panel.
        const backgroundView = ensureTabView(win, s, tab);
        const backgroundBounds = backgroundBoundsForTarget(win, s, tab.threadId, tab.id);
        if (backgroundBounds && !backgroundView.webContents.isDestroyed()) {
          backgroundView.setBounds(backgroundBounds);
          mountView(win, backgroundView);
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab opened", {
        threadId: tid,
        tabId,
        activate,
        reused: existingTab !== undefined,
      });
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
          activateTab(win, s, tab);
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
          renderingHost: "webContentsView",
          resumeUrl: null,
          title: null,
          faviconUrl: null,
          lastActiveAt: Date.now(),
          viewportTargetGeneration: null,
          viewportOperationGeneration: null,
          // The user just closed the last page; the replacement stays blank
          // rather than resurrecting the closed page's URL via the hint.
          userCreatedBlank: true,
        };
        set.tabs.push(fallback);
        set.activeTabId = fallbackId;
        if (tid === s.lastPreviewThreadId) {
          activateTab(win, s, fallback);
        }
      } else if (wasActive) {
        const nextActive = set.tabs[Math.min(idx, set.tabs.length - 1)]!;
        set.activeTabId = nextActive.id;
        if (tid === s.lastPreviewThreadId) {
          activateTab(win, s, nextActive);
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab closed", { threadId: tid, tabId, wasActive });
      return { ok: true, data: tabs };
    },
  );

  ipcMain.handle(
    "preview:tabs.closeScope",
    (_event, payload: { threadId?: unknown }): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };

      const s = getSession(win);
      const set = s.tabsByThread.get(tid);
      if (set) {
        for (const tab of set.tabs) {
          disposeTabView(win, s, tab);
        }
        s.tabsByThread.delete(tid);
      }
      if (s.lastPreviewThreadId === tid) {
        s.lastPreviewThreadId = null;
        s.resumePreviewUrl = null;
      }

      const empty: BrowserTabSet = { threadId: tid, activeTabId: null, tabs: [] };
      sendTabsUpdated(win, empty);
      logger.info("Preview: tab scope closed", { threadId: tid });
      return { ok: true, data: empty };
    },
  );
}
