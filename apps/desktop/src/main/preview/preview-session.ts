/**
 * Shared session state types and accessors for the embedded preview WebContentsView.
 * All other preview modules import from here rather than maintaining their own state.
 */

import { BrowserWindow, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import type {
  AttachmentMeta,
  BrowserTabInfo,
  BrowserTabSet,
  McodeBrowserCaptureV2,
  PreviewPageStatus,
} from "@mcode/contracts";
import {
  pageStatusReducer,
  initialPageStatus,
  type PageStatusEvent,
} from "./page-status-reducer.js";
import { bumpPerf } from "./preview-perf.js";

/**
 * Result of a picture-reference capture; defined here so PreviewSession can reference
 * the finish callback type without creating a circular dependency with preview-capture.ts.
 */
export type CaptureFinishResult =
  | { ok: true; meta: AttachmentMeta; previewBytes: Uint8Array; capture: McodeBrowserCaptureV2 }
  | { ok: false; error: string };

/** CSS-pixel rectangle used for WebContentsView bounds and capture regions. */
export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Per-tab record held inside a thread's tab set. Phase A keeps a single backing
 * WebContentsView per session (see {@link PreviewSession.view}), so `view` here is
 * non-null only on the currently-active tab. Cold/inactive tabs hold the URL
 * needed to re-create the view when re-activated in Phase A.
 */
export interface TabState {
  id: string;
  threadId: string;
  view: WebContentsView | null;
  resumeUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  /** Epoch ms when this tab was last activated. Drives memory-saver LRU ordering (ADR 0002). */
  lastActiveAt: number;
}

/** Per-thread tab set: an ordered list plus the id of the mounted tab. */
export interface ThreadTabSet {
  threadId: string;
  tabs: TabState[];
  activeTabId: string | null;
}

/**
 * Per-window state for the embedded preview WebContentsView.
 * One entry is created lazily per BrowserWindow id and removed when the window closes.
 */
export interface PreviewSession {
  view: WebContentsView | null;
  idleTimer: NodeJS.Timeout | null;
  /** Recurring sweep timer that evicts idle background tabs while the panel is visible. */
  discardSweepTimer: NodeJS.Timeout | null;
  /** One-shot timer scheduled when the panel hides; trims the warm set unless cancelled (hysteresis). */
  discardHiddenTimer: NodeJS.Timeout | null;
  /** True while a discard sweep is mid-flight; prevents overlapping async sweeps. */
  discardSweepInProgress: boolean;
  /** Last shell-reported bounds so navigate can attach the view before the next sync tick. */
  lastBounds: Bounds | null;
  /**
   * Last loaded http(s) URL before the view was torn down. New WebContentsViews start blank;
   * sync restores this so closing and reopening the preview panel keeps the page.
   */
  resumePreviewUrl: string | null;
  /** Key from the last insertCSS call; cleared when the guest navigates or the view is destroyed. */
  scrollbarCssKey: string | null;
  /**
   * Deprecated since the in-guest region-capture port; kept for backward
   * compatibility with any external code that still reads the field. Both
   * region and element-pick now run entirely inside the guest WebContents.
   */
  selectionOverlay: BrowserWindow | null;
  overlayPending:
    | { mode: "region" | "element"; finish: (r: CaptureFinishResult) => void; hostWin: BrowserWindow }
    | null;
  /**
   * Active element-pick poll handle. The pick runs entirely inside the guest
   * page (capture-phase event handlers + DOM highlight); the host polls this
   * shared state via executeJavaScript to detect commit / cancel. Null when no
   * element pick is in flight.
   *
   * Avoids the Electron-on-Windows compositing bug where a child
   * BrowserWindow with `transparent: true` over a `WebContentsView` paints
   * opaque (black) because DWM cannot blend the two GPU surfaces.
   */
  elementPickPollTimer: NodeJS.Timeout | null;
  /**
   * Active region-capture poll handle. The drag-marquee runs inside the guest
   * WebContents (same in-guest pattern as element pick); the host polls this
   * shared state via executeJavaScript to detect commit / cancel. Null when no
   * region capture is in flight.
   */
  regionPollTimer: NodeJS.Timeout | null;
  /** Removes main-frame navigation listener registered during an overlay capture. */
  navigationAbortDisposable: (() => void) | null;
  /** Recent guest console lines for capture v2 diagnostics (cleared when the view is destroyed). */
  consoleBuffer: string[];
  /** Failed guest subresource responses for v2 capture (best-effort, capped). */
  failedRequestBuffer: Array<{ url: string; statusCode: number; resourceType: string }>;
  /** Last thread id synced from the renderer; used to load the correct resume URL per thread. */
  lastPreviewThreadId: string | null;
  /** Active workspace id from the renderer; scopes spill files under getMcodeDir(). */
  workspaceId: string | null;
  /** Favicon URLs from the last page-favicon-updated event. */
  lastFavicons: string[];
  /** Timestamp of the last renderer crash auto-recovery; used to rate-limit retries. */
  lastCrashRecoveryAt: number;
  /**
   * Lets the next main-process `file:` navigation skip {@link ensureView}'s will-navigate gate,
   * since those loads already passed {@link resolveLocalFileUrl}.
   */
  trustedFileNavigationBudget: number;
  /**
   * Per-thread tab sets. Phase A: each thread has at least one synthetic tab whose
   * `view` mirrors {@link PreviewSession.view} when that thread is active. Inactive
   * threads' tabs carry only the resume URL/title/favicon needed to restore them.
   */
  tabsByThread: Map<string, ThreadTabSet>;
  /** Single source of truth for the active tab's page chrome, emitted on `preview:page-status`. */
  pageStatus: PreviewPageStatus;
}

/** Global map of window id -> preview session state. */
export const sessions = new Map<number, PreviewSession>();

/**
 * Returns the existing session for the given window, or creates and registers a fresh one.
 */
export function getSession(win: BrowserWindow): PreviewSession {
  let s = sessions.get(win.id);
  if (!s) {
    s = {
      view: null,
      idleTimer: null,
      discardSweepTimer: null,
      discardHiddenTimer: null,
      discardSweepInProgress: false,
      lastBounds: null,
      resumePreviewUrl: null,
      scrollbarCssKey: null,
      selectionOverlay: null,
      overlayPending: null,
      elementPickPollTimer: null,
      regionPollTimer: null,
      navigationAbortDisposable: null,
      consoleBuffer: [],
      failedRequestBuffer: [],
      lastPreviewThreadId: null,
      workspaceId: null,
      lastFavicons: [],
      lastCrashRecoveryAt: 0,
      trustedFileNavigationBudget: 0,
      tabsByThread: new Map(),
      pageStatus: initialPageStatus(),
    };
    sessions.set(win.id, s);
  }
  return s;
}

/**
 * Ensures the given thread has a tab set with at least one tab. Returns the set.
 * The first tab adopts whatever resume URL/title/favicon the session currently
 * has for that thread so existing single-view behavior carries over.
 */
export function ensureThreadTabSet(s: PreviewSession, threadId: string): ThreadTabSet {
  let set = s.tabsByThread.get(threadId);
  if (!set) {
    const tabId = randomUUID();
    const isActiveThread = s.lastPreviewThreadId === threadId;
    const firstTab: TabState = {
      id: tabId,
      threadId,
      view: isActiveThread ? s.view : null,
      resumeUrl: isActiveThread ? s.resumePreviewUrl : null,
      title: null,
      faviconUrl: isActiveThread ? (s.lastFavicons[0] ?? null) : null,
      lastActiveAt: Date.now(),
    };
    set = { threadId, tabs: [firstTab], activeTabId: tabId };
    s.tabsByThread.set(threadId, set);
  }
  return set;
}

/** Returns the active tab for the given thread, creating a default tab if needed. */
export function getActiveTab(s: PreviewSession, threadId: string): TabState {
  const set = ensureThreadTabSet(s, threadId);
  const active = set.tabs.find((t) => t.id === set.activeTabId) ?? set.tabs[0];
  if (!active) {
    // Defensive: ensureThreadTabSet guarantees at least one tab, but TypeScript
    // doesn't know that. Add a synthetic one rather than throwing.
    const id = randomUUID();
    const tab: TabState = {
      id,
      threadId,
      view: null,
      resumeUrl: null,
      title: null,
      faviconUrl: null,
      lastActiveAt: Date.now(),
    };
    set.tabs.push(tab);
    set.activeTabId = id;
    return tab;
  }
  return active;
}

/** Serializable view of a thread's tab set for IPC and renderer reconciliation. */
export function toBrowserTabSet(s: PreviewSession, threadId: string): BrowserTabSet {
  const set = ensureThreadTabSet(s, threadId);
  const tabs: BrowserTabInfo[] = set.tabs.map((t) => ({
    id: t.id,
    threadId: t.threadId,
    title: t.title,
    url: t.resumeUrl,
    faviconUrl: t.faviconUrl,
    warm: t.view !== null && !t.view.webContents.isDestroyed(),
    active: t.id === set.activeTabId,
  }));
  return {
    threadId,
    activeTabId: set.activeTabId,
    tabs,
  };
}

/**
 * Reflects the session's active single-view state onto the given thread's
 * active tab. Called by navigation/lifecycle code after URL or favicon changes
 * so {@link toBrowserTabSet} returns fresh data.
 */
export function syncActiveTabFromSession(s: PreviewSession): void {
  const threadId = s.lastPreviewThreadId;
  if (!threadId) return;
  const tab = getActiveTab(s, threadId);
  tab.view = s.view;
  tab.resumeUrl = s.resumePreviewUrl;
  tab.faviconUrl = s.lastFavicons[0] ?? null;
  if (s.view && !s.view.webContents.isDestroyed()) {
    const t = s.view.webContents.getTitle();
    tab.title = t && t.length > 0 ? t : tab.title;
  }
}

/** Cancels both memory-saver discard timers (sweep interval + hidden one-shot). */
export function clearDiscardTimers(s: PreviewSession): void {
  if (s.discardSweepTimer) {
    clearInterval(s.discardSweepTimer);
    s.discardSweepTimer = null;
  }
  if (s.discardHiddenTimer) {
    clearTimeout(s.discardHiddenTimer);
    s.discardHiddenTimer = null;
  }
}

/**
 * Cancels the idle teardown timer on the given session.
 */
export function clearIdle(s: PreviewSession): void {
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
}

/** No-op: idle teardown removed (the React shell parks the view on unmount). */
export function resetIdle(_win: BrowserWindow, s: PreviewSession): void {
  clearIdle(s);
}

/**
 * Runs the page-status reducer for `event`, stores the result on the session,
 * and emits the full {@link PreviewPageStatus} on `preview:page-status` when it
 * changed. The single emit path that replaces the old loading/navigate/favicon
 * channels.
 */
export function applyPageStatus(
  win: BrowserWindow,
  s: PreviewSession,
  event: PageStatusEvent,
): void {
  const next = pageStatusReducer(s.pageStatus, event);
  if (pageStatusEqual(s.pageStatus, next)) return;
  s.pageStatus = next;
  if (win.isDestroyed()) return;
  bumpPerf("stateEmitCalls");
  try {
    win.webContents.send("preview:page-status", next);
  } catch {
    bumpPerf("stateEmitSkips");
  }
}

/**
 * Sends the active-thread tab set to the renderer on `preview:tabs-updated`.
 * Used by the discard scheduler so the tab bar reflects freshly-discarded
 * (cold) tabs. Mirrors the emit in preview-tabs.ts but rebuilds from session
 * state rather than a pre-synced set.
 */
export function emitTabsUpdated(win: BrowserWindow, s: PreviewSession, threadId: string): void {
  if (win.isDestroyed()) return;
  bumpPerf("stateEmitCalls");
  try {
    win.webContents.send("preview:tabs-updated", toBrowserTabSet(s, threadId));
  } catch {
    bumpPerf("stateEmitSkips");
  }
}

/**
 * Convenience for the many call sites that only toggle the loading affordance.
 * Routes through {@link applyPageStatus} so loading stays part of the single
 * page-status channel.
 */
export function setPreviewLoading(
  win: BrowserWindow,
  s: PreviewSession,
  loading: boolean,
): void {
  applyPageStatus(win, s, loading ? { type: "load-start" } : { type: "load-stop" });
}

/** Shallow equality so {@link applyPageStatus} emits at most once per real change. */
function pageStatusEqual(a: PreviewPageStatus, b: PreviewPageStatus): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.favicon === b.favicon &&
    a.phase === b.phase &&
    a.error?.kind === b.error?.kind &&
    a.error?.status === b.error?.status &&
    a.error?.message === b.error?.message
  );
}

/**
 * Returns true when the URL is a valid http or https URL.
 * Moved here from preview-navigation to break the circular dependency between
 * preview-lifecycle (imports isAllowedHttpUrl) and preview-navigation (imports ensureView).
 */
export function isAllowedHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Accepts http, https, and file URLs for the preview WebContentsView. */
export function isAllowedPreviewUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * True when the guest has no real document loaded yet (fresh view or error).
 * Moved here alongside isAllowedHttpUrl to keep URL utilities together.
 */
export function guestUrlNeedsHttpRestore(url: string): boolean {
  if (url.length === 0) return true;
  if (url === "about:blank") return true;
  if (url.startsWith("about:")) return true;
  if (url.startsWith("chrome-error:")) return true;
  return false;
}
