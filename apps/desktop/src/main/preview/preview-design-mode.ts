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
import {
  BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
  BROWSER_AUTOMATION_MIN_VIEWPORT_PX,
  BrowserAutomationViewportPresentationRequestSchema,
  BrowserAutomationViewportPresentationResultSchema,
  BrowserAutomationViewportRequestSchema,
  BrowserAutomationViewportResultSchema,
  type BrowserAutomationViewportPresentationRequest,
  type BrowserAutomationViewportRequest,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  applyViewportPresentation,
  getActiveTab,
  getSession,
} from "./preview-session.js";
import { resolveActivePreviewWebContents } from "./preview-active-webcontents.js";

type ViewportSource = NonNullable<BrowserAutomationViewportRequest["source"]>;

interface ViewportOperationMetadata {
  readonly operationId?: string;
  readonly source?: ViewportSource;
  readonly targetGeneration?: number;
  readonly threadId?: string;
  readonly tabId?: string;
}

interface ViewportOperationResult extends ViewportOperationMetadata {
  readonly appliedViewport: { readonly width: number; readonly height: number } | null;
}

interface ViewportPresentationResult extends ViewportOperationMetadata {
  readonly presentation?: "fit" | "actual";
  readonly appliedViewport: { readonly width: number; readonly height: number } | null;
}

function viewportMetadata(
  payload: ViewportOperationMetadata,
  appliedViewport: { readonly width: number; readonly height: number } | null,
): ViewportOperationResult {
  return {
    ...(payload.operationId ? { operationId: payload.operationId } : {}),
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.targetGeneration === undefined ? {} : { targetGeneration: payload.targetGeneration }),
    ...(payload.threadId ? { threadId: payload.threadId } : {}),
    ...(payload.tabId ? { tabId: payload.tabId } : {}),
    appliedViewport,
  };
}

function presentationMetadata(
  payload: ViewportOperationMetadata,
  presentation: "fit" | "actual" | undefined,
  appliedViewport: { readonly width: number; readonly height: number } | null,
): ViewportPresentationResult {
  return {
    ...(presentation === undefined ? {} : { presentation }),
    ...viewportMetadata(payload, appliedViewport),
  };
}

function targetKey(threadId: string, tabId: string): string {
  return JSON.stringify([threadId, tabId]);
}

function currentViewportSize(
  session: ReturnType<typeof getSession>,
  key: string | null,
): { width: number; height: number } | null {
  const size = key
    ? session.viewportAppliedByTarget.get(key) ?? null
    : session.lastBounds
      ? { width: session.lastBounds.width, height: session.lastBounds.height }
      : null;
  if (!size) return null;
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < BROWSER_AUTOMATION_MIN_VIEWPORT_PX ||
    size.height < BROWSER_AUTOMATION_MIN_VIEWPORT_PX ||
    size.width > BROWSER_AUTOMATION_MAX_VIEWPORT_PX ||
    size.height > BROWSER_AUTOMATION_MAX_VIEWPORT_PX
  ) return null;
  return size;
}

function rememberAppliedViewport(
  session: ReturnType<typeof getSession>,
  key: string | null,
  appliedViewport: { width: number; height: number },
): void {
  if (!key) return;
  session.viewportAppliedByTarget.delete(key);
  session.viewportAppliedByTarget.set(key, appliedViewport);
  while (session.viewportAppliedByTarget.size > 128) {
    const oldest = session.viewportAppliedByTarget.keys().next().value as string | undefined;
    if (!oldest) break;
    session.viewportAppliedByTarget.delete(oldest);
  }
}

function rememberTargetGeneration(
  session: ReturnType<typeof getSession>,
  key: string | null,
  targetGeneration: number | undefined,
): void {
  if (!key || targetGeneration === undefined) return;
  session.viewportTargetGenerationByTarget.delete(key);
  session.viewportTargetGenerationByTarget.set(key, targetGeneration);
  while (session.viewportTargetGenerationByTarget.size > 128) {
    const oldest = session.viewportTargetGenerationByTarget.keys().next().value as string | undefined;
    if (!oldest) break;
    session.viewportTargetGenerationByTarget.delete(oldest);
  }
}

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
    (event, payload: unknown) => {
      const parsedPayload = BrowserAutomationViewportRequestSchema().safeParse(payload);
      if (!parsedPayload.success) {
        return BrowserAutomationViewportResultSchema().parse({
          ok: false,
          error: "invalid-viewport-request",
        });
      }
      return BrowserAutomationViewportResultSchema().parse((() => {
        const request: BrowserAutomationViewportRequest = parsedPayload.data;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
        const s = getSession(win);
        const operationId = request.operationId;
        const source = request.source;
        const targetGeneration = request.targetGeneration;
        const threadId = request.threadId;
        const tabId = request.tabId;
        const activeThreadId = s.lastPreviewThreadId;
        const activeTabId = activeThreadId ? getActiveTab(s, activeThreadId).id : null;
        const resolvedThreadId = threadId ?? activeThreadId;
        const resolvedTabId = tabId ?? activeTabId;
        const key = resolvedThreadId && resolvedTabId
          ? targetKey(resolvedThreadId, resolvedTabId)
          : null;
        const metadata: ViewportOperationMetadata = {
          ...(operationId === undefined ? {} : { operationId }),
          ...(source === undefined ? {} : { source }),
          ...(targetGeneration === undefined ? {} : { targetGeneration }),
          ...(threadId === undefined ? {} : { threadId }),
          ...(tabId === undefined ? {} : { tabId }),
        };
        const appliedBefore = currentViewportSize(s, key);
        if (
          (threadId !== undefined || tabId !== undefined) &&
          (resolvedThreadId === null ||
            resolvedTabId === null ||
            resolvedThreadId !== activeThreadId ||
            resolvedTabId !== activeTabId)
        ) {
          return {
            ok: false,
            error: "stale-target",
            ...viewportMetadata(metadata, appliedBefore),
          };
        }
        if (
          targetGeneration !== undefined &&
          key &&
          (s.viewportTargetGenerationByTarget.get(key) ?? -1) > targetGeneration
        ) {
          return {
            ok: false,
            error: "stale-target-generation",
            ...viewportMetadata(metadata, appliedBefore),
          };
        }
        if (!s.view || s.view.webContents.isDestroyed()) {
          return { ok: false, error: "no-view", ...viewportMetadata(metadata, appliedBefore) };
        }
        if (!s.lastBounds) {
          return { ok: false, error: "no-bounds", ...viewportMetadata(metadata, appliedBefore) };
        }

        const w = request.widthOverride;
        const h = request.heightOverride;
        if (
          typeof w !== "number" ||
          typeof h !== "number" ||
          !Number.isFinite(w) ||
          !Number.isFinite(h) ||
          w <= 0 ||
          h <= 0
        ) {
          return { ok: false, error: "invalid-dimensions", ...viewportMetadata(metadata, appliedBefore) };
        }

        let width = Math.min(
          BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
          Math.max(BROWSER_AUTOMATION_MIN_VIEWPORT_PX, Math.round(w)),
        );
        let height = Math.min(
          BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
          Math.max(BROWSER_AUTOMATION_MIN_VIEWPORT_PX, Math.round(h)),
        );

        width = Math.min(
          BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
          Math.max(BROWSER_AUTOMATION_MIN_VIEWPORT_PX, Math.round(width)),
        );
        height = Math.min(
          BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
          Math.max(BROWSER_AUTOMATION_MIN_VIEWPORT_PX, Math.round(height)),
        );

        const appliedViewport = { width, height };
        rememberAppliedViewport(s, key, appliedViewport);
        rememberTargetGeneration(s, key, targetGeneration);
        if (key && !s.viewportPresentationByTarget.has(key)) {
          s.viewportPresentationByTarget.set(key, "fit");
        }
        applyViewportPresentation(s, s.lastBounds, resolvedThreadId, resolvedTabId);
        return { ok: true, data: { width, height }, ...viewportMetadata(metadata, appliedViewport) };
      })());
    },
  );

  ipcMain.handle(
    "preview:design.set-presentation",
    (event, payload: unknown) => {
      const parsedPayload = BrowserAutomationViewportPresentationRequestSchema().safeParse(payload);
      if (!parsedPayload.success) {
        return BrowserAutomationViewportPresentationResultSchema().parse({
          ok: false,
          error: "invalid-viewport-presentation-request",
        });
      }
      return BrowserAutomationViewportPresentationResultSchema().parse((() => {
        const request: BrowserAutomationViewportPresentationRequest = parsedPayload.data;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
        const s = getSession(win);
        const activeThreadId = s.lastPreviewThreadId;
        const activeTabId = activeThreadId ? getActiveTab(s, activeThreadId).id : null;
        const resolvedThreadId = request.threadId ?? activeThreadId;
        const resolvedTabId = request.tabId ?? activeTabId;
        const key = resolvedThreadId && resolvedTabId
          ? targetKey(resolvedThreadId, resolvedTabId)
          : null;
        const metadata: ViewportOperationMetadata = {
          ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
          ...(request.source === undefined ? {} : { source: request.source }),
          ...(request.targetGeneration === undefined ? {} : { targetGeneration: request.targetGeneration }),
          ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
          ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
        };
        const appliedBefore = currentViewportSize(s, key);
        if (
          (request.threadId !== undefined || request.tabId !== undefined) &&
          (resolvedThreadId === null ||
            resolvedTabId === null ||
            resolvedThreadId !== activeThreadId ||
            resolvedTabId !== activeTabId)
        ) {
          return {
            ok: false,
            error: "stale-target",
            ...presentationMetadata(metadata, request.presentation, appliedBefore),
          };
        }
        if (
          request.targetGeneration !== undefined &&
          key &&
          (s.viewportTargetGenerationByTarget.get(key) ?? -1) > request.targetGeneration
        ) {
          return {
            ok: false,
            error: "stale-target-generation",
            ...presentationMetadata(metadata, request.presentation, appliedBefore),
          };
        }
        if (!s.view || s.view.webContents.isDestroyed()) {
          return {
            ok: false,
            error: "no-view",
            ...presentationMetadata(metadata, request.presentation, appliedBefore),
          };
        }
        if (!s.lastBounds) {
          return {
            ok: false,
            error: "no-bounds",
            ...presentationMetadata(metadata, request.presentation, appliedBefore),
          };
        }
        if (!key || !s.viewportAppliedByTarget.has(key)) {
          return {
            ok: false,
            error: "no-viewport",
            ...presentationMetadata(metadata, request.presentation, appliedBefore),
          };
        }

        s.viewportPresentationByTarget.set(key, request.presentation);
        const appliedViewport = s.viewportAppliedByTarget.get(key) ?? null;
        applyViewportPresentation(s, s.lastBounds, resolvedThreadId, resolvedTabId);
        return {
          ok: true,
          ...presentationMetadata(metadata, request.presentation, appliedViewport),
        };
      })());
    },
  );

  ipcMain.handle("preview:design.reset-viewport", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no-window" };
    const s = getSession(win);
    if (!s.view || s.view.webContents.isDestroyed())
      return { ok: false, error: "no-view" };
    if (!s.lastBounds) return { ok: false, error: "no-bounds" };
    const activeThreadId = s.lastPreviewThreadId;
    const activeTabId = activeThreadId ? getActiveTab(s, activeThreadId).id : null;
    const key = activeThreadId && activeTabId ? targetKey(activeThreadId, activeTabId) : null;
    if (key) {
      s.viewportAppliedByTarget.delete(key);
      s.viewportTargetGenerationByTarget.delete(key);
      s.viewportPresentationByTarget.delete(key);
    }
    applyViewportPresentation(s, s.lastBounds, activeThreadId, activeTabId);
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
