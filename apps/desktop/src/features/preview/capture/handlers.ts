/**
 * Screenshot capture, guest page context extraction, and capture payload construction
 * for the embedded BrowserSurfaceHost page.
 */

import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { BrowserWindow, app, ipcMain, type WebContents } from "electron";
import {
  clampMcodeBrowserCaptureV2,
  MCODE_BROWSER_CAPTURE_V2_STRING_MAX,
  type AttachmentMeta,
  type McodeBrowserCaptureV2,
} from "@mcode/contracts";
import { redactMcodeBrowserCaptureV2 } from "@mcode/shared";
import { type Bounds, type PreviewSession, type CaptureFinishResult, sessions, getSession } from "../state/window-session.js";
import { persistBrowserCaptureSpill } from "./spill-store.js";
import { resolveActivePreviewWebContents } from "../surfaces/active-web-contents.js";

/**
 * Outcome of capturing the visible preview viewport as a PNG attachment.
 * Alias of {@link CaptureFinishResult} for public export; the type is defined in
 * preview-session to avoid a circular dependency.
 */
export type PreviewPictureReferenceResult = CaptureFinishResult;

/** Structured preview context without PNG bytes (fence-only composer attachment). */
export type PreviewContextReferenceResult =
  | { ok: true; capture: McodeBrowserCaptureV2 }
  | { ok: false; error: string };

type AnnotationSnapshotMarker = {
  displayNumber: number;
  bounds: Bounds;
};

type AnnotationSnapshotRequest = {
  activeDisplayNumber: number;
  activeBounds: Bounds;
  markers: AnnotationSnapshotMarker[];
};

/** Hard cap per guest-derived string before redaction so hostile pages cannot exhaust memory. */
const GUEST_TEXT_SAFETY_MAX = 500_000;

/** Maximum number of console lines buffered per session. */
export const PREVIEW_CONSOLE_BUFFER_MAX = 48;

/** Maximum length of a single console line stored in the buffer. */
export const PREVIEW_CONSOLE_LINE_MAX = 480;

/** Maximum number of failed request entries buffered per session. */
export const PREVIEW_FAILED_REQUEST_MAX = 24;

/** Maximum annotation markers burned into one snapshot. */
const PREVIEW_ANNOTATION_SNAPSHOT_MARKER_MAX = 50;

/** Max length for selector hints after guest + main sanitization (keeps prompts small, bounds CSS injection). */
export const SELECTOR_HINT_MAX_LEN = 512;

/** Guest-run: visible text, headings, interactive outline, scroll and layout viewport metrics. */
const CAPTURE_PAGE_CONTEXT_JS = `(function () {
  try {
    var de = document.documentElement;
    var body = document.body;
    var vw = Math.max(0, de.clientWidth || 0);
    var vh = Math.max(0, de.clientHeight || 0);
    var sx = window.scrollX || 0;
    var sy = window.scrollY || 0;
    var vt = "";
    if (body) {
      vt = (body.innerText || "").replace(/\\s+/g, " ").trim();
    }
    if (vt.length > 12000) vt = vt.slice(0, 12000) + String.fromCharCode(10) + "...[truncated]";
    var ho = [];
    var hs = document.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (var i = 0; i < hs.length && i < 80; i++) {
      var t = (hs[i].textContent || "").trim().replace(/\\s+/g, " ");
      if (!t) continue;
      ho.push(hs[i].tagName.toUpperCase() + ": " + t.slice(0, 200));
    }
    var headingOutline = ho.slice(0, 60).join(String.fromCharCode(10));
    if (headingOutline.length > 4000) headingOutline = headingOutline.slice(0, 4000) + String.fromCharCode(10) + "...[truncated]";
    var io = [];
    var els = document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab]');
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return false;
      var st = window.getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") return false;
      return true;
    }
    function visibleLabel(el) {
      var lab = el.getAttribute("aria-label");
      if (lab && lab.trim()) return lab.trim();
      var tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        var ph = el.placeholder || "";
        if (ph.trim()) return ph.trim();
        return String(el.name || el.type || "input");
      }
      var tx = (el.textContent || "").trim().replace(/\\s+/g, " ");
      if (tx) return tx.slice(0, 80);
      return String(el.getAttribute("href") || "");
    }
    for (var j = 0, seen = 0; j < els.length && seen < 120; j++) {
      var el = els[j];
      if (!isVisible(el)) continue;
      seen++;
      io.push("- [" + (el.getAttribute("role") || el.tagName.toLowerCase()) + "] " + visibleLabel(el).slice(0, 120));
    }
    var interactiveOutline = io.join(String.fromCharCode(10));
    if (interactiveOutline.length > 8000) interactiveOutline = interactiveOutline.slice(0, 8000) + String.fromCharCode(10) + "...[truncated]";
    return JSON.stringify({
      visibleText: vt,
      headingOutline: headingOutline,
      interactiveOutline: interactiveOutline,
      scrollX: sx,
      scrollY: sy,
      layoutWidth: vw,
      layoutHeight: vh
    });
  } catch (e) {
    return JSON.stringify({ error: "context-failed" });
  }
})()`;

type GuestPageContextPayload = {
  visibleText?: string;
  headingOutline?: string;
  interactiveOutline?: string;
  scrollX?: number;
  scrollY?: number;
  layoutWidth?: number;
  layoutHeight?: number;
  error?: string;
};

/**
 * Executes CAPTURE_PAGE_CONTEXT_JS in the guest and returns the parsed result,
 * or null if the webContents is gone or the script throws.
 */
async function captureGuestPageContextForCapture(
  webContents: WebContents,
): Promise<GuestPageContextPayload | null> {
  if (webContents.isDestroyed()) return null;
  try {
    const raw: unknown = await webContents.executeJavaScript(CAPTURE_PAGE_CONTEXT_JS, true);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as GuestPageContextPayload;
  } catch {
    return null;
  }
}

/** Strips control chars from visible text shipped to the model (guest innerText). */
function scrubVisibleTextForOutbound(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Removes disallowed characters and nested executable-ish blobs from excerpt text shipped to the model. */
export function scrubHtmlExcerptForOutbound(s: string): string {
  let t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<!-- stripped -->");
  t = t.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "<!-- stripped -->");
  t = t.replace(/<iframe\b[^>]*\/?>/gi, "<!-- stripped -->");
  return t;
}

/** Strips control chars and bounds length; defense in depth if guest output is abnormal. */
export function sanitizeSelectorHintFromGuest(s: string | null | undefined): string | null {
  if (s == null || typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (t.length === 0) return null;
  return t.length > SELECTOR_HINT_MAX_LEN ? t.slice(0, SELECTOR_HINT_MAX_LEN) : t;
}

/**
 * Appends a console message from the guest to the session buffer, capping at PREVIEW_CONSOLE_BUFFER_MAX.
 */
export function pushPreviewConsoleLine(s: PreviewSession, level: number, message: string): void {
  if (s.consoleBuffer.length >= PREVIEW_CONSOLE_BUFFER_MAX) {
    s.consoleBuffer.shift();
  }
  const kind = level >= 3 ? "error" : level === 2 ? "warning" : "log";
  const line = `${kind}: ${message.replace(/[\u0000-\u001F\u007F]/g, " ")}`.slice(0, PREVIEW_CONSOLE_LINE_MAX);
  s.consoleBuffer.push(line);
}

/**
 * Appends a failed network request entry to the session buffer, capping at PREVIEW_FAILED_REQUEST_MAX.
 */
export function pushFailedRequest(
  s: PreviewSession,
  entry: { url: string; statusCode: number; resourceType: string },
): void {
  if (s.failedRequestBuffer.length >= PREVIEW_FAILED_REQUEST_MAX) {
    s.failedRequestBuffer.shift();
  }
  s.failedRequestBuffer.push(entry);
}

/**
 * Returns a snapshot of the failed request buffer formatted for McodeBrowserCaptureV2,
 * or undefined when the buffer is empty.
 */
export function snapshotFailedRequestsForCapture(s: PreviewSession): McodeBrowserCaptureV2["failedRequests"] {
  if (s.failedRequestBuffer.length === 0) return undefined;
  return s.failedRequestBuffer.map((e) => ({
    url: e.url.length > 2048 ? e.url.slice(0, 2048) : e.url,
    statusCode: e.statusCode,
    resourceType: e.resourceType,
  }));
}

/** Joins recent main-process console lines for v2 capture (last chars if very long). */
export function formatConsoleTail(buffer: readonly string[]): string | undefined {
  if (buffer.length === 0) return undefined;
  const joined = buffer.join("\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (joined.length === 0) return undefined;
  return joined.length > 4000 ? joined.slice(-4000) : joined;
}

/**
 * Caps a guest-derived string at GUEST_TEXT_SAFETY_MAX to prevent hostile pages
 * from exhausting memory before redaction.
 */
function safetyCapGuestText(s: string): string {
  return s.length <= GUEST_TEXT_SAFETY_MAX ? s : s.slice(0, GUEST_TEXT_SAFETY_MAX);
}

/**
 * Returns true when any redacted text field exceeds the clamp threshold,
 * meaning a spill file is needed to carry the full content.
 */
function captureNeedsSpillPostRedact(c: McodeBrowserCaptureV2): boolean {
  const m = MCODE_BROWSER_CAPTURE_V2_STRING_MAX;
  return (
    (!!c.htmlExcerpt && c.htmlExcerpt.length > m.htmlExcerpt) ||
    (!!c.visibleTextExcerpt && c.visibleTextExcerpt.length > m.visibleTextExcerpt) ||
    (!!c.headingOutline && c.headingOutline.length > m.headingOutline) ||
    (!!c.interactiveOutlineExcerpt && c.interactiveOutlineExcerpt.length > m.interactiveOutlineExcerpt) ||
    (!!c.consoleTail && c.consoleTail.length > m.consoleTail)
  );
}

/** Full viewport bounds in guest-relative CSS pixels. */
export function viewportBoundsFallback(viewWidth: number, viewHeight: number): Bounds {
  return { x: 0, y: 0, width: Math.max(1, viewWidth), height: Math.max(1, viewHeight) };
}

/**
 * Parses an unknown value as a Bounds record, returning null if any field is missing or non-finite.
 */
export function parseBoundsRecord(b: unknown): Bounds | null {
  if (!b || typeof b !== "object") return null;
  const bb = b as Record<string, unknown>;
  const values = [bb.x, bb.y, bb.width, bb.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return { x: values[0] as number, y: values[1] as number, width: values[2] as number, height: values[3] as number };
}

/**
 * Clamps a rect so it fits within (0,0,maxW,maxH), flooring all coordinates.
 */
export function clampRectInPlace(rect: Bounds, maxW: number, maxH: number): Bounds {
  let { x, y, width, height } = rect;
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  width = Math.floor(width);
  height = Math.floor(height);
  width = Math.min(width, Math.max(0, maxW - x));
  height = Math.min(height, Math.max(0, maxH - y));
  return { x, y, width, height };
}

function parseDisplayNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > 999) return null;
  return value;
}

function clampSnapshotBounds(value: unknown, viewport: Bounds): Bounds | null {
  const parsed = parseBoundsRecord(value);
  if (!parsed) return null;
  const clamped = clampRectInPlace(parsed, viewport.width, viewport.height);
  if (clamped.width < 1 || clamped.height < 1) return null;
  return clamped;
}

function parseAnnotationSnapshotMarker(value: unknown, viewport: Bounds): AnnotationSnapshotMarker | null {
  if (!value || typeof value !== "object") return null;
  const marker = value as Record<string, unknown>;
  const displayNumber = parseDisplayNumber(marker.displayNumber);
  const bounds = clampSnapshotBounds(marker.bounds, viewport);
  if (!displayNumber || !bounds) return null;
  return { displayNumber, bounds };
}

function parseAnnotationSnapshotRequest(value: unknown, viewport: Bounds): AnnotationSnapshotRequest | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const activeDisplayNumber = parseDisplayNumber(payload.activeDisplayNumber);
  const activeBounds = clampSnapshotBounds(payload.activeBounds, viewport);
  if (!activeDisplayNumber || !activeBounds) return null;

  const markers = Array.isArray(payload.markers)
    ? payload.markers
        .slice(0, PREVIEW_ANNOTATION_SNAPSHOT_MARKER_MAX)
        .map((marker) => parseAnnotationSnapshotMarker(marker, viewport))
        .filter((marker): marker is AnnotationSnapshotMarker => marker !== null)
    : [];
  if (!markers.some((marker) => marker.displayNumber === activeDisplayNumber)) {
    markers.push({ displayNumber: activeDisplayNumber, bounds: activeBounds });
  }

  return { activeDisplayNumber, activeBounds, markers };
}

const REMOVE_ANNOTATION_SNAPSHOT_OVERLAY_JS = `(function(){
  var root = document.getElementById("__mcode_annotation_snapshot_overlay");
  if (root) root.remove();
  document.querySelectorAll('style[data-mcode-annotation-snapshot="1"]').forEach(function (node) { node.remove(); });
})()`;

const WAIT_FOR_ANNOTATION_SNAPSHOT_OVERLAY_PAINT_JS = `(function(){
  return new Promise(function(resolve) {
    try {
      var root = document.getElementById("__mcode_annotation_snapshot_overlay");
      if (!root) {
        resolve(false);
        return;
      }
      var settled = false;
      var finish = function(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      var raf = window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
      raf(function() {
        raf(function() {
          finish(true);
        });
      });
      setTimeout(function() {
        finish(true);
      }, 80);
    } catch (err) {
      resolve(false);
    }
  });
})()`;

function buildAnnotationSnapshotOverlayJs(payload: AnnotationSnapshotRequest): string {
  const json = JSON.stringify(payload);
  return `(function(){
    var data = ${json};
    var old = document.getElementById("__mcode_annotation_snapshot_overlay");
    if (old) old.remove();
    document.querySelectorAll('style[data-mcode-annotation-snapshot="1"]').forEach(function (node) { node.remove(); });
    var style = document.createElement("style");
    style.setAttribute("data-mcode-annotation-snapshot", "1");
    style.textContent = [
      "#__mcode_annotation_snapshot_overlay{position:fixed;inset:0;pointer-events:none;z-index:2147483645}",
      "#__mcode_annotation_snapshot_overlay .mcode-annotation-highlight{position:fixed;box-sizing:border-box;border:3px solid #f59e0b;background:rgba(245,158,11,.18);border-radius:3px;box-shadow:0 0 0 1px rgba(17,24,39,.55) inset,0 0 0 9999px rgba(0,0,0,.08)}",
      "#__mcode_annotation_snapshot_overlay .mcode-annotation-marker{position:fixed;width:30px;height:30px;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;color:#fff;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;text-shadow:0 1px 1px rgba(0,0,0,.35)}",
      "#__mcode_annotation_snapshot_overlay .mcode-annotation-marker::before{content:\\"\\";position:absolute;inset:1px;border-radius:999px;background:#f59e0b;box-shadow:0 4px 10px rgba(0,0,0,.28),0 0 0 2px rgba(17,24,39,.78)}",
      "#__mcode_annotation_snapshot_overlay .mcode-annotation-marker::after{content:\\"\\";position:absolute;left:9px;bottom:1px;width:8px;height:8px;border-radius:2px;background:#f59e0b;transform:rotate(45deg);box-shadow:1px 1px 0 rgba(17,24,39,.78)}",
      "#__mcode_annotation_snapshot_overlay .mcode-annotation-marker span{position:relative;z-index:1}"
    ].join("");
    (document.head || document.documentElement).appendChild(style);
    var root = document.createElement("div");
    root.id = "__mcode_annotation_snapshot_overlay";
    root.setAttribute("aria-hidden", "true");
    var highlight = document.createElement("div");
    highlight.className = "mcode-annotation-highlight";
    highlight.style.left = data.activeBounds.x + "px";
    highlight.style.top = data.activeBounds.y + "px";
    highlight.style.width = data.activeBounds.width + "px";
    highlight.style.height = data.activeBounds.height + "px";
    root.appendChild(highlight);
    for (var i = 0; i < data.markers.length; i++) {
      var marker = data.markers[i];
      var node = document.createElement("div");
      node.className = "mcode-annotation-marker";
      node.style.left = Math.max(16, marker.bounds.x + marker.bounds.width / 2) + "px";
      node.style.top = Math.max(16, marker.bounds.y + Math.min(marker.bounds.height / 2, 18)) + "px";
      var label = document.createElement("span");
      label.textContent = String(marker.displayNumber);
      node.appendChild(label);
      root.appendChild(node);
    }
    (document.body || document.documentElement).appendChild(root);
  })()`;
}

/** Sanitized hostname (or fallback) used in capture filenames for the preview tab. */
export function previewCaptureFileStem(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    if (u.protocol === "http:" || u.protocol === "https:") {
      const host = u.hostname
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48);
      if (host) return host;
    }
  } catch {
    /* use fallback stem */
  }
  return "page";
}

/** Typed capture envelope aligned with PNG bytes for outbound prompt augmentation (v2 adds text outline and console tail). */
type CaptureExtras = {
  captureKind?: "viewport" | "region" | "element";
  selectorHint?: string | null;
  htmlExcerpt?: string | null;
  elementStyle?: McodeBrowserCaptureV2["elementStyle"] | null;
};

function createCapturePayload(webContents: WebContents, boundsCss: Bounds, extras: CaptureExtras | undefined): McodeBrowserCaptureV2 {
  return {
    schemaVersion: 2,
    pageUrl: webContents.getURL(),
    pageTitle: webContents.getTitle() ?? "",
    capturedAt: new Date().toISOString(),
    bounds: { ...boundsCss },
    selectorHint:
      extras?.selectorHint != null ? sanitizeSelectorHintFromGuest(String(extras.selectorHint)) : null,
  };
}

function applyCaptureExtras(out: McodeBrowserCaptureV2, extras: CaptureExtras | undefined, tail: string | undefined): void {
  applyCaptureKind(out, extras);
  applyHtmlExcerpt(out, extras?.htmlExcerpt);
  applyConsoleTail(out, tail);
  applyElementStyle(out, extras?.elementStyle);
}

function applyCaptureKind(out: McodeBrowserCaptureV2, extras: CaptureExtras | undefined): void {
  if (extras?.captureKind !== undefined) out.captureKind = extras.captureKind;
}

function applyHtmlExcerpt(out: McodeBrowserCaptureV2, excerpt: string | null | undefined): void {
  if (!excerpt) return;
  const scrubbed = scrubHtmlExcerptForOutbound(excerpt);
  if (scrubbed.length > 0) out.htmlExcerpt = safetyCapGuestText(scrubbed);
}

function applyConsoleTail(out: McodeBrowserCaptureV2, tail: string | undefined): void {
  if (tail) out.consoleTail = tail;
}

function applyElementStyle(out: McodeBrowserCaptureV2, style: McodeBrowserCaptureV2["elementStyle"] | null | undefined): void {
  if (style && Object.keys(style).length > 0) out.elementStyle = style;
}

function appendCaptureText(out: McodeBrowserCaptureV2, field: "visibleTextExcerpt" | "headingOutline" | "interactiveOutlineExcerpt", value: string | undefined): void {
  if (!value) return;
  const scrubbed = scrubVisibleTextForOutbound(value);
  if (scrubbed.length > 0) out[field] = safetyCapGuestText(scrubbed);
}

function appendGuestContext(out: McodeBrowserCaptureV2, context: GuestPageContextPayload | null): void {
  if (!context || context.error) return;
  appendCaptureText(out, "visibleTextExcerpt", context.visibleText);
  appendCaptureText(out, "headingOutline", context.headingOutline);
  appendCaptureText(out, "interactiveOutlineExcerpt", context.interactiveOutline);
  appendViewportScroll(out, context);
  appendLayoutViewport(out, context);
}

function appendViewportScroll(out: McodeBrowserCaptureV2, context: GuestPageContextPayload): void {
  if (typeof context.scrollX !== "number" || !Number.isFinite(context.scrollX)) return;
  const scrollY = typeof context.scrollY === "number" && Number.isFinite(context.scrollY) ? context.scrollY : 0;
  out.viewportScroll = { scrollX: context.scrollX, scrollY };
}

function appendLayoutViewport(out: McodeBrowserCaptureV2, context: GuestPageContextPayload): void {
  if (typeof context.layoutWidth !== "number" || !Number.isFinite(context.layoutWidth)) return;
  if (typeof context.layoutHeight !== "number" || !Number.isFinite(context.layoutHeight)) return;
  out.layoutViewport = { width: Math.max(0, context.layoutWidth), height: Math.max(0, context.layoutHeight) };
}

async function persistCaptureSpillIfNeeded(
  capture: McodeBrowserCaptureV2,
  workspaceId: string | null,
): Promise<McodeBrowserCaptureV2> {
  const clamped = clampMcodeBrowserCaptureV2(capture);
  const id = workspaceId?.trim() ?? "";
  if (!id || !captureNeedsSpillPostRedact(capture)) return clamped;
  const spill = await persistBrowserCaptureSpill(id, capture);
  if (!spill) return clamped;
  clamped.spillAppDataPath = spill.appDataPath;
  clamped.spillAbsolutePath = spill.absolutePath;
  return clamped;
}

/** Builds a bounded, redacted Browser Capture v2 payload from an adopted guest. */
export async function buildBrowserCapturePayload(
  webContents: WebContents,
  boundsCss: Bounds,
  consoleBuffer: readonly string[],
  failedRequests: McodeBrowserCaptureV2["failedRequests"],
  workspaceId: string | null,
  extras?: CaptureExtras,
): Promise<McodeBrowserCaptureV2> {
  const context = await captureGuestPageContextForCapture(webContents);
  const tail = formatConsoleTail(consoleBuffer);
  const out = createCapturePayload(webContents, boundsCss, extras);
  applyCaptureExtras(out, extras, tail);
  appendGuestContext(out, context);
  if (failedRequests && failedRequests.length > 0) {
    out.failedRequests = failedRequests;
  }
  const redacted = redactMcodeBrowserCaptureV2(out);
  return persistCaptureSpillIfNeeded(redacted, workspaceId);
}

/**
 * Registers the webRequest.onCompleted interceptor for the given Electron session
 * to track failed HTTP/HTTPS responses per-session.
 */
export function registerWebRequestInterceptor(partition: Electron.Session): void {
  partition.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, recordFailedPreviewRequest);
}

function failedPreviewRequest(details: Electron.OnCompletedListenerDetails): { webContentsId: number; url: string; statusCode: number; resourceType: string } | null {
  const statusCode = details.statusCode ?? 0;
  if (statusCode > 0 && statusCode < 400) return null;
  if (details.webContentsId == null) return null;
  if (!details.url.startsWith("http://") && !details.url.startsWith("https://")) return null;
  return {
    webContentsId: details.webContentsId,
    url: details.url.length > 2048 ? details.url.slice(0, 2048) : details.url,
    statusCode,
    resourceType: String(details.resourceType ?? "other").slice(0, 32),
  };
}

function recordFailedPreviewRequest(details: Electron.OnCompletedListenerDetails): void {
  const request = failedPreviewRequest(details);
  if (!request) return;
  for (const session of sessions.values()) {
    const activeWebContents = resolveActivePreviewWebContents(session);
    if (!activeWebContents || activeWebContents.id !== request.webContentsId) continue;
    pushFailedRequest(session, request);
    return;
  }
}

/**
 * Registers the `preview:capture-picture-reference` and `preview:capture-context-reference`
 * IPC handlers. Call once at app startup.
 */
interface ActiveCapture {
  readonly session: PreviewSession;
  readonly webContents: WebContents;
}

function activeCapture(event: Electron.IpcMainInvokeEvent): ActiveCapture | PreviewPictureReferenceResult {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
  const session = getSession(win);
  const webContents = resolveActivePreviewWebContents(session);
  return webContents ? { session, webContents } : { ok: false, error: "no-preview" };
}

function isCaptureError(value: ActiveCapture | PreviewPictureReferenceResult): value is PreviewPictureReferenceResult {
  return "ok" in value;
}

async function persistCapturedPng(webContents: WebContents, prefix: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array; bounds: Bounds } | PreviewPictureReferenceResult> {
  const image = await webContents.capturePage();
  const buffer = image.toPNG();
  if (buffer.length === 0) return { ok: false, error: "empty-capture" };
  const id = NodeCrypto.randomUUID();
  const stem = previewCaptureFileStem(webContents.getURL());
  const tempDir = NodePath.join(app.getPath("temp"), "mcode-attachments");
  const tempPath = NodePath.join(tempDir, `${id}.png`);
  await NodeFSPromises.mkdir(tempDir, { recursive: true });
  await NodeFSPromises.writeFile(tempPath, buffer);
  const size = image.getSize();
  return {
    meta: { id, name: `${prefix}-${stem}-${Date.now()}.png`, mimeType: "image/png", sizeBytes: buffer.length, sourcePath: tempPath },
    bytes: Uint8Array.from(buffer),
    bounds: viewportBoundsFallback(size.width, size.height),
  };
}

function captureBounds(session: PreviewSession, fallback: Bounds): Bounds {
  return session.lastBounds ? viewportBoundsFallback(session.lastBounds.width, session.lastBounds.height) : fallback;
}

async function buildPictureResult(capture: ActiveCapture, prefix: string, bounds: Bounds | null): Promise<PreviewPictureReferenceResult> {
  const persisted = await persistCapturedPng(capture.webContents, prefix);
  if ("ok" in persisted) return persisted;
  const capturePayload = await buildBrowserCapturePayload(capture.webContents, bounds ?? captureBounds(capture.session, persisted.bounds), capture.session.consoleBuffer, snapshotFailedRequestsForCapture(capture.session), capture.session.workspaceId, { captureKind: "viewport" });
  return { ok: true, meta: persisted.meta, previewBytes: persisted.bytes, capture: capturePayload };
}

async function handlePictureCapture(event: Electron.IpcMainInvokeEvent): Promise<PreviewPictureReferenceResult> {
  const capture = activeCapture(event);
  if (isCaptureError(capture)) return capture;
  try {
    return await buildPictureResult(capture, "preview", null);
  } catch {
    return { ok: false, error: "capture-failed" };
  }
}

async function removeAnnotationOverlay(webContents: WebContents): Promise<void> {
  if (webContents.isDestroyed()) return;
  try {
    await webContents.executeJavaScript(REMOVE_ANNOTATION_SNAPSHOT_OVERLAY_JS, true);
  } catch {
    // Navigation can destroy the isolated page between capture and cleanup.
  }
}

async function paintAnnotationOverlay(webContents: WebContents, overlay: AnnotationSnapshotRequest): Promise<boolean> {
  await webContents.executeJavaScript(buildAnnotationSnapshotOverlayJs(overlay), true);
  return await webContents.executeJavaScript(WAIT_FOR_ANNOTATION_SNAPSHOT_OVERLAY_PAINT_JS, true) === true;
}

async function handleAnnotationCapture(event: Electron.IpcMainInvokeEvent, payload: unknown): Promise<PreviewPictureReferenceResult> {
  const capture = activeCapture(event);
  if (isCaptureError(capture)) return capture;
  const lastBounds = capture.session.lastBounds;
  if (!lastBounds) return { ok: false, error: "no-bounds" };
  const bounds = viewportBoundsFallback(lastBounds.width, lastBounds.height);
  const overlay = parseAnnotationSnapshotRequest(payload, bounds);
  if (!overlay) return { ok: false, error: "capture-failed" };
  try {
    if (!await paintAnnotationOverlay(capture.webContents, overlay)) return { ok: false, error: "capture-failed" };
    return await buildPictureResult(capture, "preview-annotation", bounds);
  } catch {
    return { ok: false, error: "capture-failed" };
  } finally {
    await removeAnnotationOverlay(capture.webContents);
  }
}

async function handleContextCapture(event: Electron.IpcMainInvokeEvent): Promise<PreviewContextReferenceResult> {
  const capture = activeCapture(event);
  if (isCaptureError(capture)) return capture;
  const lastBounds = capture.session.lastBounds;
  if (!lastBounds) return { ok: false, error: "no-bounds" };
  try {
    const bounds = viewportBoundsFallback(lastBounds.width, lastBounds.height);
    const payload = await buildBrowserCapturePayload(capture.webContents, bounds, capture.session.consoleBuffer, snapshotFailedRequestsForCapture(capture.session), capture.session.workspaceId, { captureKind: "viewport" });
    return { ok: true, capture: payload };
  } catch {
    return { ok: false, error: "capture-failed" };
  }
}

/** Registers the Preview capture IPC handlers. */
export function registerCaptureHandlers(): void {
  ipcMain.handle("preview:capture-picture-reference", handlePictureCapture);
  ipcMain.handle("preview:capture-annotation-snapshot", handleAnnotationCapture);
  ipcMain.handle("preview:capture-context-reference", handleContextCapture);
}
