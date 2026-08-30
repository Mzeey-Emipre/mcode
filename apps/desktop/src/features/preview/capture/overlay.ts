/**
 * In-page region drag and element-pick capture helpers for an adopted Preview guest.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserWindow, app, ipcMain, type WebContents } from "electron";
import {
  PREVIEW_ANNOTATION_STRING_MAX,
  type AttachmentMeta,
  type BrowserPreviewElementStyle,
} from "@mcode/contracts";
import {
  type Bounds,
  type PreviewSession,
  getSession,
} from "../state/window-session.js";
import {
  type PreviewPictureReferenceResult,
  buildBrowserCapturePayload,
  snapshotFailedRequestsForCapture,
  previewCaptureFileStem,
  clampRectInPlace,
  parseBoundsRecord,
  sanitizeSelectorHintFromGuest,
  scrubHtmlExcerptForOutbound,
} from "./handlers.js";
import { resolveActivePreviewWebContents } from "../surfaces/active-web-contents.js";

/**
 * Element-pick runs entirely inside the guest page: capture-phase event handlers block
 * the underlying page's pointer/keyboard activity, an in-page lightweight hit-test drives
 * the amber highlight + tooltip, and a shared `window.__mcodeEpState` object queues the
 * commit point or cancellation flag for the host to drain via executeJavaScript polling.
 *
 * In-page capture keeps the highlight bound to the exact guest document.
 */
const EP_CHAT_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path fill="#f59e0b" stroke="#111827" stroke-width="1.5" d="M14 3.5c6.1 0 10.8 3.8 10.8 8.7s-4.7 8.7-10.8 8.7c-1.1 0-2.2-.1-3.2-.4L5 24l1.8-5C4.6 17.4 3.2 15 3.2 12.2 3.2 7.3 7.9 3.5 14 3.5Z"/><circle cx="10.6" cy="12.3" r="1.2" fill="#fff"/><circle cx="14" cy="12.3" r="1.2" fill="#fff"/><circle cx="17.4" cy="12.3" r="1.2" fill="#fff"/></svg>`;
const EP_CHAT_CURSOR_CSS = `url('data:image/svg+xml,${encodeURIComponent(
  EP_CHAT_CURSOR_SVG,
)}') 8 8, pointer`;

const EP_INJECT_JS = `(function(){
  if (window.__mcodeEpTeardown) return;
  var HL_ID = "__mcode_ep_hl", TIP_ID = "__mcode_ep_tip";
  var style = document.createElement("style");
  style.setAttribute("data-mcode-ep", "1");
  // Highlight + tip use the app's warm-amber primary (oklch(0.72 0.17 75)) so
  // the in-guest selection reads as part of Mcode, not a stock browser-devtools
  // cyan. Inlined as a literal because injected JS cannot read host CSS vars.
  // The tip's foreground sits at oklch(0.18 0.01 75) - very dark, slight warm
  // tint - which gives high contrast against the amber pill.
  style.textContent = "#__mcode_ep_hl{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;border:2px solid oklch(0.72 0.17 75);box-sizing:border-box;z-index:2147483646;display:none;box-shadow:0 0 0 1px rgba(0,0,0,.35) inset;border-radius:2px}#__mcode_ep_tip{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;display:none;max-width:min(360px,calc(100vw - 12px));font:600 11px/1.2 ui-sans-serif,system-ui,sans-serif;color:oklch(0.18 0.01 75);background:oklch(0.72 0.17 75);border-radius:3px 3px 0 0;padding:3px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 4px rgba(0,0,0,.25)}#__mcode_ep_tip[data-flipped=\\"1\\"]{border-radius:0 0 3px 3px}html.__mcode_ep_active,html.__mcode_ep_active *{cursor:${EP_CHAT_CURSOR_CSS} !important}";
  (document.head || document.documentElement).appendChild(style);
  var box = document.createElement("div");
  box.id = HL_ID;
  box.setAttribute("aria-hidden", "true");
  var tip = document.createElement("div");
  tip.id = TIP_ID;
  tip.setAttribute("aria-live", "polite");
  var root = document.body || document.documentElement;
  root.appendChild(box);
  root.appendChild(tip);
  try { document.documentElement.classList.add("__mcode_ep_active"); } catch (e0) {}

  // Shared state the host drains via executeJavaScript. seq increments on any state
  // change so the poll loop can detect activity without races.
  window.__mcodeEpState = { commit: null, cancelled: false, seq: 0 };
  function bump(){ try { window.__mcodeEpState.seq++; } catch (e) {} }

  function isEpNode(n){
    if (!n || n.nodeType !== 1) return false;
    if (n.id === HL_ID || n.id === TIP_ID) return true;
    return false;
  }
  function isInteractive(el){
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "a" || tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || tag === "label" || tag === "summary" || tag === "option") return true;
    var role = el.getAttribute && el.getAttribute("role");
    if (!role) return false;
    role = role.toLowerCase();
    return role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "option" || role === "checkbox" || role === "radio" || role === "switch";
  }
  function isHugeRect(r){
    var de = document.documentElement;
    var vw = Math.max(0, de.clientWidth || window.innerWidth || 0);
    var vh = Math.max(0, de.clientHeight || window.innerHeight || 0);
    if (vw < 1 || vh < 1) return false;
    return (r.width * r.height) >= (vw * vh * 0.92);
  }
  function hoverPickAt(px, py){
    var list;
    try { list = document.elementsFromPoint(px, py); } catch (e1) { list = []; }
    if (!list || !list.length) {
      try { return document.elementFromPoint(px, py); } catch (e2) { return null; }
    }
    var docEl = document.documentElement;
    var body = document.body;
    var cands = [];
    // Cap scan at 8 (was 16): each candidate triggers a getBoundingClientRect
    // layout query, and in practice the meaningful interactive target is
    // always in the top few elementsFromPoint entries. Halving the cap cuts
    // worst-case layout reads per RAF tick from 16 to 8.
    var maxScan = Math.min(list.length, 8);
    for (var i = 0; i < maxScan; i++) {
      var c = list[i];
      if (!c || c.nodeType !== 1) continue;
      if (c === docEl || c === body) continue;
      if (isEpNode(c)) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      cands.push({ el: c, area: r.width * r.height, huge: isHugeRect(r), interactive: isInteractive(c), depth: i });
    }
    var interact = cands.filter(function(c){ return c.interactive && !c.huge; });
    if (!interact.length) interact = cands.filter(function(c){ return c.interactive; });
    if (interact.length) {
      interact.sort(function(a,b){ if (a.area !== b.area) return a.area - b.area; return a.depth - b.depth; });
      return interact[0].el;
    }
    var normals = cands.filter(function(c){ return !c.huge; });
    if (normals.length) {
      normals.sort(function(a,b){ return a.area - b.area; });
      return normals[0].el;
    }
    if (cands.length) return cands[cands.length - 1].el;
    return null;
  }
  function labelFor(el){
    if (!el || !el.tagName) return "Element";
    var tag = el.tagName.toLowerCase();
    try {
      if (el.id && String(el.id).trim()) return tag + "#" + String(el.id).trim().slice(0, 48);
      var tid = el.getAttribute && el.getAttribute("data-testid");
      if (tid) return tag + "[data-testid=" + String(tid).slice(0, 48) + "]";
      var al = el.getAttribute && el.getAttribute("aria-label");
      if (al && String(al).trim()) return tag + " " + String(al).trim().slice(0, 48);
      if (typeof el.className === "string" && el.className.trim()) {
        var first = el.className.trim().split(/\\s+/)[0];
        if (first) return tag + "." + first.slice(0, 48);
      }
    } catch (e) {}
    return tag;
  }
  function paintHighlight(el){
    if (!el) { box.style.display = "none"; tip.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { box.style.display = "none"; tip.style.display = "none"; return; }
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    // Append an action hint so first-timers understand the model: clicking
    // the page in design mode attaches the element, it does not navigate.
    // The Esc-to-exit affordance is already carried by the top-right Design
    // pill, so we only spell out the positive action here to keep the tip tight.
    tip.textContent = labelFor(el) + " \u00b7 click to attach";
    tip.style.display = "block";
    // Measure after content is set so flip detection uses the real tip height.
    var pad = 4;
    var vw = window.innerWidth || 1;
    var th = tip.offsetHeight || 20;
    var tw = tip.offsetWidth || 80;
    // Anchor to rect's top-left. Sit flush above the top border (DevTools tab look).
    // If there is no room above, flip inside the rect with rounded bottom corners.
    var flipped = r.top - th < pad;
    var ty = flipped ? r.top : Math.max(pad, r.top - th);
    var tx = Math.max(pad, Math.min(r.left, vw - tw - pad));
    tip.style.left = Math.round(tx) + "px";
    tip.style.top = Math.round(ty) + "px";
    if (flipped) tip.setAttribute("data-flipped", "1");
    else tip.removeAttribute("data-flipped");
  }

  var rafPending = 0;
  var lastX = 0, lastY = 0;
  function scheduleHover(){
    if (rafPending) return;
    rafPending = requestAnimationFrame(function(){
      rafPending = 0;
      var el = hoverPickAt(lastX, lastY);
      paintHighlight(el);
    });
  }

  // All listeners are capture-phase + preventDefault + stopImmediatePropagation so the
  // underlying page receives nothing. The seq bump on commit/cancel signals the host poll.
  function onMouseMove(ev){
    // Threshold-gate: skip RAF scheduling and rect measurements for sub-pixel
    // jitter. lastX/lastY here track the last *accepted* cursor position, so
    // accumulating tiny moves still triggers an update once they cross the
    // threshold relative to the last hit-test.
    var nx = ev.clientX, ny = ev.clientY;
    if (Math.abs(nx - lastX) + Math.abs(ny - lastY) < 2) return;
    lastX = nx; lastY = ny;
    scheduleHover();
  }
  function onClick(ev){
    ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    if (window.__mcodeEpState.commit || window.__mcodeEpState.cancelled) return;
    window.__mcodeEpState.commit = { x: ev.clientX, y: ev.clientY };
    bump();
  }
  function blockEvent(ev){
    ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
  }
  function onKeydown(ev){
    if (ev.key === "Escape" || ev.key === "Esc") {
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      if (!window.__mcodeEpState.commit) {
        window.__mcodeEpState.cancelled = true;
        bump();
      }
    } else {
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    }
  }
  function onLeave(){
    if (rafPending) { cancelAnimationFrame(rafPending); rafPending = 0; }
    box.style.display = "none";
    tip.style.display = "none";
  }
  function onScroll(){ scheduleHover(); }

  var EVENTS_BLOCK = ["mousedown","mouseup","contextmenu","dblclick","auxclick","pointerdown","pointerup"];
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("mouseleave", onLeave, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);
  for (var i = 0; i < EVENTS_BLOCK.length; i++) {
    document.addEventListener(EVENTS_BLOCK[i], blockEvent, true);
  }

  window.__mcodeEpTeardown = function(){
    try {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("mouseleave", onLeave, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
      for (var j = 0; j < EVENTS_BLOCK.length; j++) {
        document.removeEventListener(EVENTS_BLOCK[j], blockEvent, true);
      }
      if (rafPending) cancelAnimationFrame(rafPending);
    } catch (e) {}
    try { document.documentElement.classList.remove("__mcode_ep_active"); } catch (e2) {}
    var h = document.getElementById(HL_ID);
    var t = document.getElementById(TIP_ID);
    if (h) h.remove();
    if (t) t.remove();
    var styles = document.querySelectorAll('style[data-mcode-ep="1"]');
    for (var k = 0; k < styles.length; k++) styles[k].remove();
    try { delete window.__mcodeEpState; } catch (e3) { window.__mcodeEpState = null; }
    try { delete window.__mcodeEpTeardown; } catch (e4) { window.__mcodeEpTeardown = null; }
  };
})()`;

const EP_REMOVE_JS = `(function(){
  if (typeof window.__mcodeEpTeardown === "function") {
    try { window.__mcodeEpTeardown(); } catch (e) {}
  } else {
    var h = document.getElementById("__mcode_ep_hl");
    var t = document.getElementById("__mcode_ep_tip");
    if (h) h.remove();
    if (t) t.remove();
    document.querySelectorAll('style[data-mcode-ep="1"]').forEach(function (n) { n.remove(); });
    try { document.documentElement.classList.remove("__mcode_ep_active"); } catch (e2) {}
  }
})()`;

/** JSON payload returned by the host poll script. */
type EpPollPayload =
  | { state: "idle"; seq: number }
  | { state: "commit"; seq: number; x: number; y: number }
  | { state: "cancelled"; seq: number }
  | { state: "gone" };

/** Polls the guest state object, returning the current commit/cancel/idle status. */
const EP_POLL_JS = `(function(){
  var st = window.__mcodeEpState;
  if (!st) return JSON.stringify({ state: "gone" });
  if (st.cancelled) return JSON.stringify({ state: "cancelled", seq: st.seq });
  if (st.commit) return JSON.stringify({ state: "commit", seq: st.seq, x: st.commit.x, y: st.commit.y });
  return JSON.stringify({ state: "idle", seq: st.seq });
})()`;

/**
 * Region drag-marquee runs entirely inside the guest page (parallel to the
 * element-pick pattern in {@link EP_INJECT_JS}). A translucent fixed-position
 * layer captures pointer events at the document's capture phase, blocking the
 * underlying page, and a `window.__mcodeRgState` object holds the pending
 * commit rect or cancellation flag for the host to drain via executeJavaScript
 * polling.
 */
const RG_INJECT_JS = `(function(){
  if (window.__mcodeRgTeardown) return;
  var LAYER_ID = "__mcode_rg_layer", BOX_ID = "__mcode_rg_box";
  var style = document.createElement("style");
  style.setAttribute("data-mcode-rg", "1");
  style.textContent = "#__mcode_rg_layer{position:fixed;inset:0;background:rgba(15,23,42,.35);cursor:crosshair;z-index:2147483646;touch-action:none}#__mcode_rg_box{position:fixed;left:0;top:0;width:0;height:0;border:2px dashed #fff;box-sizing:border-box;pointer-events:none;display:none;box-shadow:0 0 0 1px rgba(0,0,0,.4) inset;z-index:2147483647}html.__mcode_rg_active,html.__mcode_rg_active *{cursor:crosshair !important;user-select:none !important}";
  (document.head || document.documentElement).appendChild(style);

  var layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.setAttribute("aria-hidden", "true");
  var box = document.createElement("div");
  box.id = BOX_ID;
  box.setAttribute("aria-hidden", "true");
  var root = document.body || document.documentElement;
  root.appendChild(layer);
  root.appendChild(box);
  try { document.documentElement.classList.add("__mcode_rg_active"); } catch (e0) {}

  // Shared state; seq bumps on any change so the host poll detects activity.
  window.__mcodeRgState = { commit: null, cancelled: false, seq: 0 };
  function bump(){ try { window.__mcodeRgState.seq++; } catch (e) {} }

  var dragging = false, activePointerId = -1, sx = 0, sy = 0, cx = 0, cy = 0;
  function lay(){
    if (!dragging) { box.style.display = "none"; return; }
    var x = Math.min(sx, cx), y = Math.min(sy, cy);
    var w = Math.abs(cx - sx), h = Math.abs(cy - sy);
    box.style.left = x + "px";
    box.style.top = y + "px";
    box.style.width = w + "px";
    box.style.height = h + "px";
    box.style.display = w > 0 && h > 0 ? "block" : "none";
  }
  // Pointer Events instead of legacy MouseEvent: Chromium's input pipeline
  // dispatches pointer events first and can suppress the compat mouse cascade
  // when an ancestor capture-phase listener preventDefaults pointerdown (which
  // is exactly what the legacy EVENTS_BLOCK array did). Driving the drag
  // entirely from pointer events with setPointerCapture is the supported path
  // and removes the mouse-compat suppression class of bugs.
  function onPointerDown(ev){
    if (ev.button !== 0 && ev.pointerType === "mouse") return;
    ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    if (window.__mcodeRgState.commit || window.__mcodeRgState.cancelled) return;
    dragging = true;
    activePointerId = ev.pointerId;
    try { layer.setPointerCapture(ev.pointerId); } catch (e) {}
    sx = ev.clientX; sy = ev.clientY;
    cx = sx; cy = sy;
    lay();
  }
  function onPointerMove(ev){
    if (!dragging || ev.pointerId !== activePointerId) return;
    ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    cx = ev.clientX; cy = ev.clientY;
    lay();
  }
  function onPointerUp(ev){
    if (!dragging || ev.pointerId !== activePointerId) return;
    ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    dragging = false;
    try { layer.releasePointerCapture(ev.pointerId); } catch (e) {}
    activePointerId = -1;
    var x = Math.min(sx, cx), y = Math.min(sy, cy);
    var w = Math.abs(cx - sx), h = Math.abs(cy - sy);
    box.style.display = "none";
    if (w >= 4 && h >= 4) {
      window.__mcodeRgState.commit = { x: x, y: y, width: w, height: h };
    } else {
      // Too-small drags fall through to cancel so the user can try again.
      window.__mcodeRgState.cancelled = true;
    }
    bump();
  }
  function blockEvent(ev){
    // Stop the page from seeing secondary click types during a selection.
    // Do not preventDefault: that can suppress the pointer / compat-mouse
    // cascade we depend on for drag tracking.
    ev.stopImmediatePropagation(); ev.stopPropagation();
  }
  function onKeydown(ev){
    if (ev.key === "Escape" || ev.key === "Esc") {
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
      if (!window.__mcodeRgState.commit) {
        window.__mcodeRgState.cancelled = true;
        bump();
      }
    } else {
      // Swallow all other keys so page shortcuts do not fire during selection.
      ev.preventDefault(); ev.stopImmediatePropagation(); ev.stopPropagation();
    }
  }

  // Drag handlers live on the layer (setPointerCapture pins later events to
  // it). EVENTS_BLOCK still blocks click / contextmenu / dblclick from the
  // page so a clean release does not trigger a link follow or context menu.
  var EVENTS_BLOCK = ["contextmenu","dblclick","auxclick","click"];
  layer.addEventListener("pointerdown", onPointerDown, true);
  layer.addEventListener("pointermove", onPointerMove, true);
  layer.addEventListener("pointerup", onPointerUp, true);
  layer.addEventListener("pointercancel", onPointerUp, true);
  document.addEventListener("keydown", onKeydown, true);
  for (var i = 0; i < EVENTS_BLOCK.length; i++) {
    document.addEventListener(EVENTS_BLOCK[i], blockEvent, true);
  }

  window.__mcodeRgTeardown = function(){
    try {
      layer.removeEventListener("pointerdown", onPointerDown, true);
      layer.removeEventListener("pointermove", onPointerMove, true);
      layer.removeEventListener("pointerup", onPointerUp, true);
      layer.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("keydown", onKeydown, true);
      for (var j = 0; j < EVENTS_BLOCK.length; j++) {
        document.removeEventListener(EVENTS_BLOCK[j], blockEvent, true);
      }
    } catch (e) {}
    try { document.documentElement.classList.remove("__mcode_rg_active"); } catch (e2) {}
    var l = document.getElementById(LAYER_ID);
    var b = document.getElementById(BOX_ID);
    if (l) l.remove();
    if (b) b.remove();
    var styles = document.querySelectorAll('style[data-mcode-rg="1"]');
    for (var k = 0; k < styles.length; k++) styles[k].remove();
    try { delete window.__mcodeRgState; } catch (e3) { window.__mcodeRgState = null; }
    try { delete window.__mcodeRgTeardown; } catch (e4) { window.__mcodeRgTeardown = null; }
  };
})()`;

const RG_REMOVE_JS = `(function(){
  if (typeof window.__mcodeRgTeardown === "function") {
    try { window.__mcodeRgTeardown(); } catch (e) {}
  } else {
    var l = document.getElementById("__mcode_rg_layer");
    var b = document.getElementById("__mcode_rg_box");
    if (l) l.remove();
    if (b) b.remove();
    document.querySelectorAll('style[data-mcode-rg="1"]').forEach(function (n) { n.remove(); });
    try { document.documentElement.classList.remove("__mcode_rg_active"); } catch (e2) {}
  }
})()`;

/** JSON payload returned by the host poll script for region capture. */
type RgPollPayload =
  | { state: "idle"; seq: number }
  | { state: "commit"; seq: number; x: number; y: number; width: number; height: number }
  | { state: "cancelled"; seq: number }
  | { state: "gone" };

/** Polls the guest region state, returning the current commit/cancel/idle status. */
const RG_POLL_JS = `(function(){
  var st = window.__mcodeRgState;
  if (!st) return JSON.stringify({ state: "gone" });
  if (st.cancelled) return JSON.stringify({ state: "cancelled", seq: st.seq });
  if (st.commit) return JSON.stringify({ state: "commit", seq: st.seq, x: st.commit.x, y: st.commit.y, width: st.commit.width, height: st.commit.height });
  return JSON.stringify({ state: "idle", seq: st.seq });
})()`;

/** Result type for element hit-testing against the guest page coordinate system. */
type HitTestResult =
  | {
      ok: true;
      /** Guest viewport CSS pixels: used for capturePage and in-page highlight. */
      bounds: Bounds;
      selectorHint: string | null;
      htmlExcerpt: string | null;
      elementStyle: BrowserPreviewElementStyle | null;
    }
  | { ok: false; code: string };

/**
 * Draws the element-pick highlight inside the guest page (not the shell overlay), matching layout viewport coords.
 * Must run removeEpPickHighlighter before capturePage so the amber frame is not in the PNG.
 */
async function injectEpPickHighlighter(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(EP_INJECT_JS, true);
  } catch {
    /* guest mid-navigation */
  }
}

/**
 * Removes the element-pick highlight + capture-phase event handlers injected by
 * injectEpPickHighlighter from the guest page.
 */
export async function removeEpPickHighlighter(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(EP_REMOVE_JS, true);
  } catch {
    /* already destroyed */
  }
}

/**
 * Draws the region drag-marquee inside the guest page (mirrors the element-pick
 * pattern). Must run removeRgMarqueeHighlighter before capturePage so the dashed
 * frame is not in the PNG.
 */
async function injectRgMarqueeHighlighter(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(RG_INJECT_JS, true);
  } catch {
    /* guest mid-navigation */
  }
}

/**
 * Removes the region-capture marquee layer + capture-phase event handlers
 * injected by injectRgMarqueeHighlighter from the guest page.
 */
async function removeRgMarqueeHighlighter(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScript(RG_REMOVE_JS, true);
  } catch {
    /* already destroyed */
  }
}

const resolveActiveCaptureWebContents = resolveActivePreviewWebContents;

/** Return the current renderer-reported bounds for capture hit testing. */
function hostBoundsForHitTest(s: PreviewSession, _webContents: WebContents): Bounds | null {
  return s.lastBounds;
}

/**
 * Builds guest-executed hit-test script for element pick: bounds, heuristic selector, optional HTML excerpt.
 * Maps overlay pointer coords to the guest layout viewport using documentElement client metrics
 * (innerWidth/innerHeight can disagree with layout when scrollbars or root overflow differ).
 * Highlight nodes live on the root document: hit rects must be mapped from subframes by walking the frameElement chain.
 * Excerpt cloning strips active content and form state so hostile pages leak less into prompts.
 */
function buildHitTestJs(overlayX: number, overlayY: number, hostWidth: number, hostHeight: number): string {
  const xi = Math.max(0, Math.round(overlayX));
  const yi = Math.max(0, Math.round(overlayY));
  const hw = Math.max(0, Math.round(hostWidth));
  const hh = Math.max(0, Math.round(hostHeight));
  return `(function () {
  var hostW = ${hw}, hostH = ${hh};
  var ox = ${xi}, oy = ${yi};
  var REMOVE_TAGS = { SCRIPT:1, IFRAME:1, OBJECT:1, EMBED:1, LINK:1, NOSCRIPT:1, FRAME:1, META:1, BASE:1 };
  function classTokens(el) {
    var raw = "";
    if (typeof el.className === "string") raw = el.className;
    else if (el.className && typeof el.className.baseVal === "string") raw = el.className.baseVal;
    if (!raw || !raw.trim()) return [];
    return raw.trim().split(/\\s+/).filter(function (c) { return c.length > 0; }).slice(0, 4);
  }
  function escCls(t) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(t);
    return String(t).replace(/[^a-zA-Z0-9_-]/g, "");
  }
  function nthOfType(el) {
    var tag = el.tagName;
    var p = el.parentElement;
    if (!p || !tag) return 1;
    var n = 1;
    var kids = p.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === el) return n;
      if (kids[i].tagName === tag) n++;
    }
    return n;
  }
  function stripRiskyAttrs(el) {
    if (!el.attributes) return;
    var rm = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      var low = a.name.toLowerCase();
      if (low.indexOf("on") === 0) rm.push(a.name);
      if (low === "srcdoc") rm.push(a.name);
      if (low === "href" && a.value && /^javascript:/i.test(a.value)) {
        try { el.setAttribute("href", "#"); } catch (e1) {}
      }
      if ((low === "src" || low === "xlink:href") && a.value && /^javascript:/i.test(a.value)) rm.push(a.name);
    }
    rm.forEach(function (n) { try { el.removeAttribute(n); } catch (e2) {} });
  }
  function sanitizeTree(node) {
    if (!node || node.nodeType !== 1) return;
    var tg = node.tagName ? node.tagName.toUpperCase() : "";
    if (REMOVE_TAGS[tg]) {
      node.remove();
      return;
    }
    stripRiskyAttrs(node);
    var tn = node.tagName ? node.tagName.toUpperCase() : "";
    if (tn === "INPUT") {
      try {
        node.value = "";
        node.setAttribute("value", "");
      } catch (e3) {}
    }
    if (tn === "TEXTAREA") {
      try { node.textContent = ""; } catch (e4) {}
    }
    if (tn === "SELECT") {
      try {
        var os = node.querySelectorAll("option");
        for (var j = 0; j < os.length; j++) {
          os[j].value = "";
          os[j].textContent = "";
        }
      } catch (e5) {}
    }
    var ch = node.firstChild;
    while (ch) {
      var nx = ch.nextSibling;
      if (ch.nodeType === 1) sanitizeTree(ch);
      ch = nx;
    }
  }
  function selectorHintFor(el) {
    var tag = (el.tagName && el.tagName.toLowerCase()) || "*";
    var hint = null;
    try {
      if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement && el.type === "password") {
        var pn = el.getAttribute("name");
        return pn ? "input[type=password][name=" + JSON.stringify(String(pn)) + "]" : "input[type=password]";
      }
      if (el.id && String(el.id).trim()) {
        hint = "[id=" + JSON.stringify(String(el.id)) + "]";
      } else {
        var tid = el.getAttribute && el.getAttribute("data-testid");
        if (tid) hint = "[data-testid=" + JSON.stringify(String(tid)) + "]";
        else {
          var nm = el.getAttribute && el.getAttribute("name");
          if (nm && (tag === "input" || tag === "select" || tag === "textarea" || tag === "button")) {
            hint = tag + "[name=" + JSON.stringify(String(nm)) + "]";
          } else {
            var al = el.getAttribute && el.getAttribute("aria-label");
            if (al && String(al).trim()) {
              var als = String(al).trim().slice(0, 64);
              hint = tag + "[aria-label=" + JSON.stringify(als) + "]";
            } else {
              var role = el.getAttribute && el.getAttribute("role");
              if (role && String(role).trim()) {
                var rls = String(role).trim().slice(0, 32);
                hint = tag + "[role=" + JSON.stringify(rls) + "]";
              } else {
                var parts = classTokens(el).filter(function (c) { return escCls(c).length > 0; }).slice(0, 3);
                var cls = parts.length ? "." + parts.map(escCls).join(".") : "";
                var nth = nthOfType(el);
                hint = tag + cls + ":nth-of-type(" + nth + ")";
              }
            }
          }
        }
      }
    } catch (se) {
      hint = tag;
    }
    if (hint && hint.length > 400) hint = hint.slice(0, 400);
    return hint;
  }
  function pointInRect(px, py, r) {
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  }
  function isHugeRect(r) {
    var de = document.documentElement;
    var vw = Math.max(0, de.clientWidth || window.innerWidth || 0);
    var vh = Math.max(0, de.clientHeight || window.innerHeight || 0);
    if (vw < 1 || vh < 1) return false;
    return (r.width * r.height) >= (vw * vh * 0.92);
  }
  function isInteractive(el) {
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "a" || tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || tag === "label" || tag === "summary" || tag === "option") {
      return true;
    }
    var role = el.getAttribute && el.getAttribute("role");
    if (!role) return false;
    role = role.toLowerCase();
    return role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "option" || role === "checkbox" || role === "radio" || role === "switch";
  }
  function pickElementAt(px, py) {
    var list;
    try {
      list = document.elementsFromPoint(px, py);
    } catch (ept) {
      list = [];
    }
    if (!list || !list.length) {
      try {
        return document.elementFromPoint(px, py);
      } catch (ept2) {
        return null;
      }
    }
    var docEl = document.documentElement;
    var body = document.body;
    var candidates = [];
    var maxScan = Math.min(list.length, 16);
    for (var i = 0; i < maxScan; i++) {
      var c = list[i];
      if (!c || c.nodeType !== 1) continue;
      if (c === docEl || c === body) continue;
      var r = c.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (!pointInRect(px, py, r)) continue;
      var area = r.width * r.height;
      var huge = isHugeRect(r);
      candidates.push({ el: c, r: r, area: area, huge: huge, interactive: isInteractive(c), depth: i });
    }
    var interact = candidates.filter(function (c) { return c.interactive && !c.huge; });
    if (!interact.length) interact = candidates.filter(function (c) { return c.interactive; });
    if (interact.length) {
      interact.sort(function (a, b) {
        if (a.area !== b.area) return a.area - b.area;
        return a.depth - b.depth;
      });
      return interact[0].el;
    }
    var normals = candidates.filter(function (c) { return !c.huge; });
    if (normals.length) {
      normals.sort(function (a, b) { return a.area - b.area; });
      return normals[0].el;
    }
    if (candidates.length) return candidates[candidates.length - 1].el;
    try {
      return document.elementFromPoint(px, py);
    } catch (ept3) {
      return null;
    }
  }
  function roundBounds(r) {
    var x0 = Math.round(r.x);
    var y0 = Math.round(r.y);
    var w0 = Math.max(1, Math.round(r.width));
    var h0 = Math.max(1, Math.round(r.height));
    return { x: x0, y: y0, width: w0, height: h0 };
  }
  function cleanStyleValue(value) {
    var text = String(value == null ? "" : value).replace(/[\\u0000-\\u001F\\u007F]/g, " ").trim();
    return text ? text.slice(0, 512) : null;
  }
  function setStyleValue(target, key, value) {
    var clean = cleanStyleValue(value);
    if (clean) target[key] = clean;
  }
  function pxStyleValue(value) {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) + "px" : null;
  }
  function computedElementStyle(el, rect) {
    var next = {};
    try {
      var cs = window.getComputedStyle(el);
      setStyleValue(next, "textColor", cs.color);
      setStyleValue(next, "background", cs.backgroundColor);
      var opacity = Number(cs.opacity);
      if (Number.isFinite(opacity)) next.opacity = Math.max(0, Math.min(1, opacity));
      setStyleValue(next, "font", cs.fontFamily);
      setStyleValue(next, "fontSize", cs.fontSize);
      setStyleValue(next, "fontWeight", cs.fontWeight);
      setStyleValue(next, "borderRadius", cs.borderRadius);
      setStyleValue(next, "borderTopLeftRadius", cs.borderTopLeftRadius);
      setStyleValue(next, "borderTopRightRadius", cs.borderTopRightRadius);
      setStyleValue(next, "borderBottomRightRadius", cs.borderBottomRightRadius);
      setStyleValue(next, "borderBottomLeftRadius", cs.borderBottomLeftRadius);
      setStyleValue(next, "borderColor", cs.borderColor);
      setStyleValue(next, "borderWidth", cs.borderWidth);
      setStyleValue(next, "borderTopWidth", cs.borderTopWidth);
      setStyleValue(next, "borderRightWidth", cs.borderRightWidth);
      setStyleValue(next, "borderBottomWidth", cs.borderBottomWidth);
      setStyleValue(next, "borderLeftWidth", cs.borderLeftWidth);
      setStyleValue(next, "width", pxStyleValue(rect.width));
      setStyleValue(next, "height", pxStyleValue(rect.height));
      setStyleValue(next, "padding", cs.padding);
      setStyleValue(next, "paddingTop", cs.paddingTop);
      setStyleValue(next, "paddingRight", cs.paddingRight);
      setStyleValue(next, "paddingBottom", cs.paddingBottom);
      setStyleValue(next, "paddingLeft", cs.paddingLeft);
      setStyleValue(next, "margin", cs.margin);
      setStyleValue(next, "marginTop", cs.marginTop);
      setStyleValue(next, "marginRight", cs.marginRight);
      setStyleValue(next, "marginBottom", cs.marginBottom);
      setStyleValue(next, "marginLeft", cs.marginLeft);
    } catch (styleErr) {}
    return Object.keys(next).length ? next : null;
  }
  /** getBoundingClientRect in a subframe is relative to that frame; fixed overlays in the root need root layout coords. */
  function boundingRectInRootLayoutViewport(el) {
    var br = el.getBoundingClientRect();
    var x = br.left;
    var y = br.top;
    var w = br.width;
    var h = br.height;
    var doc = el.ownerDocument;
    var win = doc ? doc.defaultView : null;
    while (win && win !== win.top) {
      var frame = win.frameElement;
      if (!frame) break;
      var fr = frame.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      doc = frame.ownerDocument;
      win = doc ? doc.defaultView : null;
    }
    return { x: x, y: y, width: w, height: h };
  }
  try {
    var doc = document;
    var de = doc.documentElement;
    var px = ox, py = oy;
    if (hostW > 0 && hostH > 0) {
      var gww = Math.max(1, de.clientWidth || window.innerWidth || hostW);
      var ghh = Math.max(1, de.clientHeight || window.innerHeight || hostH);
      px = Math.round((ox * gww) / hostW);
      py = Math.round((oy * ghh) / hostH);
    }
    var iw = Math.max(1, de.clientWidth || window.innerWidth);
    var ih = Math.max(1, de.clientHeight || window.innerHeight);
    px = Math.max(0, Math.min(px, iw - 0.001));
    py = Math.max(0, Math.min(py, ih - 0.001));
    var el = pickElementAt(px, py);
    if (!el || el === doc.documentElement || el === doc.body) {
      return JSON.stringify({ ok: false, code: "no-hit" });
    }
    var r = boundingRectInRootLayoutViewport(el);
    var rbGuest = roundBounds(r);
    var selectorHint = selectorHintFor(el);
    var elementStyle = computedElementStyle(el, r);
    var htmlExcerpt = null;
    if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement && el.type === "password") {
      htmlExcerpt = null;
    } else {
      try {
        var clone = el.cloneNode(true);
        if (clone && clone.nodeType === 1) {
          sanitizeTree(clone);
          var html = clone.outerHTML || "";
          var max = 8000;
          if (html.length > max) html = html.slice(0, max) + "\\n...[truncated]";
          htmlExcerpt = html;
        }
      } catch (he) {
        htmlExcerpt = null;
      }
    }
    return JSON.stringify({
      ok: true,
      bounds: rbGuest,
      selectorHint: selectorHint,
      htmlExcerpt: htmlExcerpt,
      elementStyle: elementStyle
    });
  } catch (err) {
    return JSON.stringify({ ok: false, code: "hit-test-error" });
  }
})()`;
}

const ELEMENT_STYLE_STRING_KEYS = [
  "textColor",
  "background",
  "font",
  "fontSize",
  "fontWeight",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "borderColor",
  "borderWidth",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "width",
  "height",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
] as const;

function sanitizeElementStyleValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (!text) return undefined;
  return text.length > PREVIEW_ANNOTATION_STRING_MAX.visualValue
    ? text.slice(0, PREVIEW_ANNOTATION_STRING_MAX.visualValue)
    : text;
}

function parseElementStylePayload(value: unknown): BrowserPreviewElementStyle | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const next: BrowserPreviewElementStyle = {};
  for (const key of ELEMENT_STYLE_STRING_KEYS) {
    const text = sanitizeElementStyleValue(p[key]);
    if (text) next[key] = text;
  }
  if (typeof p.opacity === "number" && Number.isFinite(p.opacity)) {
    next.opacity = Math.min(1, Math.max(0, p.opacity));
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** Validates hit-test JSON from the guest so spoofed shapes never become typed results. */
function parseHitTestPayload(parsed: unknown): HitTestResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.ok === false) return parseHitTestFailure(p.code);
  if (p.ok !== true) return null;
  const bounds = parseBoundsRecord(p.bounds);
  if (!bounds) return null;
  return createHitTestSuccess(p, bounds);
}

function parseHitTestFailure(code: unknown): HitTestResult | null {
  return typeof code === "string" ? { ok: false, code } : null;
}

function createHitTestSuccess(p: Record<string, unknown>, bounds: Bounds): HitTestResult {
  return {
    ok: true,
    bounds,
    selectorHint: p.selectorHint == null ? null : sanitizeSelectorHintFromGuest(String(p.selectorHint)),
    htmlExcerpt: sanitizeHitTestHtmlExcerpt(p.htmlExcerpt),
    elementStyle: parseElementStylePayload(p.elementStyle),
  };
}

function sanitizeHitTestHtmlExcerpt(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const scrubbed = scrubHtmlExcerptForOutbound(value);
  return scrubbed.length > 0 ? scrubbed : null;
}

/**
 * Executes the hit-test script in the guest and returns the validated result,
 * or null if the webContents is gone or the script throws.
 */
async function runElementHitTest(
  webContents: WebContents,
  overlayX: number,
  overlayY: number,
  hostBounds: Bounds | null,
): Promise<HitTestResult | null> {
  if (webContents.isDestroyed()) return null;
  const rx = Math.round(overlayX);
  const ry = Math.round(overlayY);
  const hw = hostBounds && hostBounds.width > 0 ? hostBounds.width : 0;
  const hh = hostBounds && hostBounds.height > 0 ? hostBounds.height : 0;
  try {
    const raw: unknown = await webContents.executeJavaScript(buildHitTestJs(rx, ry, hw, hh), true);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed: unknown = JSON.parse(text);
    return parseHitTestPayload(parsed);
  } catch {
    return null;
  }
}

/**
 * Removes the main-frame navigation listener registered at the start of an overlay capture.
 */
function endOverlaySession(s: PreviewSession): void {
  if (s.navigationAbortDisposable) {
    s.navigationAbortDisposable();
    s.navigationAbortDisposable = null;
  }
}

/**
 * Aborts an in-progress overlay capture, cancels the pending promise, and tears down
 * the guest highlight.
 */
export function abortOverlayCapture(s: PreviewSession, error: string): void {
  endOverlaySession(s);
  const pending = s.overlayPending;
  s.overlayPending = null;
  clearOverlayPollTimers(s);
  const webContents = pending?.webContents ?? resolveActiveCaptureWebContents(s);
  removeOverlayHighlighter(webContents, pending?.mode);
  if (pending) pending.finish({ ok: false, error });
}

function clearOverlayPollTimers(s: PreviewSession): void {
  if (s.elementPickPollTimer) clearTimeout(s.elementPickPollTimer);
  if (s.regionPollTimer) clearTimeout(s.regionPollTimer);
  s.elementPickPollTimer = null;
  s.regionPollTimer = null;
}

function removeOverlayHighlighter(
  webContents: WebContents | null,
  mode: "region" | "element" | undefined,
): void {
  if (!webContents || webContents.isDestroyed()) return;
  if (mode === "region") return void removeRgMarqueeHighlighter(webContents);
  if (mode === "element") return void removeEpPickHighlighter(webContents);
  void removeRgMarqueeHighlighter(webContents);
  void removeEpPickHighlighter(webContents);
}

/**
 * Attaches a did-start-navigation listener that aborts the overlay capture when the
 * main frame navigates away. Returns a disposable that removes the listener.
 */
function attachMainFrameNavigationAbort(s: PreviewSession, webContents: WebContents): () => void {
  const handler = (_event: unknown, _url: string, _isSameDocument: boolean, isMainFrame: boolean): void => {
    if (isMainFrame) abortOverlayCapture(s, "navigated-away");
  };
  webContents.on("did-start-navigation", handler);
  return () => webContents.removeListener("did-start-navigation", handler);
}

/**
 * Starts a new overlay capture session, replacing any previous navigation abort listener.
 */
function beginOverlaySession(s: PreviewSession, webContents: WebContents): void {
  if (s.navigationAbortDisposable) {
    s.navigationAbortDisposable();
    s.navigationAbortDisposable = null;
  }
  s.navigationAbortDisposable = attachMainFrameNavigationAbort(s, webContents);
}

/** Returns whether the pending capture still owns the currently adopted guest. */
function pendingCaptureStillOwnsSurface(
  s: PreviewSession,
  webContents: WebContents,
): boolean {
  return resolveActiveCaptureWebContents(s) === webContents;
}

/** Returns whether the pending operation still matches the adopted guest. */
function overlaySessionMatches(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
): boolean {
  return s.overlayPending === pending &&
    !pending.webContents.isDestroyed() &&
    pendingCaptureStillOwnsSurface(s, pending.webContents);
}

/** Returns whether the exact pending operation still owns its adopted guest. */
function overlaySessionStillCurrent(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
): boolean {
  if (!overlaySessionMatches(s, pending)) {
    if (s.overlayPending === pending) {
      abortOverlayCapture(s, "no-preview");
    }
    return false;
  }
  return true;
}

/** Cleans a late injection after its operation no longer owns the guest. */
async function cleanupLateInjection(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  remove: (webContents: WebContents) => Promise<void>,
): Promise<void> {
  if (overlaySessionMatches(s, pending)) return;
  if (s.overlayPending === pending) {
    abortOverlayCapture(s, "no-preview");
    return;
  }
  if (!pending.webContents.isDestroyed()) {
    await remove(pending.webContents);
  }
}

/** Completes one overlay operation and releases its navigation and poll ownership. */
function finishOverlaySession(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  result: PreviewPictureReferenceResult,
): void {
  if (s.overlayPending === pending) {
    s.overlayPending = null;
    endOverlaySession(s);
    if (pending.mode === "region") {
      if (s.regionPollTimer) clearTimeout(s.regionPollTimer);
      s.regionPollTimer = null;
    } else {
      if (s.elementPickPollTimer) clearTimeout(s.elementPickPollTimer);
      s.elementPickPollTimer = null;
    }
  }
  pending.finish(result);
}

/**
 * Registers all overlay-related IPC handlers:
 * region-overlay-submit, region-overlay-cancel, cancel-capture,
 * capture-picture-region, capture-picture-element-pick.
 *
 * Element-pick has no dedicated IPC handlers anymore. The pick session runs entirely
 * inside the guest page via {@link EP_INJECT_JS}; the host polls `window.__mcodeEpState`
 * for commit/cancel signals.
 * Call once at app startup.
 */
export function registerOverlayHandlers(): void {
  ipcMain.handle("preview:cancel-capture", (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const s = getSession(win);
    if (!s.overlayPending) return;
    abortOverlayCapture(s, "cancelled");
  });

  ipcMain.handle(
    "preview:capture-picture-region",
    async (_event): Promise<PreviewPictureReferenceResult> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const s = getSession(win);
      if (s.overlayPending) {
        abortOverlayCapture(s, "cancelled");
      }

      if (!s.lastBounds) return { ok: false, error: "no-bounds" };
      const webContents = resolveActiveCaptureWebContents(s);
      if (!webContents) {
        return { ok: false, error: "no-preview" };
      }

      return await new Promise<PreviewPictureReferenceResult>((resolve) => {

        let settled = false;
        const finishOnce = (r: PreviewPictureReferenceResult): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };

        const pending = { mode: "region" as const, finish: finishOnce, hostWin: win, webContents };
        s.overlayPending = pending;
        beginOverlaySession(s, webContents);

        void (async (): Promise<void> => {
          await injectRgMarqueeHighlighter(webContents);
          if (!overlaySessionMatches(s, pending)) {
            await cleanupLateInjection(s, pending, removeRgMarqueeHighlighter);
            return;
          }
          schedulePollRegion(s, win);
        })();
      });
    },
  );

  ipcMain.handle(
    "preview:capture-picture-element-pick",
    async (_event): Promise<PreviewPictureReferenceResult> => {
      const win = BrowserWindow.fromWebContents(_event.sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };

      const s = getSession(win);
      if (s.overlayPending) {
        abortOverlayCapture(s, "cancelled");
      }

      if (!s.lastBounds) return { ok: false, error: "no-bounds" };
      const webContents = resolveActiveCaptureWebContents(s);
      if (!webContents) {
        return { ok: false, error: "no-preview" };
      }

      return await new Promise<PreviewPictureReferenceResult>((resolve) => {

        let settled = false;
        const finishOnce = (r: PreviewPictureReferenceResult): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };

        const pending = { mode: "element" as const, finish: finishOnce, hostWin: win, webContents };
        s.overlayPending = pending;
        beginOverlaySession(s, webContents);

        void (async (): Promise<void> => {
          await injectEpPickHighlighter(webContents);
          if (!overlaySessionMatches(s, pending)) {
            await cleanupLateInjection(s, pending, removeEpPickHighlighter);
            return;
          }
          schedulePoll(s, win);
        })();
      });
    },
  );
}

/**
 * Schedules the next region-capture poll tick. Mirrors {@link schedulePoll} for
 * element pick; uses a separate timer slot so the two in-guest sessions can
 * coexist conceptually (the system only allows one at a time today, but the
 * separation keeps cancellation paths clean).
 */
/**
 * Steady-state poll interval (ms) for the in-guest capture state objects.
 *
 * Was 60ms but that produced ~16 executeJavaScript IPC round-trips per second
 * for the entire duration of a region or element-pick session, contending with
 * any guest-page work. 120ms halves that load with no perceptible commit-to-
 * attach latency penalty: the user's click commits a structured value into
 * `window.__mcodeRgState` / `window.__mcodeEpState` immediately, and a worst-
 * case 120ms drain still lands the attach within a single interaction frame.
 */
const CAPTURE_POLL_MS = 120;

function schedulePollRegion(s: PreviewSession, hostWin: BrowserWindow): void {
  if (s.regionPollTimer) {
    clearTimeout(s.regionPollTimer);
  }
  s.regionPollTimer = setTimeout(() => {
    s.regionPollTimer = null;
    void runRegionPollTick(s, hostWin);
  }, CAPTURE_POLL_MS);
}

/**
 * Drives one tick of the region-capture poll loop: reads `window.__mcodeRgState`,
 * commits or cancels accordingly, otherwise reschedules.
 */
async function runRegionPollTick(s: PreviewSession, hostWin: BrowserWindow): Promise<void> {
  const pending = s.overlayPending;
  if (!overlayPollCanStart(s, pending, "region", hostWin)) return;
  const payload = await readOverlayPollPayload<RgPollPayload>(pending.webContents, RG_POLL_JS);
  if (!overlayPollStillCurrent(s, pending, "region")) return;
  if (!payload || payload.state === "gone") {
    await reinjectOverlayPoll(pending.webContents, RG_INJECT_JS);
    schedulePollRegion(s, hostWin);
    return;
  }

  if (payload.state === "cancelled") {
    abortOverlayCapture(s, "cancelled");
    return;
  }

  if (payload.state === "commit") {
    await finishRegionCapture(s, {
      x: payload.x,
      y: payload.y,
      width: payload.width,
      height: payload.height,
    });
    return;
  }

  schedulePollRegion(s, hostWin);
}

/**
 * Runs the capture for a committed region rectangle and produces the payload.
 * Tears down the injected marquee + handlers before capturePage so the dashed
 * frame is not in the PNG.
 */
async function finishRegionCapture(s: PreviewSession, rect: Bounds): Promise<void> {
  const pending = s.overlayPending;
  if (!pending || pending.mode !== "region") return;
  clearRegionPollTimer(s);
  if (!overlaySessionStillCurrent(s, pending)) return;
  const lb = s.lastBounds;
  if (!lb) {
    await finishOverlayCaptureFailure(s, pending, removeRgMarqueeHighlighter, "no-bounds");
    return;
  }
  const r = clampRectInPlace(rect, lb.width, lb.height);
  if (r.width < 4 || r.height < 4) {
    await finishOverlayCaptureFailure(s, pending, removeRgMarqueeHighlighter, "region-too-small");
    return;
  }
  await completeOverlayCapture(s, pending, r, removeRgMarqueeHighlighter, "region", { captureKind: "region" });
}

/**
 * Schedules the next state poll in the element-pick loop. The recursive setTimeout
 * (vs. setInterval) lets us await executeJavaScript between ticks so we never queue
 * up overlapping polls if the guest is slow.
 */
function schedulePoll(s: PreviewSession, hostWin: BrowserWindow): void {
  if (s.elementPickPollTimer) {
    clearTimeout(s.elementPickPollTimer);
  }
  s.elementPickPollTimer = setTimeout(() => {
    s.elementPickPollTimer = null;
    void runElementPickPollTick(s, hostWin);
  }, CAPTURE_POLL_MS);
}

/**
 * Drives one tick of the element-pick poll loop: reads `window.__mcodeEpState`,
 * commits or cancels accordingly, otherwise reschedules.
 */
async function runElementPickPollTick(s: PreviewSession, hostWin: BrowserWindow): Promise<void> {
  const pending = s.overlayPending;
  if (!overlayPollCanStart(s, pending, "element", hostWin)) return;
  const webContents = pending.webContents;
  const payload = await readOverlayPollPayload<EpPollPayload>(webContents, EP_POLL_JS);
  if (!overlayPollStillCurrent(s, pending, "element")) return;
  if (!payload || payload.state === "gone") {
    await reinjectOverlayPoll(webContents, EP_INJECT_JS);
    schedulePoll(s, hostWin);
    return;
  }

  if (payload.state === "cancelled") {
    abortOverlayCapture(s, "cancelled");
    return;
  }

  if (payload.state === "commit") {
    await finishElementPickCapture(s, payload.x, payload.y);
    return;
  }

  schedulePoll(s, hostWin);
}

function overlayPollCanStart(
  session: PreviewSession,
  pending: PreviewSession["overlayPending"],
  mode: "region" | "element",
  hostWin: BrowserWindow,
): pending is NonNullable<PreviewSession["overlayPending"]> {
  if (!pending || pending.mode !== mode) return false;
  if (hostWin.isDestroyed()) {
    abortOverlayCapture(session, "no-window");
    return false;
  }
  if (pending.webContents.isDestroyed() || !pendingCaptureStillOwnsSurface(session, pending.webContents)) {
    abortOverlayCapture(session, "no-preview");
    return false;
  }
  return true;
}

async function readOverlayPollPayload<T>(webContents: WebContents, script: string): Promise<T | null> {
  try {
    const raw: unknown = await webContents.executeJavaScript(script, true);
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as T;
  } catch {
    return null;
  }
}

function overlayPollStillCurrent(
  session: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  mode: "region" | "element",
): boolean {
  if (session.overlayPending !== pending || pending.mode !== mode) return false;
  if (!pendingCaptureStillOwnsSurface(session, pending.webContents)) {
    abortOverlayCapture(session, "no-preview");
    return false;
  }
  return true;
}

async function reinjectOverlayPoll(webContents: WebContents, script: string): Promise<void> {
  if (webContents.isDestroyed()) return;
  try {
    await webContents.executeJavaScript(script, true);
  } catch {
    /* navigation still in flight */
  }
}

/**
 * Runs the authoritative hit-test on the commit point and produces the capture payload.
 * Tears down the injected handlers before capturePage so the amber highlight isn't burned in.
 */
async function finishElementPickCapture(
  s: PreviewSession,
  x: number,
  y: number,
): Promise<void> {
  const pending = s.overlayPending;
  if (!pending || pending.mode !== "element") return;

  if (!isFiniteElementPickPoint(x, y)) {
    abortOverlayCapture(s, "no-hit");
    return;
  }
  clearElementPickPollTimer(s);
  if (!overlaySessionStillCurrent(s, pending)) return;
  const preparation = await prepareElementPickCapture(s, pending, x, y);
  if (!preparation) return;
  if (!preparation.ok) {
    await finishOverlayCaptureFailure(s, pending, removeEpPickHighlighter, preparation.error);
    return;
  }
  await completeOverlayCapture(s, pending, preparation.bounds, removeEpPickHighlighter, "element", {
    captureKind: "element",
    selectorHint: preparation.hit.selectorHint,
    htmlExcerpt: preparation.hit.htmlExcerpt,
    elementStyle: preparation.hit.elementStyle,
  });
}

function isFiniteElementPickPoint(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y);
}

async function prepareElementPickCapture(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  x: number,
  y: number,
): Promise<
  | { ok: true; bounds: Bounds; hit: Extract<HitTestResult, { ok: true }> }
  | { ok: false; error: "no-bounds" | "no-hit" | "region-too-small" }
  | null
> {
  const layoutBounds = s.lastBounds;
  if (!layoutBounds) return { ok: false, error: "no-bounds" };
  const hit = await runElementHitTest(
    pending.webContents,
    x,
    y,
    hostBoundsForHitTest(s, pending.webContents),
  );
  if (!overlaySessionStillCurrent(s, pending)) return null;
  if (!hit || !hit.ok) {
    return { ok: false, error: "no-hit" };
  }
  const bounds = clampRectInPlace(hit.bounds, layoutBounds.width, layoutBounds.height);
  if (bounds.width < 4 || bounds.height < 4) {
    return { ok: false, error: "region-too-small" };
  }
  return { ok: true, bounds, hit };
}

function clearRegionPollTimer(s: PreviewSession): void {
  if (s.regionPollTimer) clearTimeout(s.regionPollTimer);
  s.regionPollTimer = null;
}

function clearElementPickPollTimer(s: PreviewSession): void {
  if (s.elementPickPollTimer) clearTimeout(s.elementPickPollTimer);
  s.elementPickPollTimer = null;
}

async function finishOverlayCaptureFailure(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  remove: (webContents: WebContents) => Promise<void>,
  error: string,
): Promise<void> {
  await remove(pending.webContents);
  if (overlaySessionStillCurrent(s, pending)) {
    finishOverlaySession(s, pending, { ok: false, error });
  }
}

async function completeOverlayCapture(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  bounds: Bounds,
  remove: (webContents: WebContents) => Promise<void>,
  namePrefix: "region" | "element",
  captureOptions: Parameters<typeof buildBrowserCapturePayload>[5],
): Promise<void> {
  try {
    const buffer = await captureOverlayPng(s, pending, bounds, remove);
    if (!buffer) return;
    const meta = await persistOverlayPng(s, pending, buffer, namePrefix);
    if (!meta) return;
    const capture = await buildBrowserCapturePayload(
      pending.webContents,
      bounds,
      s.consoleBuffer,
      snapshotFailedRequestsForCapture(s),
      s.workspaceId,
      captureOptions,
    );
    if (!overlaySessionStillCurrent(s, pending)) return;
    finishOverlaySession(s, pending, { ok: true, meta, previewBytes: Uint8Array.from(buffer), capture });
  } catch {
    if (s.overlayPending === pending) {
      finishOverlaySession(s, pending, { ok: false, error: "capture-failed" });
    }
  }
}

async function captureOverlayPng(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  bounds: Bounds,
  remove: (webContents: WebContents) => Promise<void>,
): Promise<Buffer | null> {
  await remove(pending.webContents);
  if (!overlaySessionStillCurrent(s, pending)) return null;
  const buffer = (await pending.webContents.capturePage(bounds)).toPNG();
  if (!overlaySessionStillCurrent(s, pending)) return null;
  if (buffer.length > 0) return buffer;
  finishOverlaySession(s, pending, { ok: false, error: "empty-capture" });
  return null;
}

async function persistOverlayPng(
  s: PreviewSession,
  pending: NonNullable<PreviewSession["overlayPending"]>,
  buffer: Buffer,
  namePrefix: "region" | "element",
): Promise<AttachmentMeta | null> {
  const id = randomUUID();
  const stem = previewCaptureFileStem(pending.webContents.getURL());
  const tempDir = join(app.getPath("temp"), "mcode-attachments");
  if (!overlaySessionStillCurrent(s, pending)) return null;
  await mkdir(tempDir, { recursive: true });
  if (!overlaySessionStillCurrent(s, pending)) return null;
  const sourcePath = join(tempDir, `${id}.png`);
  await writeFile(sourcePath, buffer);
  if (!overlaySessionStillCurrent(s, pending)) return null;
  return {
    id,
    name: `preview-${namePrefix}-${stem}-${Date.now()}.png`,
    mimeType: "image/png",
    sizeBytes: buffer.length,
    sourcePath,
  };
}
