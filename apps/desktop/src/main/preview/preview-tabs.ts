/**
 * Tab IPC handlers for BrowserSurfaceHost-owned Preview pages.
 */

import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  BROWSER_TAB_INFO_STRING_MAX,
  type BrowserTabSet,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  ensureThreadTabSet,
  getSession,
  previewTabScopeKey,
  toBrowserTabSet,
  type PreviewSession,
} from "./preview-session.js";
import { bumpPerf } from "./preview-perf.js";
import { type TabState } from "./preview-session.js";

type TabIpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
const MAX_PREVIEW_ID_LENGTH = 256;

function normalisePreviewId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PREVIEW_ID_LENGTH ? trimmed : null;
}

function normaliseThreadId(value: unknown): string | null {
  return normalisePreviewId(value);
}

function normaliseTabId(value: unknown): string | null {
  return normalisePreviewId(value);
}

function normaliseWorkspaceId(value: unknown): string | null {
  return normalisePreviewId(value);
}

function normaliseChromeField(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  return value;
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

function normaliseInitialAddress(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > BROWSER_TAB_INFO_STRING_MAX.url
  ) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) return null;
  return value;
}

function activateTab(
  s: PreviewSession,
  tab: TabState,
): void {
  tab.lastActiveAt = Date.now();
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
      const workspaceId = normaliseWorkspaceId(payload?.workspaceId);
      if (!workspaceId) return { ok: false, error: "invalid-workspace-id" };
      const s = getSession(win);
      s.workspaceId = workspaceId;
      return { ok: true, data: buildTabSet(s, tid) };
    },
  );

  ipcMain.handle(
    "preview:tabs.open",
    (
      _event,
      payload: {
        threadId?: unknown;
        workspaceId?: unknown;
        activate?: unknown;
        tabId?: unknown;
        initialAddress?: unknown;
      },
    ): TabIpcResult<{ tabId: string; tabs: BrowserTabSet }> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      const workspaceId = normaliseWorkspaceId(payload?.workspaceId);
      if (!workspaceId) return { ok: false, error: "invalid-workspace-id" };
      const requestedTabId = payload?.tabId === undefined ? null : normaliseTabId(payload.tabId);
      if (payload?.tabId !== undefined && !requestedTabId) {
        return { ok: false, error: "invalid-tab-id" };
      }
      const initialAddress = normaliseInitialAddress(payload?.initialAddress);
      if (payload?.initialAddress !== undefined && initialAddress === null) {
        return { ok: false, error: "invalid-initial-address" };
      }
      const activate = payload?.activate !== false; // default: true

      const s = getSession(win);
      s.workspaceId = workspaceId;
      const set = ensureThreadTabSet(s, tid);
      const existingTab = requestedTabId
        ? set.tabs.find((candidate) => candidate.id === requestedTabId)
        : undefined;
      if (requestedTabId && !existingTab) return { ok: false, error: "tab-not-found" };
      if (existingTab?.backgroundOpenReserved) return { ok: false, error: "tab-reserved" };

      const tabId = existingTab?.id ?? randomUUID();
      const tab = existingTab ?? {
        id: tabId,
        threadId: tid,
        resumeUrl: null,
        title: null,
        faviconUrl: null,
        lastActiveAt: Date.now(),
        // A newly-created page starts blank and must not inherit the thread's
        // last URL via the per-thread resume hint on the next sync.
        userCreatedBlank: true,
      } satisfies TabState;
      if (initialAddress !== undefined) {
        tab.resumeUrl = initialAddress;
        tab.userCreatedBlank = false;
      }
      if (!existingTab) set.tabs.push(tab);
      if (existingTab && !activate) tab.backgroundOpenReserved = true;

      if (activate && tid === s.lastPreviewThreadId) {
        // Opening on the active thread builds or reuses its exact view before
        // swapping it in, without disturbing sibling webContents.
        set.activeTabId = tabId;
        activateTab(s, tab);
      } else if (activate) {
        set.activeTabId = tabId;
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
      payload: { threadId?: unknown; workspaceId?: unknown; tabId?: unknown },
    ): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const workspaceId = normaliseWorkspaceId(payload?.workspaceId);
      const tabId = normaliseTabId(payload?.tabId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!workspaceId) return { ok: false, error: "invalid-workspace-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };

      const s = getSession(win);
      s.workspaceId = workspaceId;
      const set = ensureThreadTabSet(s, tid);
      const tab = set.tabs.find((t) => t.id === tabId);
      if (!tab) return { ok: false, error: "tab-not-found" };

      if (set.activeTabId !== tabId) {
        set.activeTabId = tabId;
        if (tid === s.lastPreviewThreadId) {
          activateTab(s, tab);
        }
      }

      const tabs = buildTabSet(s, tid);
      sendTabsUpdated(win, tabs);
      logger.info("Preview: tab activated", { threadId: tid, tabId });
      return { ok: true, data: tabs };
    },
  );

  ipcMain.handle(
    "preview:tabs.updateChrome",
    (
      _event,
      payload: {
        threadId?: unknown;
        workspaceId?: unknown;
        tabId?: unknown;
        title?: unknown;
        url?: unknown;
        faviconUrl?: unknown;
      },
    ): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const workspaceId = normaliseWorkspaceId(payload?.workspaceId);
      const tabId = normaliseTabId(payload?.tabId);
      const title = normaliseChromeField(payload?.title, BROWSER_TAB_INFO_STRING_MAX.title);
      const url = normaliseChromeField(payload?.url, BROWSER_TAB_INFO_STRING_MAX.url);
      const faviconUrl = normaliseChromeField(payload?.faviconUrl, BROWSER_TAB_INFO_STRING_MAX.faviconUrl);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!workspaceId) return { ok: false, error: "invalid-workspace-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };
      if (title === undefined || url === undefined || faviconUrl === undefined) {
        return { ok: false, error: "invalid-tab-chrome" };
      }

      const s = getSession(win);
      s.workspaceId = workspaceId;
      const set = ensureThreadTabSet(s, tid);
      const tab = set.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return { ok: false, error: "tab-not-found" };
      tab.title = title;
      tab.resumeUrl = url;
      tab.faviconUrl = faviconUrl;
      return { ok: true, data: buildTabSet(s, tid) };
    },
  );

  ipcMain.handle(
    "preview:tabs.close",
    (
      _event,
      payload: { threadId?: unknown; workspaceId?: unknown; tabId?: unknown },
    ): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const workspaceId = normaliseWorkspaceId(payload?.workspaceId);
      const tabId = normaliseTabId(payload?.tabId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!workspaceId) return { ok: false, error: "invalid-workspace-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };

      const s = getSession(win);
      s.workspaceId = workspaceId;
      const set = ensureThreadTabSet(s, tid);
      const idx = set.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return { ok: false, error: "tab-not-found" };

      const wasActive = set.activeTabId === tabId;
      set.tabs.splice(idx, 1);

      if (set.tabs.length === 0) {
        // Always keep at least one tab so the renderer never sees an empty bar.
        const fallbackId = randomUUID();
        const fallback: TabState = {
          id: fallbackId,
          threadId: tid,
          resumeUrl: null,
          title: null,
          faviconUrl: null,
          lastActiveAt: Date.now(),
          // The user just closed the last page; the replacement stays blank
          // rather than resurrecting the closed page's URL via the hint.
          userCreatedBlank: true,
        };
        set.tabs.push(fallback);
        set.activeTabId = fallbackId;
        if (tid === s.lastPreviewThreadId) {
          activateTab(s, fallback);
        }
      } else if (wasActive) {
        const nextActive = set.tabs[Math.min(idx, set.tabs.length - 1)]!;
        set.activeTabId = nextActive.id;
        if (tid === s.lastPreviewThreadId) {
          activateTab(s, nextActive);
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
    (_event, payload: { threadId?: unknown; workspaceId?: unknown }): TabIpcResult<BrowserTabSet> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = normaliseThreadId(payload?.threadId);
      const workspaceId = normaliseWorkspaceId(payload?.workspaceId);
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!workspaceId) return { ok: false, error: "invalid-workspace-id" };

      const s = getSession(win);
      s.workspaceId = workspaceId;
      const scopeKey = previewTabScopeKey(workspaceId, tid);
      const set = s.tabsByThread.get(scopeKey);
      if (set) {
        s.tabsByThread.delete(scopeKey);
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
