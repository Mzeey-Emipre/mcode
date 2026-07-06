/**
 * Design Mode IPC handlers (Phase G MVP).
 *
 * Two affordances:
 *   - Viewport presets: stretches the WebContentsView/webview bounds to common
 *     device widths so the user can sanity-check responsive layouts without
 *     leaving the IAB.
 *   - Read-only inspect overlay: injects a small in-guest script that
 *     highlights the hovered element and ships its selector + bounding box
 *     back to the renderer. No DOM mutations; no clicks captured.
 *
 * Implemented against the existing single backing view (Slice 1 shim) - the
 * same IPC channels will keep working once Slice 2 lands per-tab runtimes.
 */

import { BrowserWindow, ipcMain } from "electron";
import { logger } from "@mcode/shared";
import { getSession } from "./preview-session.js";
import { resolveActivePreviewWebContents } from "./preview-active-webcontents.js";

/** Built-in viewport presets surfaced to the design bar. */
export const DESIGN_VIEWPORT_PRESETS = [
  { id: "phone", label: "Phone", width: 390, height: 844 },
  { id: "tablet", label: "Tablet", width: 1024, height: 768 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
] as const;
export type DesignViewportPresetId = (typeof DESIGN_VIEWPORT_PRESETS)[number]["id"];

const INSPECT_SCRIPT = String.raw`(() => {
  if (window.__mcodeInspectActive) return;
  window.__mcodeInspectActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed','pointer-events:none','z-index:2147483646',
    'border:2px solid rgba(56,189,248,0.9)',
    'background:rgba(56,189,248,0.08)','transition:all 60ms ease-out',
    'box-sizing:border-box','left:0','top:0','width:0','height:0','display:none',
  ].join(';');
  document.documentElement.appendChild(overlay);

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push('#' + el.id);
    if (el.classList && el.classList.length > 0) {
      parts.push('.' + Array.from(el.classList).slice(0, 3).join('.'));
    }
    return parts.join('');
  }

  function moveOverlay(el) {
    if (!el) {
      overlay.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }

  const onMove = (ev) => {
    moveOverlay(ev.target);
  };
  const onLeave = () => moveOverlay(null);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseleave', onLeave, true);

  window.__mcodeInspectTeardown = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseleave', onLeave, true);
    overlay.remove();
    delete window.__mcodeInspectActive;
    delete window.__mcodeInspectTeardown;
  };
})();`;

const TEARDOWN_SCRIPT = String.raw`(() => {
  if (typeof window.__mcodeInspectTeardown === 'function') {
    window.__mcodeInspectTeardown();
  }
})();`;

const ANNOTATION_GUARD_SCRIPT = String.raw`(() => {
  if (window.__mcodeAnnotationGuardActive) return;
  window.__mcodeAnnotationGuardActive = true;

  const block = (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    ev.stopPropagation();
  };
  const events = [
    'click',
    'mousedown',
    'mouseup',
    'contextmenu',
    'dblclick',
    'auxclick',
    'pointerdown',
    'pointermove',
    'pointerup',
    'mousemove',
    'mouseover',
    'mouseout',
    'touchstart',
    'touchmove',
    'touchend',
  ];

  for (const eventName of events) {
    document.addEventListener(eventName, block, true);
  }

  window.__mcodeAnnotationGuardTeardown = () => {
    for (const eventName of events) {
      document.removeEventListener(eventName, block, true);
    }
    delete window.__mcodeAnnotationGuardActive;
    delete window.__mcodeAnnotationGuardTeardown;
  };
})();`;

const ANNOTATION_GUARD_TEARDOWN_SCRIPT = String.raw`(() => {
  if (typeof window.__mcodeAnnotationGuardTeardown === 'function') {
    window.__mcodeAnnotationGuardTeardown();
  }
})();`;

export function registerDesignModeHandlers(): void {
  ipcMain.handle(
    "preview:design.set-viewport",
    (event, payload: { presetId?: string; widthOverride?: number; heightOverride?: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
      const s = getSession(win);
      if (!s.view || s.view.webContents.isDestroyed())
        return { ok: false, error: "no-view" };
      if (!s.lastBounds) return { ok: false, error: "no-bounds" };

      let width: number;
      let height: number;
      if (payload?.presetId) {
        const preset = DESIGN_VIEWPORT_PRESETS.find((p) => p.id === payload.presetId);
        if (!preset) return { ok: false, error: "unknown-preset" };
        width = preset.width;
        height = preset.height;
      } else {
        const w = Number(payload?.widthOverride);
        const h = Number(payload?.heightOverride);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          return { ok: false, error: "invalid-dimensions" };
        }
        width = Math.min(w, s.lastBounds.width);
        height = Math.min(h, s.lastBounds.height);
      }

      // Center the constrained viewport inside the panel bounds so the user
      // sees breathing room around the device frame, not a top-left crop.
      const x = s.lastBounds.x + Math.floor((s.lastBounds.width - width) / 2);
      const y = s.lastBounds.y + Math.floor((s.lastBounds.height - height) / 2);
      try {
        s.view.setBounds({ x, y, width, height });
      } catch {
        return { ok: false, error: "set-bounds-failed" };
      }
      return { ok: true, data: { width, height } };
    },
  );

  ipcMain.handle("preview:design.reset-viewport", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed())
      return { ok: false, error: "no-view" };
    if (!s.lastBounds) return { ok: false, error: "no-bounds" };
    try {
      s.view.setBounds(s.lastBounds);
    } catch {
      return { ok: false, error: "set-bounds-failed" };
    }
    return { ok: true };
  });

  ipcMain.handle("preview:design.set-inspect", async (event, payload: { enabled?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed())
      return { ok: false, error: "no-view" };
    try {
      await s.view.webContents.executeJavaScript(
        payload?.enabled === false ? TEARDOWN_SCRIPT : INSPECT_SCRIPT,
        true,
      );
    } catch (err) {
      logger.warn("Preview: design inspect script threw", { err: String(err) });
      return { ok: false, error: "script-failed" };
    }
    return { ok: true };
  });

  ipcMain.handle("preview:design.set-annotation-guard", async (event, payload: { enabled?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
    const s = getSession(win);
    const webContents = resolveActivePreviewWebContents(s);
    if (!webContents || webContents.isDestroyed()) return { ok: false, error: "no-view" };
    try {
      await webContents.executeJavaScript(
        payload?.enabled === false ? ANNOTATION_GUARD_TEARDOWN_SCRIPT : ANNOTATION_GUARD_SCRIPT,
        true,
      );
    } catch (err) {
      logger.warn("Preview: annotation guard script threw", { err: String(err) });
      return { ok: false, error: "script-failed" };
    }
    return { ok: true };
  });
}
