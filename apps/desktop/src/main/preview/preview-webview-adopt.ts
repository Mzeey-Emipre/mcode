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

import { BrowserWindow, ipcMain, session as electronSession, webContents as electronWebContents } from "electron";
import type { WebContents } from "electron";
import { logger } from "@mcode/shared";
import { getSession } from "./preview-session.js";
import {
  registerPreviewClipboardGuest,
  unregisterPreviewClipboardGuest,
} from "./preview-clipboard-trust.js";

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
  return JSON.stringify([threadId, tabId]);
}

/** Looks up an adopted guest inside one exact BrowserWindow identity. */
export function findAdoptedWebContentsForWindow(
  windowId: number,
  threadId: string,
  tabId: string,
): WebContents | null {
  const record = adoptedByWindow.get(windowId)?.get(key(threadId, tabId));
  return record && !record.webContents.isDestroyed() ? record.webContents : null;
}

function dropAdoption(windowId: number, threadId: string, tabId: string): void {
  const inner = adoptedByWindow.get(windowId);
  if (!inner) return;
  const rec = inner.get(key(threadId, tabId));
  if (!rec) return;
  unregisterPreviewClipboardGuest(rec.webContents);
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

/** Registers the renderer-owned webview adopt and release IPC channels. */
export function registerWebviewAdoptHandlers(): void {
  ipcMain.handle(
    "preview:adopt-webview",
    (event, payload: AdoptInput): AdoptResult => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const wcId = payload?.webContentsId;
      const tid = typeof payload?.threadId === "string" ? payload.threadId.trim() : "";
      const tabId = typeof payload?.tabId === "string" ? payload.tabId.trim() : "";
      if (!Number.isSafeInteger(wcId) || wcId <= 0)
        return { ok: false, error: "invalid-webcontents-id" };
      if (!tid || tid.length > 256) return { ok: false, error: "invalid-thread-id" };
      if (!tabId || tabId.length > 256) return { ok: false, error: "invalid-tab-id" };

      const wc = electronWebContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) {
        return { ok: false, error: "webcontents-not-found" };
      }
      if (wc.getType() !== "webview") {
        return { ok: false, error: "invalid-webcontents-type" };
      }
      if (wc.hostWebContents !== event.sender) {
        return { ok: false, error: "webcontents-owner-mismatch" };
      }
      if (wc.session !== electronSession.fromPartition("persist:mcode-preview")) {
        return { ok: false, error: "invalid-webcontents-partition" };
      }
      wc.setWindowOpenHandler(() => ({ action: "deny" }));

      const s = getSession(win);
      const tab = s.tabsByThread.get(tid)?.tabs.find((candidate) => candidate.id === tabId);
      if (!tab || tab.threadId !== tid) return { ok: false, error: "target-slot-not-found" };

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
      registerPreviewClipboardGuest(wc, () => {
        if (win.isDestroyed() || !win.isFocused()) return false;
        const current = getSession(win);
        return (
          current.lastPreviewThreadId === tid &&
          current.tabsByThread.get(tid)?.activeTabId === tabId &&
          adoptedByWindow.get(win.id)?.get(key(tid, tabId))?.webContents === wc
        );
      });
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
      const tid = typeof payload?.threadId === "string" ? payload.threadId.trim() : "";
      const tabId = typeof payload?.tabId === "string" ? payload.tabId.trim() : "";
      if (!tid || tid.length > 256) return { ok: false, error: "invalid-thread-id" };
      if (!tabId || tabId.length > 256) return { ok: false, error: "invalid-tab-id" };
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
