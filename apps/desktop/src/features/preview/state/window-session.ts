/**
 * Shared session state types and accessors for renderer-owned Preview surfaces.
 * All other preview modules import from here rather than maintaining their own state.
 */

import { BrowserWindow, type WebContents } from "electron";
import * as NodeCrypto from "node:crypto";
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
} from "./page-status.js";
import { bumpPerf } from "../observability/perf-counters.js";

export { isAllowedHttpUrl, isAllowedPreviewUrl } from "../navigation/policy.js";

/**
 * Result of a picture-reference capture; defined here so PreviewSession can reference
 * the finish callback type without creating a circular dependency with capture handlers.
 */
export type CaptureFinishResult =
  | { ok: true; meta: AttachmentMeta; previewBytes: Uint8Array; capture: McodeBrowserCaptureV2 }
  | { ok: false; error: string };

/** CSS-pixel rectangle used for Preview layout and capture regions. */
export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * Per-tab record held inside a thread's tab set.
 */
export interface TabState {
  id: string;
  threadId: string;
  resumeUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  /** Epoch ms when this tab was last activated. Drives memory-saver LRU ordering (ADR 0002). */
  lastActiveAt: number;
  /** Current renderer-owned guest generation, or null while the tab is cold. */
  rendererSurfaceGeneration?: number | null;
  /**
   * True for a page the user explicitly opened as a new, blank tab. Such a tab
   * must stay on its empty "Enter a URL" state and must NOT adopt the thread's
   * per-thread resume-URL hint on the next sync (which exists to restore the
   * thread's last page on cold start / remount). Cleared once the tab navigates
   * to a real URL.
   */
  userCreatedBlank?: boolean;
  /** Prevents another background open from claiming this page before navigation settles. */
  backgroundOpenReserved?: boolean;
}

/** Per-thread tab set: an ordered list plus the id of the mounted tab. */
export interface ThreadTabSet {
  threadId: string;
  tabs: TabState[];
  activeTabId: string | null;
}

/** Stable key for one workspace and preview scope in a BrowserWindow session. */
export function previewTabScopeKey(workspaceId: string, threadId: string): string {
  return JSON.stringify([workspaceId, threadId]);
}

/** Returns one exact workspace-qualified tab set, if present. */
export function getThreadTabSet(
  s: PreviewSession,
  threadId: string,
  workspaceId = s.workspaceId ?? threadId,
): ThreadTabSet | undefined {
  const exact = s.tabsByThread.get(previewTabScopeKey(workspaceId, threadId));
  if (exact || s.workspaceId !== undefined && s.workspaceId !== null) return exact;
  return s.tabsByThread.get(threadId);
}

/**
 * Per-window state for renderer-owned Preview surfaces.
 * One entry is created lazily per BrowserWindow id and removed when the window closes.
 */
export interface PreviewSession {
  /** Recurring sweep timer that evicts idle background tabs while the panel is visible. */
  discardSweepTimer: NodeJS.Timeout | null;
  /** One-shot timer scheduled when the panel hides; trims the warm set unless cancelled (hysteresis). */
  discardHiddenTimer: NodeJS.Timeout | null;
  /** True while a discard sweep is mid-flight; prevents overlapping async sweeps. */
  discardSweepInProgress: boolean;
  /** Last shell-reported bounds used by responsive viewport presentation. */
  lastBounds: Bounds | null;
  /** Last allowed page URL for the active Preview tab. */
  resumePreviewUrl: string | null;
  overlayPending:
    | {
        mode: "region" | "element";
        finish: (r: CaptureFinishResult) => void;
        hostWin: BrowserWindow;
        webContents: WebContents;
      }
    | null;
  /**
   * Active element-pick poll handle. The pick runs entirely inside the guest
   * page (capture-phase event handlers + DOM highlight); the host polls this
   * shared state via executeJavaScript to detect commit / cancel. Null when no
   * element pick is in flight.
   *
   * The in-page picker keeps capture bound to the exact adopted guest.
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
   * Per-thread tab sets with bounded recovery metadata for cold surfaces.
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
      discardSweepTimer: null,
      discardHiddenTimer: null,
      discardSweepInProgress: false,
      lastBounds: null,
      resumePreviewUrl: null,
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
  const workspaceId = s.workspaceId ?? threadId;
  const scopeKey = previewTabScopeKey(workspaceId, threadId);
  let set = getThreadTabSet(s, threadId, workspaceId);
  if (!set) {
    const tabId = NodeCrypto.randomUUID();
    const isActiveThread = s.lastPreviewThreadId === threadId && workspaceId === (s.workspaceId ?? threadId);
    const firstTab: TabState = {
      id: tabId,
      threadId,
      resumeUrl: isActiveThread ? s.resumePreviewUrl : null,
      title: null,
      faviconUrl: isActiveThread ? (s.lastFavicons[0] ?? null) : null,
      lastActiveAt: Date.now(),
    };
    set = { threadId, tabs: [firstTab], activeTabId: tabId };
    s.tabsByThread.set(scopeKey, set);
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
    const id = NodeCrypto.randomUUID();
    const tab: TabState = {
      id,
      threadId,
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
    warm: t.rendererSurfaceGeneration != null,
    active: t.id === set.activeTabId,
  }));
  return {
    threadId,
    activeTabId: set.activeTabId,
    tabs,
  };
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
 * (cold) tabs. Mirrors the emit in tabs/handlers.ts but rebuilds from session
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
    pageStatusErrorEqual(a.error, b.error)
  );
}

function pageStatusErrorEqual(
  left: PreviewPageStatus["error"],
  right: PreviewPageStatus["error"],
): boolean {
  return pageStatusErrorKindEqual(left, right) && pageStatusErrorDetailsEqual(left, right);
}

function pageStatusErrorKindEqual(
  left: PreviewPageStatus["error"],
  right: PreviewPageStatus["error"],
): boolean {
  return left?.kind === right?.kind;
}

function pageStatusErrorDetailsEqual(
  left: PreviewPageStatus["error"],
  right: PreviewPageStatus["error"],
): boolean {
  return left?.status === right?.status && left?.code === right?.code && left?.message === right?.message;
}
