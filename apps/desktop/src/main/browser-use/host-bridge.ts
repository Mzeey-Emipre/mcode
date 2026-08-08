/**
 * Manager-style surface the Codex browser-use pipe server consumes.
 *
 * Mirrors the methods dpcode's `DesktopBrowserManager` exposes to its pipe
 * server, but is intentionally minimal in Phase A/C: backed by the existing
 * `PreviewSession` tab records and the renderer-owned Browser surface host.
 */

import type { BrowserWindow, WebContents } from "electron";
import { BrowserWindow as ElectronBrowserWindow } from "electron";
import { logger } from "@mcode/shared";
import { ensureThreadTabSet, getThreadTabSet, sessions, type TabState } from "../preview/preview-session.js";
import { findAdoptedWebContentsForWindow } from "../preview/preview-webview-adopt.js";

/** Snapshot of the currently-visible preview, or null if none. */
export interface BrowserHostSnapshot {
  readonly threadId: string;
  readonly windowId: number;
  /** Active renderer-owned guest, when its exact surface is warm. */
  readonly activeWebContents: WebContents | null;
  readonly tabs: ReadonlyArray<{
    readonly id: string;
    readonly threadId: string;
    readonly url: string;
    readonly title: string;
    readonly active: boolean;
  }>;
}

/** Input for executeCdp, named to mirror dpcode's `BrowserExecuteCdpInput`. */
export interface BrowserExecuteCdpRequest {
  readonly threadId: string;
  readonly tabId: string;
  readonly method: string;
  readonly params?: unknown;
}

/** Listener registered via subscribeCdpEvents. */
export type BrowserCdpEventListener = (event: { method: string; params?: unknown }) => void;

export interface BrowserHostBridge {
  /** Returns the currently-visible thread's snapshot, or null. */
  getActiveSnapshot(): BrowserHostSnapshot | null;
  /** Returns a snapshot for a specific thread, even when not active (uses cached tab set). */
  getSnapshotForThread(threadId: string): BrowserHostSnapshot | null;
  /** Attach the debugger to the named tab's webContents (no-op if already attached). */
  attachDebugger(threadId: string, tabId: string): Promise<void>;
  /** Detach the debugger from the named tab. */
  detachDebugger(threadId: string, tabId: string): Promise<void>;
  /** Forward a CDP command to the named tab. */
  executeCdp(input: BrowserExecuteCdpRequest): Promise<unknown>;
  /** Subscribe to debugger CDP events for the named tab; returns disposer. */
  subscribeCdpEvents(
    target: { threadId: string; tabId: string },
    listener: BrowserCdpEventListener,
  ): () => void;
}

/** Find a session whose `lastPreviewThreadId` matches the given thread. */
function findWindowForThread(threadId: string): { win: BrowserWindow; tabs: TabState[] } | null {
  for (const win of ElectronBrowserWindow.getAllWindows()) {
    const s = sessions.get(win.id);
    if (!s) continue;
    if (s.lastPreviewThreadId === threadId) {
      const set = ensureThreadTabSet(s, threadId);
      return { win, tabs: set.tabs };
    }
  }
  return null;
}

/** Locate the per-tab record across any window for the given thread/tab. */
function locateTab(threadId: string, tabId: string): {
  win: BrowserWindow;
  webContents: WebContents | null;
} | null {
  for (const win of ElectronBrowserWindow.getAllWindows()) {
    const s = sessions.get(win.id);
    if (!s) continue;
    const set = getThreadTabSet(s, threadId);
    if (!set) continue;
    const tab = set.tabs.find((t) => t.id === tabId);
    if (!tab) continue;
    const adopted = findAdoptedWebContentsForWindow(win.id, threadId, tabId);
    return { win, webContents: adopted && !adopted.isDestroyed() ? adopted : null };
  }
  return null;
}

/**
 * Preview-session-backed implementation of {@link BrowserHostBridge}.
 *
 * CDP operations resolve one exact adopted guest and never use the active tab
 * as a substitute.
 */
export function createPreviewSessionBackedHostBridge(): BrowserHostBridge {
  /** Per-(threadId,tabId) listener bag, so multiple sessions can subscribe. */
  const cdpListenersByTabKey = new Map<string, Set<BrowserCdpEventListener>>();
  /** Per-(threadId,tabId) "debugger.on('message') disposer" to remove on detach. */
  const debuggerMessageDisposerByTabKey = new Map<string, () => void>();

  const tabKey = (threadId: string, tabId: string): string => JSON.stringify([threadId, tabId]);

  function dispatchCdpEvent(threadId: string, tabId: string, method: string, params?: unknown) {
    const bag = cdpListenersByTabKey.get(tabKey(threadId, tabId));
    if (!bag) return;
    for (const listener of bag) {
      try {
        listener({ method, ...(params !== undefined ? { params } : {}) });
      } catch (err) {
        logger.warn("browser-use: CDP listener threw", { err: String(err) });
      }
    }
  }

  return {
    getActiveSnapshot(): BrowserHostSnapshot | null {
      for (const win of ElectronBrowserWindow.getAllWindows()) {
        const s = sessions.get(win.id);
        if (!s || !s.lastPreviewThreadId) continue;
        const threadId = s.lastPreviewThreadId;
        const set = ensureThreadTabSet(s, threadId);
        const activeAdopted = set.activeTabId
          ? findAdoptedWebContentsForWindow(win.id, threadId, set.activeTabId)
          : null;
        return {
          threadId,
          windowId: win.id,
          activeWebContents: activeAdopted && !activeAdopted.isDestroyed() ? activeAdopted : null,
          tabs: set.tabs.map((t) => ({
            id: t.id,
            threadId: t.threadId,
            url: t.resumeUrl ?? "",
            title: t.title ?? "",
            active: t.id === set.activeTabId,
          })),
        };
      }
      return null;
    },

    getSnapshotForThread(threadId: string): BrowserHostSnapshot | null {
      const found = findWindowForThread(threadId);
      if (!found) {
        // No active window for the thread; still report whatever tab set exists.
        for (const win of ElectronBrowserWindow.getAllWindows()) {
          const s = sessions.get(win.id);
          if (!s) continue;
          const set = getThreadTabSet(s, threadId);
          if (!set) continue;
          return {
            threadId,
            windowId: win.id,
            activeWebContents: null,
            tabs: set.tabs.map((t) => ({
              id: t.id,
              threadId: t.threadId,
              url: t.resumeUrl ?? "",
              title: t.title ?? "",
              active: t.id === set.activeTabId,
            })),
          };
        }
        return null;
      }
      const set = found.tabs;
      const s = sessions.get(found.win.id)!;
      const activeTabId = getThreadTabSet(s, threadId)?.activeTabId ?? null;
      const activeAdopted = activeTabId
        ? findAdoptedWebContentsForWindow(found.win.id, threadId, activeTabId)
        : null;
      return {
        threadId,
        windowId: found.win.id,
        activeWebContents: activeAdopted && !activeAdopted.isDestroyed() ? activeAdopted : null,
        tabs: set.map((t) => ({
          id: t.id,
          threadId: t.threadId,
          url: t.resumeUrl ?? "",
          title: t.title ?? "",
          active: getThreadTabSet(s, threadId)?.activeTabId === t.id,
        })),
      };
    },

    async attachDebugger(threadId: string, tabId: string): Promise<void> {
      const located = locateTab(threadId, tabId);
      if (!located || !located.webContents) {
        throw new Error(
          `Tab ${threadId}:${tabId} is not active and live; activate it before attaching.`,
        );
      }
      const dbg = located.webContents.debugger;
      if (!dbg.isAttached()) {
        dbg.attach("1.3");
      }
      const key = tabKey(threadId, tabId);
      if (!debuggerMessageDisposerByTabKey.has(key)) {
        const onMessage = (
          _event: unknown,
          method: string,
          params: unknown,
        ): void => {
          dispatchCdpEvent(threadId, tabId, method, params);
        };
        dbg.on("message", onMessage);
        debuggerMessageDisposerByTabKey.set(key, () => {
          try {
            dbg.removeListener("message", onMessage);
          } catch {
            /* webContents may already be destroyed */
          }
        });
      }
    },

    async detachDebugger(threadId: string, tabId: string): Promise<void> {
      const located = locateTab(threadId, tabId);
      const key = tabKey(threadId, tabId);
      const disposer = debuggerMessageDisposerByTabKey.get(key);
      if (disposer) {
        disposer();
        debuggerMessageDisposerByTabKey.delete(key);
      }
      if (located && located.webContents) {
        const dbg = located.webContents.debugger;
        if (dbg.isAttached()) {
          try {
            dbg.detach();
          } catch {
            /* may already be detached */
          }
        }
      }
    },

    async executeCdp(input: BrowserExecuteCdpRequest): Promise<unknown> {
      const located = locateTab(input.threadId, input.tabId);
      if (!located || !located.webContents) {
        throw new Error(
          `Tab ${input.threadId}:${input.tabId} is not active and live; cannot execute ${input.method}.`,
        );
      }
      const dbg = located.webContents.debugger;
      if (!dbg.isAttached()) {
        dbg.attach("1.3");
      }
      return dbg.sendCommand(
        input.method,
        (input.params as Record<string, unknown>) ?? undefined,
      );
    },

    subscribeCdpEvents(target, listener): () => void {
      const key = tabKey(target.threadId, target.tabId);
      let bag = cdpListenersByTabKey.get(key);
      if (!bag) {
        bag = new Set();
        cdpListenersByTabKey.set(key, bag);
      }
      bag.add(listener);
      return () => {
        const current = cdpListenersByTabKey.get(key);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) cdpListenersByTabKey.delete(key);
      };
    },
  };
}
