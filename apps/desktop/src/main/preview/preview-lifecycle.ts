/**
 * WebContentsView lifecycle management: create, attach, hide, park, and dispose
 * the embedded preview view for a given BrowserWindow.
 *
 * Migrated from BrowserView (deprecated in Electron 30+) to WebContentsView
 * which is mounted via `BaseWindow.contentView.addChildView`. `BrowserWindow`
 * extends `BaseWindow` so the same window reference works for both APIs.
 */

import { BrowserWindow, WebContentsView, shell } from "electron";
import { logger } from "@mcode/shared";
import {
  type PreviewSession,
  type TabState,
  ensureThreadTabSet,
  getActiveTab,
  sessions,
  clearIdle,
  clearDiscardTimers,
  applyPageStatus,
  setPreviewLoading,
  isAllowedPreviewUrl,
} from "./preview-session.js";
import { removeEpPickHighlighter, abortOverlayCapture } from "./preview-overlay.js";
import { pushPreviewConsoleLine } from "./preview-capture.js";
import { validateResumeUrl, trustMainProcessFileNavigation } from "./preview-local-file.js";

/**
 * Injected into every guest document so preview scrollbars match the app shell on Windows
 * and other platforms where Chromium draws legacy arrow buttons by default.
 */
const PREVIEW_SCROLLBAR_CSS = [
  "::-webkit-scrollbar{width:10px;height:10px}",
  "::-webkit-scrollbar-corner{background:transparent}",
  "::-webkit-scrollbar-track{background:rgba(0,0,0,.18);border-radius:8px}",
  "::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:8px;border:2px solid transparent;background-clip:padding-box}",
  "::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.34);background-clip:padding-box}",
  "::-webkit-scrollbar-button{height:0;width:0;display:none}",
  "*{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.28) transparent}",
].join("");

/** True when `view` is currently a child of the window's contentView. */
function isMounted(win: BrowserWindow, view: WebContentsView): boolean {
  try {
    return win.contentView.children.includes(view);
  } catch {
    return false;
  }
}

/** Idempotently mount the view inside the window's contentView. */
export function mountView(win: BrowserWindow, view: WebContentsView): void {
  if (isMounted(win, view)) return;
  try {
    win.contentView.addChildView(view);
  } catch {
    /* window may be tearing down */
  }
}

/** Idempotently remove the view from the window's contentView. */
export function unmountView(win: BrowserWindow, view: WebContentsView): void {
  if (!isMounted(win, view)) return;
  try {
    win.contentView.removeChildView(view);
  } catch {
    /* already detached */
  }
}

/**
 * Removes all preview-related webContents listeners from a WebContentsView so
 * teardown does not fire stale callbacks after the view is detached.
 */
export function detachViewListeners(view: WebContentsView): void {
  view.webContents.removeAllListeners("did-navigate");
  view.webContents.removeAllListeners("did-navigate-in-page");
  view.webContents.removeAllListeners("page-title-updated");
  view.webContents.removeAllListeners("page-favicon-updated");
  view.webContents.removeAllListeners("did-finish-load");
  view.webContents.removeAllListeners("did-start-loading");
  view.webContents.removeAllListeners("did-stop-loading");
  view.webContents.removeAllListeners("console-message");
  view.webContents.removeAllListeners("render-process-gone");
  view.webContents.removeAllListeners("will-navigate");
}

/**
 * Returns the WebContentsView already owned by `tab`, or creates and wires
 * a fresh one. Each tab keeps its own webContents alive across tab/thread
 * switches so activating a tab swaps which view is mounted in the window
 * rather than reloading a single shared guest.
 *
 * Listeners gate on `s.view === view` (am I the active view?) before
 * publishing to the renderer or mutating session-mirror buffers, so events
 * from background tabs (favicons resolving, pages finishing load) do not
 * overwrite the active tab's chrome.
 */
export function ensureTabView(
  win: BrowserWindow,
  s: PreviewSession,
  tab: TabState,
): WebContentsView {
  if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
  logger.info("Preview: WebContentsView created", { threadId: tab.threadId, tabId: tab.id });
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: "persist:mcode-preview",
    },
  });
  const isActiveView = (): boolean => s.view === view;

  view.webContents.setBackgroundThrottling(true);

  // Forward modifier-chord keystrokes from the guest WebContents to the host
  // renderer so app shortcuts (Ctrl+Shift+D for the capture dock, Ctrl+1..9
  // for thread switching, etc.) still work when focus is inside the preview.
  // Without this, the host's document keydown listener never sees these keys
  // because they are dispatched to the guest's separate process tree.
  //
  // Clipboard / find / page-reload chords are skipped so they keep their
  // native behavior inside the guest (Ctrl+C copies selected text, Ctrl+F
  // opens the page's find bar via the embedded Chromium, etc.).
  view.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const hasMod = input.control || input.meta;
    const hasShift = input.shift;
    const hasAlt = input.alt;
    if (!hasMod && !hasAlt) return;
    const key = input.key.toLowerCase();
    // Plain Ctrl/Cmd + standard browser-page chord: leave with the page.
    // c/v/x/a clipboard + selection, f find-in-page, s save-as,
    // r reload, z undo in form fields.
    if (hasMod && !hasShift && !hasAlt) {
      if (
        key === "c" ||
        key === "v" ||
        key === "x" ||
        key === "a" ||
        key === "f" ||
        key === "s" ||
        key === "r" ||
        key === "z"
      ) {
        return;
      }
    }
    const parts: string[] = [];
    if (hasMod) parts.push("mod");
    if (hasShift) parts.push("shift");
    if (hasAlt) parts.push("alt");
    parts.push(key);
    const combo = parts.join("+");
    const reservedHostChord =
      combo === "mod+shift+b" ||
      combo === "mod+shift+d" ||
      combo === "mod+shift+y" ||
      /^mod\+[1-9]$/.test(combo);
    if (reservedHostChord) event.preventDefault();
    if (!win.isDestroyed()) {
      win.webContents.send("preview:shortcut-fired", combo);
    }
  });

  view.webContents.setWindowOpenHandler((details) => {
    try {
      const u = new URL(details.url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        void shell.openExternal(details.url);
      }
    } catch {
      // ignore malformed URLs
    }
    return { action: "deny" };
  });

  view.webContents.on("will-navigate", (event, navigationUrl) => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    let parsed: URL;
    try {
      parsed = new URL(navigationUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== "file:") return;
    if (s.trustedFileNavigationBudget > 0) {
      s.trustedFileNavigationBudget--;
      return;
    }
    event.preventDefault();
    void (async () => {
      if (win.isDestroyed() || view.webContents.isDestroyed()) return;
      const safe = await validateResumeUrl(navigationUrl);
      if (safe) {
        trustMainProcessFileNavigation(s, safe);
        if (isActiveView()) setPreviewLoading(win, s, true);
        try {
          await view.webContents.loadURL(safe);
        } catch {
          /* guest may be tearing down */
        }
      } else {
        tab.resumeUrl = null;
        if (isActiveView()) {
          s.resumePreviewUrl = null;
          setPreviewLoading(win, s, true);
        }
        try {
          await view.webContents.loadURL("about:blank");
        } catch {
          /* guest may be tearing down */
        }
      }
    })();
  });

  const forwardNav = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    const url = view.webContents.getURL();
    void (async () => {
      if (win.isDestroyed() || view.webContents.isDestroyed()) return;
      const persisted = await validateResumeUrl(isAllowedPreviewUrl(url) ? url : null);
      // Always record on the owning tab so background tabs keep their own URL.
      tab.resumeUrl = persisted;
      const title = view.webContents.getTitle();
      tab.title = title && title.length > 0 ? title : tab.title;
      if (win.isDestroyed()) return;
      // Only the active view drives the shell omnibox + session mirror.
      if (isActiveView()) {
        s.resumePreviewUrl = persisted;
        applyPageStatus(win, s, {
          type: "navigated",
          url: url.length > 0 ? url : null,
          title,
        });
      }
    })();
  };

  // page-title-updated must NOT run validateResumeUrl (P1): a title change does
  // not change the URL, so re-stat'ing the file path on every title event is
  // pure waste. Patch only the title field.
  const forwardTitle = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    const title = view.webContents.getTitle();
    tab.title = title && title.length > 0 ? title : tab.title;
    if (isActiveView() && !win.isDestroyed()) {
      applyPageStatus(win, s, { type: "title", title });
    }
  };

  view.webContents.on("did-navigate", forwardNav);
  view.webContents.on("did-navigate-in-page", forwardNav);
  view.webContents.on("page-title-updated", forwardTitle);
  view.webContents.on("page-favicon-updated", (_e, urls: string[]) => {
    tab.faviconUrl = urls[0] ?? null;
    if (win.isDestroyed()) return;
    if (isActiveView()) {
      s.lastFavicons = urls;
      applyPageStatus(win, s, { type: "favicon", favicon: urls[0] ?? null });
    }
  });
  view.webContents.on("did-finish-load", () => {
    if (isActiveView()) {
      void injectPreviewScrollbarStyles(s);
    }
  });

  const forwardLoadingStart = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    if (!isActiveView()) return;
    // The load-start reducer case clears the favicon as part of entering loading.
    s.lastFavicons = [];
    applyPageStatus(win, s, { type: "load-start" });
  };
  const forwardLoadingStop = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    if (!isActiveView()) return;
    applyPageStatus(win, s, { type: "load-stop" });
  };
  view.webContents.on("did-start-loading", forwardLoadingStart);
  view.webContents.on("did-stop-loading", forwardLoadingStop);

  view.webContents.on("console-message", (_event, level, message) => {
    // Console buffers only matter for capture, which targets the active tab.
    if (isActiveView()) pushPreviewConsoleLine(s, level, message);
  });

  view.webContents.on("render-process-gone", (_event, details) => {
    const url = tab.resumeUrl;
    const wasActive = isActiveView();
    logger.warn("Preview: renderer crashed", {
      reason: details.reason,
      exitCode: details.exitCode,
      url,
      threadId: tab.threadId,
      tabId: tab.id,
    });

    // Tear down the dead view so ensureTabView creates a fresh one on next mount.
    detachViewListeners(view);
    if (!win.isDestroyed()) unmountView(win, view);
    tab.view = null;
    if (wasActive) {
      s.view = null;
      s.scrollbarCssKey = null;
      s.consoleBuffer.length = 0;
      s.failedRequestBuffer.length = 0;
    }

    if (!wasActive) {
      // A background tab crashed; do not auto-recover (no live bounds to set).
      // It will recover lazily on next activate.
      return;
    }

    // Rate-limit auto-recovery: if we already recovered within the last 30 s
    // the page is repeatedly crashing and retrying would loop forever.
    const now = Date.now();
    const CRASH_COOLDOWN_MS = 30_000;
    if (now - s.lastCrashRecoveryAt < CRASH_COOLDOWN_MS) {
      logger.warn("Preview: crash recovery skipped (cooldown active)");
      if (!win.isDestroyed()) {
        setPreviewLoading(win, s, false);
      }
      return;
    }

    // Auto-recover once: recreate the view and reload the page that crashed.
    if (!win.isDestroyed() && url) {
      logger.info("Preview: auto-recovering after crash", { url });
      s.lastCrashRecoveryAt = now;
      const fresh = ensureTabView(win, s, tab);
      s.view = fresh;
      if (s.lastBounds) fresh.setBounds(s.lastBounds);
      mountView(win, fresh);
      setPreviewLoading(win, s, true);
      trustMainProcessFileNavigation(s, url);
      void fresh.webContents.loadURL(url);
    }
  });

  tab.view = view;
  return view;
}

/**
 * Back-compat shim: callers that don't yet know about per-tab views (e.g.
 * preview:sync, preview:navigate) resolve the active tab here and delegate.
 * Mirrors the returned view onto `s.view` so the legacy single-view fields
 * keep tracking the mounted tab.
 */
export function ensureView(win: BrowserWindow, s: PreviewSession): WebContentsView {
  const threadId = s.lastPreviewThreadId;
  if (threadId) {
    ensureThreadTabSet(s, threadId);
    const tab = getActiveTab(s, threadId);
    const view = ensureTabView(win, s, tab);
    s.view = view;
    return view;
  }
  // Defensive fallback: no thread bound yet (shouldn't happen because the
  // renderer always sends threadId in preview:sync before any other call).
  // Reuse s.view if alive, else synthesise a parentless tab.
  if (s.view && !s.view.webContents.isDestroyed()) return s.view;
  const synthetic: TabState = {
    id: "__detached__",
    threadId: "__detached__",
    view: null,
    resumeUrl: null,
    title: null,
    faviconUrl: null,
    lastActiveAt: Date.now(),
  };
  const view = ensureTabView(win, s, synthetic);
  s.view = view;
  return view;
}

/**
 * Dispose a single tab's WebContentsView. Idempotent. Used by tabs.close and
 * by parkPreview when walking the full tab set.
 */
export function disposeTabView(win: BrowserWindow, s: PreviewSession, tab: TabState): void {
  const v = tab.view;
  if (!v) return;
  try {
    detachViewListeners(v);
    if (!win.isDestroyed()) unmountView(win, v);
    if (!v.webContents.isDestroyed()) v.webContents.close();
  } catch {
    /* guest may already be torn down */
  }
  tab.view = null;
  if (s.view === v) {
    s.view = null;
    s.scrollbarCssKey = null;
    s.consoleBuffer.length = 0;
    s.failedRequestBuffer.length = 0;
  }
}

/**
 * Inserts or re-inserts the scrollbar CSS into the current guest document,
 * removing any stale key first to avoid duplicate rules.
 */
async function injectPreviewScrollbarStyles(s: PreviewSession): Promise<void> {
  const view = s.view;
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  if (s.scrollbarCssKey) {
    try {
      await wc.removeInsertedCSS(s.scrollbarCssKey);
    } catch {
      // Previous key may refer to a document that was torn down.
    }
    s.scrollbarCssKey = null;
  }
  try {
    s.scrollbarCssKey = await wc.insertCSS(PREVIEW_SCROLLBAR_CSS, { cssOrigin: "user" });
  } catch {
    // Guest may be mid-destruction.
  }
}

/**
 * Detaches the WebContentsView from the window without destroying it, and
 * aborts any in-progress overlay capture. Used by preview:sync when
 * visibility toggles off temporarily (e.g. React effect cleanup during
 * in-page navigations). The webContents stays alive so the page isn't
 * reloaded when the view is re-attached moments later.
 */
export function hidePreview(win: BrowserWindow, s: PreviewSession): void {
  abortOverlayCapture(s, "capture-interrupted");
  clearIdle(s);
  if (s.view && !win.isDestroyed()) {
    logger.info("Preview: view hidden (detached, kept alive)");
    unmountView(win, s.view);
  }
  if (!win.isDestroyed()) {
    setPreviewLoading(win, s, false);
  }
}

/**
 * Detaches every per-tab WebContentsView from the window and closes their
 * underlying WebContents, clearing session buffers and stopping the idle
 * timer. Saves the active tab's URL as the resume URL so the next ensureView
 * call can reload it.
 */
export function parkPreview(win: BrowserWindow, s: PreviewSession): void {
  logger.info("Preview: view parked (destroyed)", { url: s.resumePreviewUrl });
  hidePreview(win, s);
  clearDiscardTimers(s);
  // Save the active tab's URL before disposing so a later restore can reload.
  if (s.view && !s.view.webContents.isDestroyed()) {
    try {
      void removeEpPickHighlighter(s.view.webContents);
      const parked = s.view.webContents.getURL();
      void validateResumeUrl(isAllowedPreviewUrl(parked) ? parked : null).then((safe) => {
        if (!win.isDestroyed()) s.resumePreviewUrl = safe;
      });
    } catch {
      /* guest may already be destroyed */
    }
  }
  // Dispose every per-tab view across every thread.
  for (const set of s.tabsByThread.values()) {
    for (const tab of set.tabs) {
      disposeTabView(win, s, tab);
    }
  }
  s.view = null;
  s.scrollbarCssKey = null;
  s.consoleBuffer.length = 0;
  s.failedRequestBuffer.length = 0;
}

/**
 * Removes the preview BrowserView and timers when a window is closing.
 */
export function disposePreviewForWindow(win: BrowserWindow): void {
  const s = sessions.get(win.id);
  if (!s) return;
  parkPreview(win, s);
  sessions.delete(win.id);
}
