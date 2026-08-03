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
  BrowserAutomationViewportResetRequestSchema,
  BrowserAutomationViewportResetResultSchema,
  BrowserAutomationViewportResultSchema,
  type BrowserAutomationViewportPresentationRequest,
  type BrowserAutomationViewportRequest,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  applyViewportPresentation,
  getActiveTab,
  getSession,
  type TabState,
  viewportTargetKey,
} from "./preview-session.js";
import { resolveActivePreviewWebContents } from "./preview-active-webcontents.js";

type ViewportSource = NonNullable<BrowserAutomationViewportRequest["source"]>;

interface ViewportOperationMetadata {
  readonly operationId: string;
  readonly source: ViewportSource;
  readonly targetGeneration: number;
  readonly operationGeneration: number;
  readonly threadId: string;
  readonly tabId: string;
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
    operationId: payload.operationId,
    source: payload.source,
    targetGeneration: payload.targetGeneration,
    operationGeneration: payload.operationGeneration,
    threadId: payload.threadId,
    tabId: payload.tabId,
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

function admitViewportOperation(
  tab: TabState | null,
  targetGeneration: number,
  operationGeneration: number,
): "stale-target-generation" | "stale-operation-generation" | null {
  if (!tab) return "stale-target-generation";
  const admittedTargetGeneration = tab.viewportTargetGeneration;
  if (admittedTargetGeneration !== null && admittedTargetGeneration > targetGeneration) {
    return "stale-target-generation";
  }
  if (
    admittedTargetGeneration === targetGeneration &&
    (tab.viewportOperationGeneration ?? -1) > operationGeneration
  ) return "stale-operation-generation";
  tab.viewportTargetGeneration = targetGeneration;
  tab.viewportOperationGeneration = operationGeneration;
  return null;
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
        const { operationId, source, targetGeneration, operationGeneration, threadId, tabId } = request;
        const activeThreadId = s.lastPreviewThreadId;
        const activeTab = activeThreadId ? getActiveTab(s, activeThreadId) : null;
        const activeTabId = activeTab?.id ?? null;
        const resolvedThreadId = threadId;
        const resolvedTabId = tabId;
        const key = viewportTargetKey(resolvedThreadId, resolvedTabId);
        const metadata: ViewportOperationMetadata = {
          operationId,
          source,
          targetGeneration,
          operationGeneration,
          threadId,
          tabId,
        };
        const appliedBefore = currentViewportSize(s, key);
        if (
          (resolvedThreadId !== activeThreadId ||
            resolvedTabId !== activeTabId)
        ) {
          return {
            ok: false,
            error: "stale-target",
            ...viewportMetadata(metadata, appliedBefore),
          };
        }
        const admissionError = admitViewportOperation(
          activeTab,
          targetGeneration,
          operationGeneration,
        );
        if (admissionError) {
          return {
            ok: false,
            error: admissionError,
            ...viewportMetadata(metadata, appliedBefore),
          };
        }
        if (!s.view || s.view.webContents.isDestroyed()) {
          return { ok: false, error: "no-view", ...viewportMetadata(metadata, appliedBefore) };
        }
        if (!s.lastBounds) {
          return { ok: false, error: "no-bounds", ...viewportMetadata(metadata, appliedBefore) };
        }

        const width = Math.min(
          BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
          Math.max(BROWSER_AUTOMATION_MIN_VIEWPORT_PX, Math.round(request.widthOverride)),
        );
        const height = Math.min(
          BROWSER_AUTOMATION_MAX_VIEWPORT_PX,
          Math.max(BROWSER_AUTOMATION_MIN_VIEWPORT_PX, Math.round(request.heightOverride)),
        );

        const appliedViewport = { width, height };
        rememberAppliedViewport(s, key, appliedViewport);
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
        const activeTab = activeThreadId ? getActiveTab(s, activeThreadId) : null;
        const activeTabId = activeTab?.id ?? null;
        const resolvedThreadId = request.threadId;
        const resolvedTabId = request.tabId;
        const key = viewportTargetKey(resolvedThreadId, resolvedTabId);
        const metadata: ViewportOperationMetadata = request;
        const appliedBefore = currentViewportSize(s, key);
        if (
          (resolvedThreadId !== activeThreadId ||
            resolvedTabId !== activeTabId)
        ) {
          return {
            ok: false,
            error: "stale-target",
            ...presentationMetadata(metadata, request.presentation, appliedBefore),
          };
        }
        const admissionError = admitViewportOperation(
          activeTab,
          request.targetGeneration,
          request.operationGeneration,
        );
        if (admissionError) {
          return {
            ok: false,
            error: admissionError,
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
        if (!s.viewportAppliedByTarget.has(key)) {
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

  ipcMain.handle("preview:design.reset-viewport", (event, payload: unknown) => {
    const parsedPayload = BrowserAutomationViewportResetRequestSchema().safeParse(payload);
    if (!parsedPayload.success) {
      return BrowserAutomationViewportResetResultSchema().parse({
        ok: false,
        error: "invalid-viewport-reset-request",
      });
    }
    return BrowserAutomationViewportResetResultSchema().parse((() => {
      const request = parsedPayload.data;
      const metadata: ViewportOperationMetadata = request;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { ok: false, error: "no-window", ...viewportMetadata(metadata, null) };
      }
      const s = getSession(win);
      const activeThreadId = s.lastPreviewThreadId;
      const activeTab = activeThreadId ? getActiveTab(s, activeThreadId) : null;
      const activeTabId = activeTab?.id ?? null;
      const key = viewportTargetKey(request.threadId, request.tabId);
      const appliedBefore = currentViewportSize(s, key);
      if (request.threadId !== activeThreadId || request.tabId !== activeTabId) {
        return { ok: false, error: "stale-target", ...viewportMetadata(metadata, appliedBefore) };
      }
      const admissionError = admitViewportOperation(
        activeTab,
        request.targetGeneration,
        request.operationGeneration,
      );
      if (admissionError) {
        return {
          ok: false,
          error: admissionError,
          ...viewportMetadata(metadata, appliedBefore),
        };
      }
      if (!s.view || s.view.webContents.isDestroyed()) {
        return { ok: false, error: "no-view", ...viewportMetadata(metadata, appliedBefore) };
      }
      if (!s.lastBounds) {
        return { ok: false, error: "no-bounds", ...viewportMetadata(metadata, appliedBefore) };
      }
      s.viewportAppliedByTarget.delete(key);
      s.viewportPresentationByTarget.delete(key);
      applyViewportPresentation(s, s.lastBounds, activeThreadId, activeTabId);
      return { ok: true, ...viewportMetadata(metadata, null) };
    })());
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
