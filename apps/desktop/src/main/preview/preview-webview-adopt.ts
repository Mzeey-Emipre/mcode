/**
 * Adopt-by-webContentsId path for renderer-hosted `<webview>` tags.
 *
 * The renderer mounts a `<webview>` element and forwards its
 * `webContentsId` here on `did-attach`. We register the WebContents in a
 * thread/tab slot so the Codex browser-use bridge can target it via
 * `executeCdp` exactly the way it targets BrowserView-hosted tabs.
 *
 * Lifetime contract:
 *   - The renderer owns the `<webview>` element's lifetime (mount/unmount).
 *   - We listen for `destroyed` on the adopted WebContents to drop the
 *     registration. We never call `webContents.close()` ourselves.
 *
 * Mirrors dpcode's `attachWebview` / `webContents.fromId` flow.
 */

import { BrowserWindow, ipcMain, webContents as electronWebContents } from "electron";
import type { WebContents } from "electron";
import { logger } from "@mcode/shared";
import { ensureThreadTabSet, getSession } from "./preview-session.js";

/** Per-window registry of adopted WebContents keyed by (threadId, tabId). */
interface AdoptedRecord {
  threadId: string;
  tabId: string;
  webContents: WebContents;
  dispose: () => void;
}

/** windowId -> ("threadId:tabId" -> AdoptedRecord). */
const adoptedByWindow = new Map<number, Map<string, AdoptedRecord>>();

function key(threadId: string, tabId: string): string {
  return `${threadId}:${tabId}`;
}

/**
 * Look up the adopted WebContents for a given (threadId, tabId) across any
 * window. Returns null when nothing is adopted (i.e. tab is BrowserView-backed
 * or doesn't exist).
 */
export function findAdoptedWebContents(
  threadId: string,
  tabId: string,
): WebContents | null {
  for (const win of BrowserWindow.getAllWindows()) {
    const inner = adoptedByWindow.get(win.id);
    if (!inner) continue;
    const rec = inner.get(key(threadId, tabId));
    if (rec && !rec.webContents.isDestroyed()) return rec.webContents;
  }
  return null;
}

function dropAdoption(windowId: number, threadId: string, tabId: string): void {
  const inner = adoptedByWindow.get(windowId);
  if (!inner) return;
  const rec = inner.get(key(threadId, tabId));
  if (!rec) return;
  try {
    rec.dispose();
  } catch {
    /* listener may already be gone */
  }
  inner.delete(key(threadId, tabId));
  if (inner.size === 0) adoptedByWindow.delete(windowId);
}

export interface AdoptInput {
  webContentsId: number;
  threadId: string;
  tabId: string;
}

export type AdoptResult =
  | { ok: true }
  | { ok: false; error: string };

/** Register the four adopt-related IPC channels. Call once at app startup. */
export function registerWebviewAdoptHandlers(): void {
  ipcMain.handle(
    "preview:adopt-webview",
    (event, payload: AdoptInput): AdoptResult => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const wcId = Number(payload?.webContentsId);
      const tid = String(payload?.threadId ?? "").trim();
      const tabId = String(payload?.tabId ?? "").trim();
      if (!Number.isFinite(wcId) || wcId <= 0)
        return { ok: false, error: "invalid-webcontents-id" };
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };

      const wc = electronWebContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) {
        return { ok: false, error: "webcontents-not-found" };
      }

      const s = getSession(win);
      // Ensure the (threadId, tabId) exists in the session's tab set so the
      // host bridge's tab lookup paths see it.
      const set = ensureThreadTabSet(s, tid);
      let tab = set.tabs.find((t) => t.id === tabId);
      if (!tab) {
        tab = {
          id: tabId,
          threadId: tid,
          view: null,
          resumeUrl: wc.getURL() || null,
          title: wc.getTitle() || null,
          faviconUrl: null,
          lastActiveAt: Date.now(),
        };
        set.tabs.push(tab);
      }

      // Drop a prior adoption for the same slot first; this may delete the
      // inner Map from `adoptedByWindow` if it leaves it empty, so we
      // re-fetch/create it after.
      dropAdoption(win.id, tid, tabId);

      let inner = adoptedByWindow.get(win.id);
      if (!inner) {
        inner = new Map();
        adoptedByWindow.set(win.id, inner);
      }

      const onDestroyed = () => dropAdoption(win.id, tid, tabId);
      wc.once("destroyed", onDestroyed);
      const dispose = () => {
        try {
          wc.removeListener("destroyed", onDestroyed);
        } catch {
          /* webContents already gone */
        }
      };
      inner.set(key(tid, tabId), {
        threadId: tid,
        tabId,
        webContents: wc,
        dispose,
      });

      logger.info("Preview: adopted webview", { threadId: tid, tabId, wcId });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "preview:release-webview",
    (event, payload: { threadId?: string; tabId?: string }): AdoptResult => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const tid = String(payload?.threadId ?? "").trim();
      const tabId = String(payload?.tabId ?? "").trim();
      if (!tid) return { ok: false, error: "invalid-thread-id" };
      if (!tabId) return { ok: false, error: "invalid-tab-id" };
      dropAdoption(win.id, tid, tabId);
      return { ok: true };
    },
  );
}

/** Test/internal helper: drop every adopted record. Tests call this in afterEach. */
export function _resetAdoptionRegistryForTests(): void {
  for (const inner of adoptedByWindow.values()) {
    for (const rec of inner.values()) {
      try {
        rec.dispose();
      } catch {
        /* ignore */
      }
    }
  }
  adoptedByWindow.clear();
}
