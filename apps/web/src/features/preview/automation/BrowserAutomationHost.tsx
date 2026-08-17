import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationRequestSchema,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationHostDispatchTarget,
  type BrowserAutomationErrorCode,
  type BrowserAutomationOperation,
  type BrowserAutomationResponse,
  type BrowserAutomationRequest,
  type BrowserAutomationTargetIdentity,
} from "@mcode/contracts";
import { getTransport, pushEmitter } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  browserAutomationRequestKey,
  browserAutomationScopeKey,
  browserAutomationTargetKey,
  invalidateBrowserAutomationTargetObservation,
  onBrowserAutomationObservationInvalidation,
  onBrowserAutomationInterruption,
  onBrowserAutomationScopeRelease,
  resolveBrowserAutomationControllerTarget,
  useBrowserAutomationStore,
} from "./browserAutomationStore";
import { useDiffStore } from "@/stores/diffStore";
import { previewTabsScopeKey, usePreviewTabsStore } from "@/features/preview/state/previewTabsStore";
import { isEmptyPreviewTabUrl } from "@/features/preview/navigation/open-url-in-preview";
import { BrowserAutomationRecorder } from "./browserAutomationRecorder";
import {
  resolveSameOriginFrame,
} from "./webBrowserInteractionExecutor";
import { PreviewPanel, WEB_RUNTIME_PREVIEW_TAB_ID } from "../surfaces/PreviewPanel";
import { browserSurfacePresentationCoordinator } from "../surfaces/BrowserSurfaceHostRoot";
import type { PreviewAutomationBridge } from "@/transport/desktop-bridge";
import {
  isBrowserAutomationWebRuntimeEnabled,
  normalizeWebPreviewUrl,
} from "./browserAutomationRuntime";
import { executeWebBrowserDispatch } from "./browserAutomationWebExecutor";
import { captureVisibleWebLocation, sanitizeWebLocation } from "./web-browser-automation/capture";
import {
  BrowserSessionDriver,
  ElectronBrowserSessionAdapter,
  getBrowserAutomationRuntimeActOperations,
  getBrowserAutomationRuntimeOperations,
} from "./services/browserSessionDriver";
import { WebBrowserSessionAdapter } from "./services/webBrowserSessionAdapter";
import {
  type ViewportApplyResult,
} from "./services/viewportCoordinator";
import {
  getOrCreateViewportCoordinator,
  waitForViewportLayout,
} from "./services/viewportCoordinatorFactory";

const HEARTBEAT_INTERVAL_MS = 10_000;
const TARGET_DISCOVERY_RETRY_MS = 50;
const TARGET_DISCOVERY_MAX_ATTEMPTS = 40;
const WEB_AUTOMATION_UNAVAILABLE_REASON = "Web automation executor is unavailable";
const viewportCoordinatorDispatches = new WeakMap<object, BrowserAutomationHostDispatch>();

export { isBrowserAutomationWebRuntimeEnabled } from "./browserAutomationRuntime";

function requestRemovesBrowserTarget(dispatch: BrowserAutomationHostDispatch): boolean {
  return dispatch.request.operation === "tabs" &&
    (dispatch.request.args.action === "close" || dispatch.request.args.action === "finalize");
}

function escapeWebSelector(value: string): string {
  const escape = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS?.escape;
  return escape ? escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function webIframeSelector(workspaceId: string, threadId: string, tabId: string): string {
  return `iframe[data-workspace-id="${escapeWebSelector(workspaceId)}"][data-scope-kind="thread"][data-scope-id="${escapeWebSelector(threadId)}"][data-tab-id="${escapeWebSelector(tabId)}"]`;
}

function webTargetIdentity(
  worktreeIdentity: string,
  connectionId: string,
  target: { workspaceId: string; threadId: string; tabId: string; revision: number },
): BrowserAutomationTargetIdentity {
  return {
    worktreeIdentity,
    connectionId,
    workspaceId: target.workspaceId,
    threadId: target.threadId,
    tabId: target.tabId,
    generation: Math.max(1, target.revision),
  };
}

function recordingAvailable(): boolean {
  const mediaRecorder = globalThis.MediaRecorder;
  return typeof mediaRecorder === "function" &&
    (typeof mediaRecorder.isTypeSupported !== "function" || mediaRecorder.isTypeSupported("video/webm")) &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
}

function failureResponse(
  request: BrowserAutomationRequest,
  code: BrowserAutomationErrorCode,
  message: string,
  appliedViewport?: { readonly width: number; readonly height: number },
): BrowserAutomationResponse {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: false,
    error: {
      code,
      message,
      retryable: code !== "INVALID_REQUEST",
      ...(appliedViewport ? { appliedViewport } : {}),
      stage: code === "TAB_UNAVAILABLE" ? "allocation" : "effect",
      effect: code === "TAB_UNAVAILABLE" ? "unknown" : "none",
      recovery: code === "TAB_UNAVAILABLE" ? "reopen" : "manual",
      correlationId: globalThis.crypto.randomUUID(),
    },
  };
}

function viewportFailureCode(status: ViewportApplyResult["status"]): BrowserAutomationErrorCode {
  if (status === "stale") return "STALE_TARGET_GENERATION";
  if (status === "superseded") return "OPERATION_CANCELLED";
  return "INTERNAL_ERROR";
}

function resizeResponse(
  dispatch: BrowserAutomationHostDispatch,
  result: ViewportApplyResult,
): BrowserAutomationResponse {
  if (result.status !== "applied" && result.status !== "clamped") {
    return failureResponse(
      dispatch.request,
      viewportFailureCode(result.status),
      result.error ?? `Browser viewport resize ${result.status}`,
      result.applied,
    );
  }
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: dispatch.request.requestId,
    sequence: dispatch.request.sequence,
    ok: true,
    result: {
      operation: "resize",
      width: result.applied.width,
      height: result.applied.height,
      controlEpoch: dispatch.request.expectedControlEpoch,
    },
  };
}

async function restoreCompletedAgentViewport(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
): Promise<BrowserAutomationResponse> {
  if (dispatch.request.operation !== "act" || !response.ok) return response;
  const coordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(
    browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
  );
  if (!coordinator?.snapshot().agentActive) return response;
  const result = await coordinator.completeAgent({
    targetGeneration: dispatch.target.targetGeneration,
  });
  useBrowserAutomationStore.getState().setViewportState(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    dispatch.target.tabId,
    coordinator.snapshot(),
    coordinator,
  );
  if (result && result.status !== "applied" && result.status !== "clamped") {
    return failureResponse(
      dispatch.request,
      viewportFailureCode(result.status),
      result.error ?? `Browser viewport restore ${result.status}`,
      result.applied,
    );
  }
  return response;
}

async function completeViewportControlRun(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
): Promise<BrowserAutomationResponse> {
  if (!response.ok) return response;
  const isCompletedAct = dispatch.request.operation === "act" &&
    response.result.operation === "act" && response.result.outcome === "completed";
  if (!isCompletedAct) return response;
  return restoreCompletedAgentViewport(dispatch, response);
}

function interruptViewportCoordinator(dispatch: BrowserAutomationHostDispatch): void {
  const coordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(
    browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
  );
  if (!coordinator) return;
  coordinator.interrupt();
  useBrowserAutomationStore.getState().setViewportState(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    dispatch.target.tabId,
    coordinator.snapshot(),
    coordinator,
  );
}

function ensureViewportCoordinator(
  dispatch: BrowserAutomationHostDispatch,
): ReturnType<typeof getOrCreateViewportCoordinator> {
  const key = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
  const state = useBrowserAutomationStore.getState();
  const existing = state.viewportCoordinators.get(key);
  let coordinator = existing;
  coordinator = getOrCreateViewportCoordinator({
    existing,
    target: dispatch.target,
    initial: state.viewportStateByTarget.get(key)?.confirmed ?? state.viewportByTarget.get(key),
    mode: state.viewportStateByTarget.get(key)?.mode,
    presentation: state.viewportStateByTarget.get(key)?.presentation,
    targetGeneration: dispatch.target.targetGeneration,
    surface: {
      setViewport: (size, operation, coordinator) => useBrowserAutomationStore.getState().applyViewportIfCurrent(
        dispatch.scope.workspaceId,
        dispatch.target.threadId,
        dispatch.target.tabId,
        coordinator,
        operation.targetGeneration,
        size,
      ),
      resetViewport: (operation, coordinator) => useBrowserAutomationStore.getState().resetViewportIfCurrent(
        dispatch.scope.workspaceId,
        dispatch.target.threadId,
        dispatch.target.tabId,
        coordinator,
        operation.targetGeneration,
      ),
      readViewport: () => useBrowserAutomationStore.getState().viewportByTarget.get(key) ?? null,
      waitForLayout: () => waitForViewportLayout(2),
      isCurrent: (operation, coordinator) => {
        const current = useBrowserAutomationStore.getState();
        return current.viewportCoordinators.get(key) === coordinator &&
          current.liveTargets.get(key)?.revision === operation.targetGeneration;
      },
    },
    readConfirmed: () => useBrowserAutomationStore.getState().viewportStateByTarget.get(key)?.confirmed ??
      useBrowserAutomationStore.getState().viewportByTarget.get(key) ?? null,
    operationId: (_operation, sequence) => {
      const currentDispatch = viewportCoordinatorDispatches.get(coordinator!) ?? dispatch;
      return browserAutomationRequestKey(
        currentDispatch.request.requestId,
        currentDispatch.request.sequence + sequence,
      );
    },
    onStateChange: (nextState, coordinator) => useBrowserAutomationStore.getState().setViewportState(
      dispatch.scope.workspaceId,
      dispatch.target.threadId,
      dispatch.target.tabId,
      nextState,
      coordinator,
    ),
    onCreated: (created) => useBrowserAutomationStore.getState().setViewportCoordinator(
      dispatch.scope.workspaceId,
      dispatch.target.threadId,
      dispatch.target.tabId,
      created,
    ),
  });
  viewportCoordinatorDispatches.set(coordinator, dispatch);
  return coordinator;
}

function bindViewportCoordinatorDispatch(dispatch: BrowserAutomationHostDispatch): void {
  const coordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(
    browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
  );
  if (coordinator) viewportCoordinatorDispatches.set(coordinator, dispatch);
}

function projectAgentControl(dispatch: BrowserAutomationHostDispatch): void {
  if (
    window.desktopBridge?.preview?.automation ||
    dispatch.request.operation === "status" ||
    !useThreadStore.getState().runningThreadIds.has(dispatch.target.threadId)
  ) return;
  useBrowserAutomationStore.getState().setControllerForTarget(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    dispatch.target.tabId,
    {
      tabId: dispatch.target.tabId,
      controller: "agent",
      controlEpoch: dispatch.request.expectedControlEpoch,
      providerSessionId: dispatch.request.providerSessionId,
      ...(dispatch.request.operation !== "inspect" &&
      dispatch.request.operation !== "act" &&
      dispatch.request.operation !== "tabs"
        ? {
            operation: dispatch.request.operation,
          }
        : {}),
    },
  );
}

function mountedWebIframe(dispatch: BrowserAutomationHostDispatch): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(webIframeSelector(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    dispatch.target.tabId,
  ));
}

async function executeBrowserDispatch(
  bridge: PreviewAutomationBridge | undefined,
  recorder: BrowserAutomationRecorder,
  dispatch: BrowserAutomationHostDispatch,
  signal: AbortSignal,
  runtimeOperations?: readonly BrowserAutomationOperation[],
): Promise<BrowserAutomationResponse> {
  bindViewportCoordinatorDispatch(dispatch);
  const operations = runtimeOperations ?? getBrowserAutomationRuntimeOperations(
    bridge ? "electron" : "web",
    { recordingAvailable: bridge ? recordingAvailable() : false },
  );
  if (!bridge) {
    if (dispatch.request.operation === "resize") {
      const coordinator = ensureViewportCoordinator(dispatch);
      const result = await coordinator.requestAgentResize(
        dispatch.request.args,
        {
          operationId: browserAutomationRequestKey(
            dispatch.request.requestId,
            dispatch.request.sequence,
          ),
          targetGeneration: dispatch.target.targetGeneration,
        },
      );
      useBrowserAutomationStore.getState().setViewportState(
        dispatch.scope.workspaceId,
        dispatch.target.threadId,
        dispatch.target.tabId,
        coordinator.snapshot(),
        coordinator,
      );
      return resizeResponse(dispatch, result);
    }
    const response = await executeWebBrowserDispatch(dispatch, signal);
    if (dispatch.request.operation !== "status" || !response.ok || response.result.operation !== "status") return response;
    const iframe = mountedWebIframe(dispatch);
    if (iframe) {
      try {
        const frameUrl = iframe.src ? new URL(iframe.src, window.location.href) : null;
        if (frameUrl && frameUrl.origin !== window.location.origin) {
          return failureResponse(dispatch.request, "CROSS_ORIGIN", "Visible preview is cross-origin");
        }
      } catch {
        return failureResponse(dispatch.request, "CROSS_ORIGIN", "Visible preview is cross-origin");
      }
      const location = captureVisibleWebLocation(iframe);
      if (!location.ok) return failureResponse(dispatch.request, location.code, "Visible preview is cross-origin");
      return { ...response, result: { ...response.result, url: location.value, capabilities: [...operations] } };
    }
    return { ...response, result: { ...response.result, url: sanitizeWebLocation(response.result.url), capabilities: [...operations] } };
  }
  const rendererOwned = dispatch.request.operation === "resize" ||
    dispatch.request.operation === "recordingStart" ||
    dispatch.request.operation === "recordingStop";
  if (rendererOwned) {
    const lease = await bridge.beginRendererOperation(dispatch);
    if (!lease.ok) return lease.response;
    let response: BrowserAutomationResponse;
    try {
      if (dispatch.request.operation === "resize") {
        const coordinator = ensureViewportCoordinator(dispatch);
        const result = await coordinator.requestAgentResize(
          dispatch.request.args,
          {
            operationId: browserAutomationRequestKey(
              dispatch.request.requestId,
              dispatch.request.sequence,
            ),
            targetGeneration: dispatch.target.targetGeneration,
          },
        );
        useBrowserAutomationStore.getState().setViewportState(
          dispatch.scope.workspaceId,
          dispatch.target.threadId,
          dispatch.target.tabId,
          coordinator.snapshot(),
          coordinator,
        );
        response = resizeResponse(dispatch, result);
      } else if (dispatch.request.operation === "recordingStart") {
        response = await recorder.start(dispatch, bridge);
      } else {
        response = await recorder.stop(dispatch);
      }
    } catch (cause) {
      response = failureResponse(
        dispatch.request,
        "INTERNAL_ERROR",
        cause instanceof Error ? cause.message : "Renderer browser operation failed",
      );
    }
    await bridge.finishRendererOperation({ leaseId: lease.leaseId, succeeded: response.ok });
    return response;
  }
  const response = await bridge.execute(dispatch);
  if (dispatch.request.operation !== "status" || !response.ok || response.result.operation !== "status") {
    return response;
  }
  return {
    ...response,
    result: {
      ...response.result,
      capabilities: [...operations],
    },
  };
}

/** Prioritize the active and live-target workspaces within the registration bound. */
export function selectBrowserAutomationWorkspaceIds(
  availableWorkspaceIds: readonly string[],
  activeWorkspaceId: string | null,
  targets: Iterable<{ readonly workspaceId: string; readonly lastUsedAt: number }>,
): string[] {
  const available = new Set(availableWorkspaceIds);
  const selected = new Set<string>();
  if (activeWorkspaceId && available.has(activeWorkspaceId)) selected.add(activeWorkspaceId);
  for (const target of [...targets].sort((left, right) => right.lastUsedAt - left.lastUsedAt)) {
    if (selected.size >= 32) break;
    if (available.has(target.workspaceId)) selected.add(target.workspaceId);
  }
  for (const workspaceId of availableWorkspaceIds) {
    if (selected.size >= 32) break;
    selected.add(workspaceId);
  }
  return [...selected];
}

function hostId(): string | null {
  if (!globalThis.crypto?.randomUUID) return null;
  const storageKey = "mcode.browserAutomation.hostId";
  const existing = sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const created = globalThis.crypto.randomUUID();
  sessionStorage.setItem(storageKey, created);
  return created;
}

function waitForLiveTarget(
  workspaceId: string,
  threadId: string,
  tabId: string,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
  if (signal.aborted) return Promise.reject(signal.reason);
  if (useBrowserAutomationStore.getState().liveTargets.has(key)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout);
      unsubscribe();
      reject(signal.reason);
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      reject(new Error("Browser target did not attach before the request deadline"));
    }, Math.max(1, Math.min(60_000, deadline - Date.now())));
    const unsubscribe = useBrowserAutomationStore.subscribe((state) => {
      if (!state.liveTargets.has(key)) return;
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDesktopTarget(
  bridge: PreviewAutomationBridge,
  threadId: string,
  tabId: string,
  deadline: number,
  signal: AbortSignal,
): Promise<Extract<Awaited<ReturnType<PreviewAutomationBridge["describeTarget"]>>, { ok: true }>["target"]> {
  while (true) {
    if (signal.aborted) throw signal.reason;
    const described = await bridge.describeTarget({ threadId, tabId });
    if (described.ok) return described.target;
    if (described.error !== "TAB_UNAVAILABLE") throw new Error("Browser target could not be described");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Browser target could not be described before the request deadline");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, Math.min(TARGET_DISCOVERY_RETRY_MS, remaining));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function webPreviewIframe(
  workspaceId: string,
  threadId: string,
  tabId: string,
  expectedUrl: string,
): HTMLIFrameElement | null {
  const selector = webIframeSelector(workspaceId, threadId, tabId);
  const iframe = document.querySelector<HTMLIFrameElement>(selector);
  if (!iframe || normalizeWebPreviewUrl(iframe.src) !== expectedUrl) return null;
  return resolveSameOriginFrame(iframe) ? iframe : null;
}

function isSameOriginWebPreviewUrl(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function waitForWebPreviewIframe(
  workspaceId: string,
  threadId: string,
  tabId: string,
  expectedUrl: string,
  deadline: number,
  signal: AbortSignal,
  onNavigationLoad?: (iframe: HTMLIFrameElement) => void,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const ready = webPreviewIframe(workspaceId, threadId, tabId, expectedUrl);
  if (ready?.contentDocument?.readyState === "complete" && !onNavigationLoad) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let observedIframe: HTMLIFrameElement | null = null;
    let onLoad: (() => void) | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const observeReady = () => {
      const iframe = webPreviewIframe(workspaceId, threadId, tabId, expectedUrl);
      if (!iframe) return;
      if (iframe.contentDocument?.readyState === "complete" && !onNavigationLoad) {
        finish();
        return;
      }
      if (observedIframe === iframe) return;
      if (observedIframe && onLoad) observedIframe.removeEventListener("load", onLoad);
      observedIframe = iframe;
      onLoad = () => {
        onNavigationLoad?.(iframe);
        finish();
      };
      iframe.addEventListener("load", onLoad, { once: true });
    };
    const observer = new MutationObserver(() => {
      observeReady();
    });
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Web Preview iframe did not attach before the request deadline"));
    }, Math.max(1, Math.min(60_000, deadline - Date.now())));
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (observedIframe && onLoad) observedIframe.removeEventListener("load", onLoad);
      observer.disconnect();
    };
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "data-workspace-id", "data-scope-kind", "data-scope-id", "data-tab-id", "class", "style", "hidden", "aria-hidden"],
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    observeReady();
  });
}

interface HostLease {
  readonly hostId: string;
  readonly generation: number;
  readonly desktopInstanceId: string;
  readonly epoch: number;
}

interface WebNavigationExpectation {
  readonly targetKey: string;
  readonly expectedUrl: string;
  readonly initialRevision: number;
  loadObserved: boolean;
  acceptedRevision?: number;
}

function acceptExpectedWebNavigationRevision(
  dispatch: BrowserAutomationHostDispatch,
  navigation: WebNavigationExpectation | undefined,
  target: { readonly revision: number } | undefined,
): number | undefined {
  if (!navigation || (dispatch.request.operation !== "open" && dispatch.request.operation !== "navigate")) return undefined;
  if (!navigation.loadObserved) return undefined;
  if (navigation.acceptedRevision !== undefined) {
    return navigation.acceptedRevision === target?.revision ? navigation.acceptedRevision : undefined;
  }
  const expectedUrl = normalizeWebPreviewUrl(dispatch.request.args.url ?? "");
  if (
    navigation.targetKey !== browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId) ||
    navigation.expectedUrl !== expectedUrl ||
    dispatch.target.targetGeneration !== navigation.initialRevision ||
    target?.revision !== navigation.initialRevision + 1 ||
    !webPreviewIframe(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId, navigation.expectedUrl)
  ) return undefined;
  navigation.acceptedRevision = target.revision;
  return target.revision;
}

interface BackgroundBrowserScope {
  readonly threadId: string;
  readonly workspaceId: string;
}

interface PersistentAutomationWebTab {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly url: string;
}

interface PersistentSurfaceLayout {
  readonly visible: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface AutomationTargetRef {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
}

function PersistentAutomationPreviewSurface({
  scope,
}: {
  readonly scope: BackgroundBrowserScope;
}) {
  const [layout, setLayout] = useState<PersistentSurfaceLayout>({
    visible: false,
    left: -20_000,
    top: 0,
    width: 1_280,
    height: 720,
  });

  useEffect(() => {
    const update = () => {
      const rect = browserSurfacePresentationCoordinator.getAutomationAnchorRect(
        scope.workspaceId,
        scope.threadId,
      );
      const next: PersistentSurfaceLayout = rect
        ? {
            visible: true,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }
        : {
            visible: false,
            left: -20_000,
            top: 0,
            width: 1_280,
            height: 720,
          };
      setLayout((current) => (
        current.visible === next.visible && current.left === next.left && current.top === next.top &&
        current.width === next.width && current.height === next.height ? current : next
      ));
    };
    const unsubscribe = browserSurfacePresentationCoordinator.subscribe(update);
    window.addEventListener("resize", update);
    update();
    return () => {
      unsubscribe();
      window.removeEventListener("resize", update);
    };
  }, [scope.threadId, scope.workspaceId]);

  return (
    <div
      data-automation-persistent-scope={scope.threadId}
      data-automation-persistent-workspace={scope.workspaceId}
      aria-hidden={!layout.visible}
      inert={!layout.visible ? true : undefined}
      style={{
        position: "fixed",
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        overflow: "hidden",
        zIndex: layout.visible ? 30 : -1,
        pointerEvents: layout.visible ? "auto" : "none",
      }}
    >
      <PreviewPanel
        threadId={scope.threadId}
        workspaceId={scope.workspaceId}
        automationOnly={!layout.visible}
      />
    </div>
  );
}

/**
 * Connects visible Browser tabs to the server broker, preserving the Electron
 * bridge when present and exposing the explicitly enabled web runtime seam.
 */
export function BrowserAutomationHost() {
  const connectionStatus = useConnectionStore((state) => state.status);
  const runningThreadIds = useThreadStore((state) => state.runningThreadIds);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const liveTargets = useBrowserAutomationStore((state) => state.liveTargets);
  const registered = useBrowserAutomationStore((state) => state.registered);
  const leaseRef = useRef<HostLease | null>(null);
  const shutdownLeaseRef = useRef<HostLease | null>(null);
  const executorDescriptor = useMemo(() => {
    const runtime = window.desktopBridge?.preview?.automation ? "electron" as const : "web" as const;
    return {
      runtime,
      operations: [...getBrowserAutomationRuntimeOperations(runtime, {
        recordingAvailable: runtime === "electron" ? recordingAvailable() : false,
      })],
      constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
      capabilityRevision: 1,
    };
  }, []);
  const recorderRef = useRef(new BrowserAutomationRecorder());
  const registrationEpochRef = useRef(0);
  const inFlightRef = useRef(new Map<string, BrowserAutomationHostDispatch>());
  const requestAbortRef = useRef(new Map<string, AbortController>());
  const webAbortRef = useRef(new Map<string, AbortController>());
  const webObserverRef = useRef(new Map<string, () => void>());
  const webNavigationRef = useRef(new Map<string, WebNavigationExpectation>());
  const bootstrapPendingRef = useRef(new Set<string>());
  const bootstrapAbortRef = useRef(new Map<string, AbortController>());
  const bootstrapRequestRef = useRef(new Map<string, BrowserAutomationRequest>());
  const priorLiveTargetKeysRef = useRef(new Set<string>());
  const priorLiveTargetRevisionsRef = useRef(new Map<string, number>());
  const cancelledRef = useRef(new Set<string>());
  const persistentWebTabsRef = useRef(new Map<string, PersistentAutomationWebTab>());
  const agentOpenTabsRef = useRef(new Map<string, AutomationTargetRef>());
  const [, setPersistentWebTabsRevision] = useState(0);
  const listLifecycleTargets = async (
    dispatch: BrowserAutomationHostDispatch,
  ): Promise<readonly BrowserAutomationHostDispatchTarget[]> => {
    const lease = leaseRef.current;
    if (!lease) return [];
    const candidates = [...useBrowserAutomationStore.getState().liveTargets.values()]
      .filter((target) => target.workspaceId === dispatch.request.workspaceId && target.threadId === dispatch.request.threadId);
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge) {
      return candidates.map((target) => ({
        desktopInstanceId: lease.desktopInstanceId,
        windowId: 1,
        connectionGeneration: lease.generation,
        threadId: target.threadId,
        tabId: target.tabId,
        targetGeneration: Math.max(1, target.revision),
        active: false,
        focused: false,
        lastUsedAt: target.lastUsedAt,
      }));
    }
    const described = await Promise.all(candidates.map((target) => bridge.describeTarget({
      threadId: target.threadId,
      tabId: target.tabId,
    })));
    return described.flatMap((result) => result.ok ? [{
      ...result.target,
      desktopInstanceId: lease.desktopInstanceId,
      connectionGeneration: lease.generation,
    }] : []);
  };
  const sessionDriverRef = useRef<BrowserSessionDriver | null>(null);
  if (!sessionDriverRef.current) {
    const webAdapter = new WebBrowserSessionAdapter({
      resolveDocument: (dispatch) => {
        const selector = webIframeSelector(
          dispatch.scope.workspaceId,
          dispatch.target.threadId,
          dispatch.target.tabId,
        );
        for (const iframe of document.querySelectorAll<HTMLIFrameElement>(selector)) {
          const resolved = resolveSameOriginFrame(iframe);
          if (resolved) return resolved.document;
        }
        return null;
      },
      resolveSignal: (dispatch, signal) => webAbortRef.current.get(browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence))?.signal ?? signal,
      getControlEpoch: (dispatch) => {
        const targetKey = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
        return useBrowserAutomationStore.getState().controllers.get(targetKey)?.controlEpoch ?? dispatch.request.expectedControlEpoch;
      },
      getTargetGeneration: (dispatch) => {
        const targetKey = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
        return useBrowserAutomationStore.getState().liveTargets.get(targetKey)?.revision ?? 0;
      },
      onHumanInput: (dispatch) => invalidateBrowserAutomationTargetObservation(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
      onObserver: (dispatch, dispose) => webObserverRef.current.set(browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence), dispose),
      executeNonInteraction: (dispatch, signal) => executeBrowserDispatch(undefined, recorderRef.current, dispatch, signal, executorDescriptor.operations),
    });
    sessionDriverRef.current = new BrowserSessionDriver({
      web: webAdapter,
      getCapabilityRevision: () => executorDescriptor.capabilityRevision,
      getHostRevision: () => leaseRef.current?.generation ?? 0,
      getDocumentRevision: (dispatch) => executorDescriptor.runtime === "web"
        ? useBrowserAutomationStore.getState().liveTargets.get(
          browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
        )?.revision ?? dispatch.target.targetGeneration
        : dispatch.target.targetGeneration,
      getControlRevision: (dispatch) => useBrowserAutomationStore.getState().controllers.get(
        browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
      )?.controlEpoch ?? dispatch.target.controller?.controlEpoch ?? dispatch.request.expectedControlEpoch,
      electron: new ElectronBrowserSessionAdapter(
        (dispatch, signal) => executeBrowserDispatch(window.desktopBridge?.preview?.automation, recorderRef.current, dispatch, signal, executorDescriptor.operations),
      ),
      supportedActOperations: getBrowserAutomationRuntimeActOperations(executorDescriptor.runtime),
      webTabs: {
        list: listLifecycleTargets,
        close: async (target, workspaceId) => {
          const matches = [...persistentWebTabsRef.current.values()].filter(
            (candidate) =>
              candidate.workspaceId === workspaceId &&
              candidate.threadId === target.threadId &&
              candidate.tabId === target.tabId,
          );
          if (matches.length !== 1) throw new Error("Browser target is unavailable");
          removePersistentWebTab(matches[0]!.workspaceId, target.threadId, target.tabId);
        },
      },
      electronTabs: {
        list: listLifecycleTargets,
        close: async (target, workspaceId) => {
          const matches = [...useBrowserAutomationStore.getState().liveTargets.values()]
            .filter((candidate) =>
              candidate.workspaceId === workspaceId &&
              candidate.threadId === target.threadId &&
              candidate.tabId === target.tabId,
            );
          if (matches.length !== 1) throw new Error("Browser target is unavailable");
          await usePreviewTabsStore.getState().closePage(matches[0]!.workspaceId, target.threadId, target.tabId);
        },
      },
      onLifecycleChange: (tabs) => useBrowserAutomationStore.getState().setLifecycleTabs(tabs),
    });
  }
  const addPersistentWebTab = (tab: PersistentAutomationWebTab): void => {
    persistentWebTabsRef.current.set(
      browserAutomationTargetKey(tab.workspaceId, tab.threadId, tab.tabId),
      tab,
    );
    usePreviewTabsStore.getState().upsertPersistentTab(tab.workspaceId, tab.threadId, {
      id: tab.tabId,
      threadId: tab.threadId,
      title: null,
      url: tab.url,
      faviconUrl: null,
      warm: true,
      active: false,
    });
    setPersistentWebTabsRevision((value) => value + 1);
  };
  const removePersistentWebTab = (workspaceId: string, threadId: string, tabId: string): void => {
    const targetKey = browserAutomationTargetKey(workspaceId, threadId, tabId);
    const tab = persistentWebTabsRef.current.get(targetKey);
    if (!tab) return;
    persistentWebTabsRef.current.delete(targetKey);
    for (const [key, value] of agentOpenTabsRef.current) {
      if (browserAutomationTargetKey(value.workspaceId, value.threadId, value.tabId) === targetKey) {
        agentOpenTabsRef.current.delete(key);
      }
    }
    usePreviewTabsStore.getState().removePersistentTab(tab.workspaceId, tab.threadId, tab.tabId);
    useBrowserAutomationStore.getState().unregisterTarget(tab.workspaceId, tab.threadId, tabId);
    setPersistentWebTabsRevision((value) => value + 1);
  };
  const stableHostId = useMemo(hostId, []);
  const [backgroundScopes, setBackgroundScopes] = useState<readonly BackgroundBrowserScope[]>([]);
  const backgroundScopesRef = useRef<readonly BackgroundBrowserScope[]>([]);
  const workspaceIds = useMemo(() => selectBrowserAutomationWorkspaceIds(
    [...new Set(workspaces.map((workspace) => workspace.id))],
    activeWorkspaceId,
    liveTargets.values(),
  ), [activeWorkspaceId, liveTargets, workspaces]);
  const workspaceSignature = JSON.stringify(workspaceIds);

  const cancelHostedRequest = useCallback((
    key: string,
    dispatch: BrowserAutomationHostDispatch,
    reason: "human-interrupted" | "user-stopped" | "host-shutdown",
    leaseOverride?: HostLease | null,
  ): void => {
    if (cancelledRef.current.has(key)) return;
    cancelledRef.current.add(key);
    const targetKey = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
    const viewportCoordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(targetKey);
    if (viewportCoordinator?.snapshot().agentActive || dispatch.request.operation === "resize") {
      interruptViewportCoordinator(dispatch);
    }
    webAbortRef.current.get(key)?.abort(new Error(`Browser operation was cancelled: ${reason}`));
    recorderRef.current.cancel(dispatch);
    void window.desktopBridge?.preview?.automation?.cancel(dispatch.request.requestId);
    const lease = leaseOverride ?? leaseRef.current;
    if (lease) {
      void getTransport().cancelBrowserAutomationRequest(
        lease.hostId,
        lease.generation,
        dispatch.request.requestId,
        dispatch.request.sequence,
        reason,
      ).catch(() => undefined);
    }
    useBrowserAutomationStore.getState().clearActiveRequest(
      dispatch.request.requestId,
      dispatch.request.sequence,
    );
  }, []);

  useEffect(() => {
    backgroundScopesRef.current = backgroundScopes;
    useBrowserAutomationStore.getState().setHostedScopeIds(
      new Set(backgroundScopes.map((scope) => browserAutomationScopeKey(scope.workspaceId, scope.threadId))),
    );
  }, [backgroundScopes]);

  useEffect(() => () => {
    useBrowserAutomationStore.getState().setHostedScopeIds(new Set());
  }, []);

  useEffect(() => {
    const desktopAutomation = window.desktopBridge?.preview?.automation;
    const webAutomationEnabled = isBrowserAutomationWebRuntimeEnabled();
    if (!desktopAutomation && !webAutomationEnabled) {
      useBrowserAutomationStore.getState().setStatus("disabled");
      useBrowserAutomationStore.getState().setRegistered(false);
      return;
    }
    if (!stableHostId) {
      useBrowserAutomationStore.getState().setStatus("unavailable");
      return;
    }
    if (connectionStatus !== "connected" || workspaceIds.length === 0) {
      leaseRef.current = null;
      useBrowserAutomationStore.getState().setRegistered(false);
      useBrowserAutomationStore.getState().setStatus("unavailable");
      return;
    }
    const epoch = ++registrationEpochRef.current;
    useBrowserAutomationStore.getState().setLifecycleTabs([]);
    const transport = getTransport();
    const liveTargetSnapshot = useBrowserAutomationStore.getState().liveTargets;
    const activeTarget = [...liveTargetSnapshot.values()].find((target) => target.workspaceId === activeWorkspaceId);
    const worktreeIdentity = import.meta.env.VITE_MCODE_WORKTREE_IDENTITY?.trim() || "web-runtime";
    void transport.registerBrowserAutomationHost({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      hostId: stableHostId,
      runtime: executorDescriptor.runtime,
      desktopInstanceId: "pending-desktop",
      worktreeIdentity: desktopAutomation ? "pending-worktree" : worktreeIdentity,
      workspaceIds,
      ...(activeTarget && !desktopAutomation && webAutomationEnabled ? {
        targetIdentity: webTargetIdentity(worktreeIdentity, "pending-desktop", activeTarget),
      } : {}),
      executorDescriptor,
      capabilities: executorDescriptor.operations.map((operation) => ({ operation, available: true })),
      maxPendingRequests: BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
      connectedAt: Date.now(),
    }).then((result) => {
      if (registrationEpochRef.current !== epoch) return;
      leaseRef.current = {
        hostId: stableHostId,
        generation: result.generation,
        desktopInstanceId: result.desktopInstanceId,
        epoch,
      };
      shutdownLeaseRef.current = leaseRef.current;
      useBrowserAutomationStore.getState().setRegistered(true);
      useBrowserAutomationStore.getState().setStatus("registered");
      sessionDriverRef.current?.publishLifecycleProjection();
    }).catch(() => {
      if (registrationEpochRef.current === epoch) {
        leaseRef.current = null;
        useBrowserAutomationStore.getState().setRegistered(false);
        useBrowserAutomationStore.getState().setStatus("unavailable");
      }
    });
    return () => {
      if (registrationEpochRef.current === epoch) {
        const previousLease = leaseRef.current;
        for (const [key, dispatch] of inFlightRef.current) {
          cancelHostedRequest(key, dispatch, "host-shutdown", previousLease);
        }
        for (const [key, request] of bootstrapRequestRef.current) {
          bootstrapAbortRef.current.get(key)?.abort(new Error("Browser host registration was replaced"));
          const lease = previousLease;
          if (lease) {
            void getTransport().cancelBrowserAutomationRequest(
              lease.hostId,
              lease.generation,
              request.requestId,
              request.sequence,
              "host-shutdown",
            ).catch(() => undefined);
          }
        }
        registrationEpochRef.current += 1;
        leaseRef.current = null;
        sessionDriverRef.current?.clearIdempotency();
        useBrowserAutomationStore.getState().setLifecycleTabs([]);
        agentOpenTabsRef.current.clear();
        useBrowserAutomationStore.getState().setRegistered(false);
        useBrowserAutomationStore.getState().setStatus("unavailable");
      }
    };
  }, [cancelHostedRequest, connectionStatus, stableHostId, workspaceSignature]);

  useEffect(() => {
    const lease = leaseRef.current;
    if (!lease || connectionStatus !== "connected") return;
    let cancelled = false;
    let retryTimer: number | null = null;
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge && !isBrowserAutomationWebRuntimeEnabled()) return;
    if (!bridge) {
      const workspace = useWorkspaceStore.getState();
      const targets = [...liveTargets.values()].slice(0, 64).map((candidate) => ({
        desktopInstanceId: lease.desktopInstanceId,
        windowId: 1,
        connectionGeneration: lease.generation,
        threadId: candidate.threadId,
        tabId: candidate.tabId,
        targetGeneration: Math.max(1, candidate.revision),
        active:
          candidate.workspaceId === workspace.activeWorkspaceId &&
          candidate.threadId === workspace.activeThreadId,
        focused:
          candidate.workspaceId === workspace.activeWorkspaceId &&
          candidate.threadId === workspace.activeThreadId,
        lastUsedAt: candidate.lastUsedAt,
        controller: useBrowserAutomationStore.getState().controllers.get(browserAutomationTargetKey(candidate.workspaceId, candidate.threadId, candidate.tabId)),
      } satisfies BrowserAutomationHostDispatchTarget));
      if (leaseRef.current === lease) {
        void getTransport().updateBrowserAutomationHostTargets(
          lease.hostId,
          lease.generation,
          targets,
        ).catch(() => undefined);
      }
      return;
    }
    const targets = [...liveTargets.values()].slice(0, 64);
    const publishTargets = async (attempt: number): Promise<void> => {
      const resolved = await Promise.all(targets.map(async (candidate) => {
        const described = await bridge.describeTarget({
          threadId: candidate.threadId,
          tabId: candidate.tabId,
        });
        if (!described.ok) return null;
        const controller = useBrowserAutomationStore.getState().controllers.get(browserAutomationTargetKey(candidate.workspaceId, candidate.threadId, candidate.tabId));
        return {
          ...described.target,
          desktopInstanceId: lease.desktopInstanceId,
          connectionGeneration: lease.generation,
          ...(controller ? { controller } : {}),
        } satisfies BrowserAutomationHostDispatchTarget;
      }));
      if (cancelled || leaseRef.current !== lease) return;
      await getTransport().updateBrowserAutomationHostTargets(
        lease.hostId,
        lease.generation,
        resolved.filter((target): target is BrowserAutomationHostDispatchTarget => target !== null),
      );
      if (resolved.some((target) => target === null) && attempt < TARGET_DISCOVERY_MAX_ATTEMPTS) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void publishTargets(attempt + 1).catch(() => undefined);
        }, TARGET_DISCOVERY_RETRY_MS);
      }
    };
    void publishTargets(1).catch(() => {
      // A replacement or release can race publication. Registry changes retry
      // with desktop-main identity as the source of truth.
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [cancelHostedRequest, connectionStatus, liveTargets, registered]);

  useEffect(() => {
    const next = new Set(liveTargets.keys());
    const priorRevisions = priorLiveTargetRevisionsRef.current;
    for (const [key, target] of liveTargets) {
      const previousRevision = priorRevisions.get(key);
      if (previousRevision === undefined || previousRevision === target.revision) continue;
      for (const [requestKey, dispatch] of inFlightRef.current) {
        if (browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId) !== key) continue;
        const navigation = webNavigationRef.current.get(requestKey);
        const expectedNavigation = acceptExpectedWebNavigationRevision(dispatch, navigation, target) !== undefined;
        if (expectedNavigation) {
          continue;
        }
        webAbortRef.current.get(requestKey)?.abort(new Error("Browser document was replaced"));
        requestAbortRef.current.get(requestKey)?.abort(new Error("Browser document was replaced"));
      }
    }
    for (const removed of priorLiveTargetKeysRef.current) {
      if (next.has(removed)) continue;
      const [workspaceId, threadId, tabId] = JSON.parse(removed) as [string, string, string];
      sessionDriverRef.current?.clearIdempotencyForTarget(workspaceId, threadId, tabId);
      for (const [openKey, mappedTarget] of agentOpenTabsRef.current) {
        if (
          browserAutomationTargetKey(
            mappedTarget.workspaceId,
            mappedTarget.threadId,
            mappedTarget.tabId,
          ) === removed
        ) agentOpenTabsRef.current.delete(openKey);
      }
      recorderRef.current.disposeTarget(workspaceId, threadId, tabId);
      for (const [key, dispatch] of inFlightRef.current) {
        if (dispatch.scope.workspaceId !== workspaceId || dispatch.target.threadId !== threadId || dispatch.target.tabId !== tabId) continue;
        if (requestRemovesBrowserTarget(dispatch)) continue;
        cancelHostedRequest(key, dispatch, "host-shutdown");
      }
    }
    priorLiveTargetKeysRef.current = next;
    priorLiveTargetRevisionsRef.current = new Map(
      [...liveTargets].map(([key, target]) => [key, target.revision]),
    );
  }, [cancelHostedRequest, liveTargets]);

  useEffect(() => {
    const lease = leaseRef.current;
    if (!lease || connectionStatus !== "connected") return;
    const heartbeat = (): void => {
      if (leaseRef.current !== lease) return;
      void getTransport()
        .heartbeatBrowserAutomationHost(lease.hostId, lease.generation, Date.now())
        .catch(() => undefined);
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connectionStatus, workspaceSignature, liveTargets.size, registered]);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.automation;
    const webAutomationEnabled = isBrowserAutomationWebRuntimeEnabled();
    if (!bridge && !webAutomationEnabled) return;
    const unsubscribeRequest = pushEmitter.on("browserAutomation.request", (input) => {
      const payload = input as { hostId?: unknown; generation?: unknown; dispatch?: unknown };
      const lease = leaseRef.current;
      const parsed = BrowserAutomationHostDispatchSchema().safeParse(payload.dispatch);
      if (
        !lease ||
        payload.hostId !== lease.hostId ||
        payload.generation !== lease.generation ||
        !parsed.success
      ) return;
      const dispatch = parsed.data;
      const key = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
      if (inFlightRef.current.has(key)) return;
      inFlightRef.current.set(key, dispatch);
      const store = useBrowserAutomationStore.getState();
      store.setActiveRequest({ dispatch, startedAt: Date.now() });
      projectAgentControl(dispatch);
      const controller = new AbortController();
      requestAbortRef.current.set(key, controller);
      const webDispatch = !bridge && webAutomationEnabled &&
        (dispatch.request.operation === "click" || dispatch.request.operation === "type");
      const webExecutorDispatch = !bridge && webAutomationEnabled;
      const webOpenRequest = !bridge && webAutomationEnabled &&
        dispatch.request.operation === "open" && Boolean(dispatch.request.args.url);
      const webNavigateRequest = !bridge && webAutomationEnabled &&
        dispatch.request.operation === "navigate" && Boolean(dispatch.request.args.url);
      const operationAbort = webDispatch ? new AbortController() : null;
      if (operationAbort) webAbortRef.current.set(key, operationAbort);
      const targetKey = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
      const liveTarget = useBrowserAutomationStore.getState().liveTargets.get(targetKey);
      const currentEpoch = useBrowserAutomationStore.getState().controllers.get(targetKey)?.controlEpoch ?? dispatch.request.expectedControlEpoch;
      const staleAtStart = !liveTarget || liveTarget.revision !== dispatch.target.targetGeneration || currentEpoch !== dispatch.request.expectedControlEpoch;
      if (webNavigateRequest) {
        const requestedUrl = normalizeWebPreviewUrl(dispatch.request.args.url ?? "");
        if (
          requestedUrl &&
          isSameOriginWebPreviewUrl(requestedUrl) &&
          liveTarget &&
          liveTarget.revision === dispatch.target.targetGeneration
        ) {
          const navigation: WebNavigationExpectation = {
            targetKey,
            expectedUrl: requestedUrl,
            initialRevision: liveTarget.revision,
            loadObserved: false,
          };
          webNavigationRef.current.set(key, navigation);
          const selector = webIframeSelector(
            dispatch.scope.workspaceId,
            dispatch.target.threadId,
            dispatch.target.tabId,
          );
          const iframe = document.querySelector<HTMLIFrameElement>(selector);
          if (iframe) {
            const onLoad = () => {
              if (normalizeWebPreviewUrl(iframe.src) === requestedUrl) navigation.loadObserved = true;
            };
            iframe.addEventListener("load", onLoad, { once: true });
            webObserverRef.current.set(key, () => iframe.removeEventListener("load", onLoad));
          }
        }
      }
      const executeWeb = async (): Promise<BrowserAutomationResponse> => {
        if (staleAtStart) {
          return failureResponse(dispatch.request, !liveTarget || liveTarget.revision !== dispatch.target.targetGeneration ? "STALE_TARGET_GENERATION" : "STALE_CONTROL_EPOCH", "Browser operation is stale");
        }
        if (!operationAbort) return failureResponse(dispatch.request, "TAB_UNAVAILABLE", "Browser target is unavailable");
        return sessionDriverRef.current!.execute(dispatch, controller.signal);
      };
      const executeWebOpen = async (): Promise<BrowserAutomationResponse> => {
        if (!webOpenRequest || dispatch.request.operation !== "open" || !dispatch.request.args.url) {
          return sessionDriverRef.current!.execute(dispatch, controller.signal);
        }
        const requestedUrl = normalizeWebPreviewUrl(dispatch.request.args.url);
        if (!requestedUrl || !isSameOriginWebPreviewUrl(requestedUrl)) {
          return sessionDriverRef.current!.execute(dispatch, controller.signal);
        }
        const currentTarget = useBrowserAutomationStore.getState().liveTargets.get(targetKey);
        if (!currentTarget || currentTarget.revision !== dispatch.target.targetGeneration) {
          return failureResponse(dispatch.request, "STALE_TARGET_GENERATION", "Browser operation is stale");
        }
        const currentIframe = webPreviewIframe(
          dispatch.scope.workspaceId,
          dispatch.target.threadId,
          dispatch.target.tabId,
          requestedUrl,
        );
        if (!currentIframe) {
          webNavigationRef.current.set(key, {
            targetKey,
            expectedUrl: requestedUrl,
            initialRevision: currentTarget.revision,
            loadObserved: false,
          });
        }
        if (!currentIframe) {
          useDiffStore.getState().setPreviewUrlForThread(dispatch.target.threadId, requestedUrl);
        }
        await waitForWebPreviewIframe(
          dispatch.scope.workspaceId,
          dispatch.target.threadId,
          dispatch.target.tabId,
          requestedUrl,
          dispatch.request.deadline,
          controller.signal,
          !currentIframe
          ? () => {
              const navigation = webNavigationRef.current.get(key);
              if (navigation?.targetKey === targetKey && navigation.expectedUrl === requestedUrl) {
                navigation.loadObserved = true;
              }
            }
            : undefined,
        );
        const latestStore = useBrowserAutomationStore.getState();
        const latestTarget = latestStore.liveTargets.get(targetKey);
        const navigation = webNavigationRef.current.get(key);
        const expectedRevision = navigation?.acceptedRevision ??
          acceptExpectedWebNavigationRevision(dispatch, navigation, latestTarget) ??
          dispatch.target.targetGeneration;
        if (!latestTarget || latestTarget.revision !== expectedRevision) {
          return failureResponse(dispatch.request, "STALE_TARGET_GENERATION", "Browser operation is stale");
        }
        const latestEpoch = latestStore.controllers.get(targetKey)?.controlEpoch ?? dispatch.request.expectedControlEpoch;
        if (latestEpoch !== dispatch.request.expectedControlEpoch) {
          return failureResponse(dispatch.request, "STALE_CONTROL_EPOCH", "Browser operation is stale");
        }
        const executionDispatch = {
          ...dispatch,
          request: {
            ...dispatch.request,
            args: { activate: dispatch.request.args.activate },
          },
        };
        return sessionDriverRef.current!.execute(executionDispatch, controller.signal);
      };
      const operation = webDispatch
        ? executeWeb()
        : webOpenRequest
          ? executeWebOpen()
        : bridge || webExecutorDispatch
          ? sessionDriverRef.current!.execute(dispatch, controller.signal)
          : Promise.resolve(failureResponse(dispatch.request, "UNSUPPORTED_OPERATION", WEB_AUTOMATION_UNAVAILABLE_REASON));
      const guardedOperation = operation.then((response) => {
        if (!bridge && webAutomationEnabled && (webDispatch || webOpenRequest || webNavigateRequest)) {
          const latestTarget = useBrowserAutomationStore.getState().liveTargets.get(targetKey);
          const navigation = webNavigationRef.current.get(key);
          const expectedRevision = navigation?.acceptedRevision ??
            acceptExpectedWebNavigationRevision(dispatch, navigation, latestTarget) ??
            dispatch.target.targetGeneration;
          if (!latestTarget || latestTarget.revision !== expectedRevision) {
            return failureResponse(dispatch.request, "STALE_TARGET_GENERATION", "Browser operation is stale");
          }
        }
        return response;
      }).catch((cause: unknown) => {
        if (!bridge && webAutomationEnabled && (webDispatch || webOpenRequest || webNavigateRequest)) {
          const latestTarget = useBrowserAutomationStore.getState().liveTargets.get(targetKey);
          const navigation = webNavigationRef.current.get(key);
          const expectedRevision = navigation?.acceptedRevision ??
            acceptExpectedWebNavigationRevision(dispatch, navigation, latestTarget) ??
            dispatch.target.targetGeneration;
          if (!latestTarget || latestTarget.revision !== expectedRevision) {
            return failureResponse(dispatch.request, "STALE_TARGET_GENERATION", "Browser operation is stale");
          }
        }
        throw cause;
      });
      void guardedOperation.then(async (response) => {
        if (leaseRef.current !== lease || cancelledRef.current.has(key)) return;
        const completedResponse = await completeViewportControlRun(dispatch, response);
        const responseTarget = sessionDriverRef.current!.responseTarget(dispatch, completedResponse);
          return webDispatch || webNavigateRequest || dispatch.request.operation === "tabs" || (!bridge && webAutomationEnabled && dispatch.request.operation === "screenshot")
            ? getTransport().respondToBrowserAutomationRequest(
              lease.hostId,
              lease.generation,
              completedResponse,
              responseTarget,
            )
            : getTransport().respondToBrowserAutomationRequest(
              lease.hostId,
              lease.generation,
              completedResponse,
            );
      }).catch(() => undefined).finally(() => {
        webObserverRef.current.get(key)?.();
        webObserverRef.current.delete(key);
        webAbortRef.current.delete(key);
        webNavigationRef.current.delete(key);
        if (inFlightRef.current.get(key) === dispatch) inFlightRef.current.delete(key);
        requestAbortRef.current.delete(key);
        cancelledRef.current.delete(key);
        useBrowserAutomationStore.getState().clearActiveRequest(
          dispatch.request.requestId,
          dispatch.request.sequence,
        );
      });
    });
    const unsubscribeCancel = pushEmitter.on("browserAutomation.cancel", (input) => {
      const payload = input as {
        hostId?: unknown;
        generation?: unknown;
        requestId?: unknown;
        sequence?: unknown;
      };
      const lease = leaseRef.current;
      if (
        !lease || payload.hostId !== lease.hostId || payload.generation !== lease.generation ||
        typeof payload.requestId !== "string" || typeof payload.sequence !== "number"
      ) return;
      const key = browserAutomationRequestKey(payload.requestId, payload.sequence);
      const bootstrapController = bootstrapAbortRef.current.get(key);
      if (bootstrapController) {
        bootstrapController.abort(new Error("Browser bootstrap was cancelled"));
      }
      if (!inFlightRef.current.has(key) || cancelledRef.current.has(key)) return;
      cancelledRef.current.add(key);
      interruptViewportCoordinator(inFlightRef.current.get(key)!);
      webAbortRef.current.get(key)?.abort(new Error("Browser operation was cancelled"));
      recorderRef.current.cancel(inFlightRef.current.get(key)!);
      requestAbortRef.current.get(key)?.abort(new Error("Browser operation was cancelled"));
      if (bridge) void bridge.cancel(payload.requestId);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeCancel();
    };
  }, [cancelHostedRequest]);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge && !isBrowserAutomationWebRuntimeEnabled()) return;
    return pushEmitter.on("browserAutomation.bootstrap", (input) => {
      const payload = input as { hostId?: unknown; generation?: unknown; request?: unknown };
      const lease = leaseRef.current;
      const parsed = BrowserAutomationRequestSchema().safeParse(payload.request);
      if (
        !lease || payload.hostId !== lease.hostId || payload.generation !== lease.generation ||
        !parsed.success || parsed.data.operation !== "open"
      ) return;
      const request = parsed.data;
      const agentOwnedOpen = request.args.idempotencyKey !== undefined;
      const key = browserAutomationRequestKey(request.requestId, request.sequence);
      if (inFlightRef.current.has(key) || bootstrapPendingRef.current.has(key)) return;
      bootstrapPendingRef.current.add(key);
      bootstrapRequestRef.current.set(key, request);
      const controller = new AbortController();
      bootstrapAbortRef.current.set(key, controller);
      const deadlineTimer = window.setTimeout(
        () => controller.abort(new Error("Browser bootstrap deadline elapsed")),
        Math.max(1, request.deadline - Date.now()),
      );
      const previousTabId = usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey(request.workspaceId, request.threadId)]?.activeTabId ?? null;
      const previousPanel = useDiffStore.getState().getRightPanel(request.workspaceId, request.threadId);
      let backgroundContextRestored = false;
      let createdTabId: string | null = null;
      let createdWebTabId: string | undefined;
      const agentOpenKey = agentOwnedOpen
        ? JSON.stringify([request.providerSessionId, request.providerInstanceId, request.workspaceId, request.threadId, request.args.idempotencyKey])
        : null;
      let bootstrapSucceeded = false;
      let visibleContextModified = false;
      const restoreBackgroundContext = async () => {
        if (agentOwnedOpen || request.args.activate || backgroundContextRestored) return;
        backgroundContextRestored = true;
        if (createdTabId && previousTabId && previousTabId !== createdTabId) {
          await usePreviewTabsStore.getState().activatePage(request.workspaceId, request.threadId, previousTabId);
        }
        if (!visibleContextModified) return;
        const currentDiff = useDiffStore.getState();
        if (!previousPanel.openTabs.includes("preview")) {
          currentDiff.closeRightPanelTab(request.workspaceId, request.threadId, "preview");
        }
        if (previousPanel.openTabs.includes(previousPanel.activeTab)) {
          currentDiff.setRightPanelTab(request.workspaceId, request.threadId, previousPanel.activeTab);
        }
        if (previousPanel.visible) currentDiff.showRightPanel(request.workspaceId, request.threadId);
        else currentDiff.hideRightPanel(request.workspaceId, request.threadId);
      };
      void (async () => {
        const ensureActive = () => {
          if (controller.signal.aborted) throw controller.signal.reason;
        };
        ensureActive();
        const workspace = useWorkspaceStore.getState();
        if (!workspace.workspaces.some((candidate) => candidate.id === request.workspaceId)) {
          throw new Error("Browser workspace is unavailable");
        }
        const ownsVisibleContext = workspace.activeWorkspaceId === request.workspaceId &&
          workspace.activeThreadId === request.threadId;
        const diff = useDiffStore.getState();
        const currentScopes = backgroundScopesRef.current;
        const existingScope = currentScopes.find(
          (scope) => scope.workspaceId === request.workspaceId && scope.threadId === request.threadId,
        );
        if (existingScope) {
          const nextScopes = [
            ...currentScopes.filter((scope) => scope !== existingScope),
            existingScope,
          ];
          backgroundScopesRef.current = nextScopes;
          setBackgroundScopes(nextScopes);
        } else {
          const isBusy = (scope: BackgroundBrowserScope): boolean =>
            [...bootstrapRequestRef.current.values()].some(
              (candidate) => candidate.workspaceId === scope.workspaceId && candidate.threadId === scope.threadId,
            ) || [...inFlightRef.current.values()].some(
              (candidate) => candidate.scope.workspaceId === scope.workspaceId && candidate.scope.threadId === scope.threadId,
            ) || recorderRef.current.hasActiveThread(scope.workspaceId, scope.threadId) ||
            browserSurfacePresentationCoordinator.hasAutomationAnchor(scope.workspaceId, scope.threadId);
          const evicted = currentScopes.length >= 5
            ? currentScopes.find((scope) => !isBusy(scope))
            : undefined;
          if (currentScopes.length >= 5 && !evicted) {
            throw new Error("Browser automation has reached its five-thread surface limit");
          }
          const nextScopes = [
            ...currentScopes.filter((scope) => scope !== evicted),
            { threadId: request.threadId, workspaceId: request.workspaceId },
          ];
          if (evicted) {
            for (const tab of persistentWebTabsRef.current.values()) {
              if (tab.workspaceId === evicted.workspaceId && tab.threadId === evicted.threadId) {
                removePersistentWebTab(tab.workspaceId, tab.threadId, tab.tabId);
              }
            }
          }
          backgroundScopesRef.current = nextScopes;
          useBrowserAutomationStore.getState().setHostedScopeIds(
             new Set(nextScopes.map((scope) => browserAutomationScopeKey(scope.workspaceId, scope.threadId))),
          );
          setBackgroundScopes(nextScopes);
        }
        if (ownsVisibleContext && !agentOwnedOpen) {
          visibleContextModified = true;
          diff.showRightPanel(request.workspaceId, request.threadId);
          diff.setRightPanelTab(request.workspaceId, request.threadId, "preview");
        }
        await waitForViewportLayout(2);
        const listed = await window.desktopBridge?.preview?.tabs.list?.(request.threadId, request.workspaceId);
        if (listed?.ok && listed.data.threadId === request.threadId) {
          usePreviewTabsStore.getState().setTabSet(request.workspaceId, request.threadId, listed.data);
        }
        const existingSet = usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey(request.workspaceId, request.threadId)];
        const requestedWebUrl = !bridge && request.args.url
          ? normalizeWebPreviewUrl(request.args.url)
          : undefined;
        let tabId = agentOwnedOpen
          ? (agentOpenKey
              ? agentOpenTabsRef.current.get(agentOpenKey)?.tabId ?? null
              : null)
          : existingSet?.activeTabId || existingSet?.tabs[0]?.id ||
            (!bridge ? WEB_RUNTIME_PREVIEW_TAB_ID : null);
        if (!bridge && agentOwnedOpen && !tabId) {
          const webTabId = `web-agent-${globalThis.crypto.randomUUID()}`;
          const webTabUrl = requestedWebUrl ?? `${window.location.origin}/browser-automation-fixture.html`;
          createdWebTabId = webTabId;
          if (agentOpenKey) {
            agentOpenTabsRef.current.set(agentOpenKey, {
              workspaceId: request.workspaceId,
              threadId: request.threadId,
              tabId: webTabId,
            });
          }
          addPersistentWebTab({
            threadId: request.threadId,
            workspaceId: request.workspaceId,
            tabId: webTabId,
            url: webTabUrl,
          });
          tabId = webTabId;
        }
        if (!tabId) {
          const onlyExistingTab = existingSet?.tabs.length === 1 ? existingSet.tabs[0] : undefined;
          const browserPanelWasVisible = previousPanel.visible &&
            previousPanel.openTabs.includes("preview");
          const existingTabId = agentOwnedOpen &&
              !browserPanelWasVisible &&
              onlyExistingTab &&
              isEmptyPreviewTabUrl(onlyExistingTab.url) &&
              !onlyExistingTab.title &&
              !onlyExistingTab.faviconUrl
            ? onlyExistingTab.id
            : undefined;
          tabId = await usePreviewTabsStore.getState().openPage(request.workspaceId, request.threadId, {
            activate: !agentOwnedOpen,
            focusOmnibox: ownsVisibleContext && request.args.activate && !agentOwnedOpen,
            ...(existingTabId ? { tabId: existingTabId } : {}),
          });
          if (!tabId && existingTabId) {
            tabId = await usePreviewTabsStore.getState().openPage(request.workspaceId, request.threadId, {
              activate: false,
              focusOmnibox: false,
            });
          }
          if (tabId) {
            createdTabId = tabId;
            if (agentOpenKey) {
              agentOpenTabsRef.current.set(agentOpenKey, {
                workspaceId: request.workspaceId,
                threadId: request.threadId,
                tabId,
              });
            }
          }
        }
        if (!tabId) throw new Error("Browser tab could not be created or restored");
        if (agentOwnedOpen) {
          useBrowserAutomationStore.getState().setPendingAgentOpen(
            request.requestId,
            request.sequence,
            {
              workspaceId: request.workspaceId,
              threadId: request.threadId,
              tabId,
              url: request.args.url ?? null,
              startedAt: Date.now(),
            },
          );
        }
        const selectedTab = existingSet?.tabs.find((tab) => tab.id === tabId);
        const initialUrl = requestedWebUrl ??
          (agentOwnedOpen ? request.args.url : undefined) ??
          selectedTab?.url ??
          "about:blank";
        if (!selectedTab?.url || requestedWebUrl || request.args.url) {
          usePreviewTabsStore.getState().updateTabChrome(request.workspaceId, request.threadId, tabId, {
            title: null,
            url: initialUrl,
            favicon: null,
          });
          if (!agentOwnedOpen) diff.setPreviewUrlForThread(request.threadId, initialUrl);
        }
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        if (!bridge && requestedWebUrl) {
          await waitForWebPreviewIframe(
            request.workspaceId,
            request.threadId,
            tabId,
            requestedWebUrl,
            request.deadline,
            controller.signal,
          );
          ensureActive();
        }
        await waitForLiveTarget(request.workspaceId, request.threadId, tabId, request.deadline, controller.signal);
        ensureActive();
        const described = bridge
          ? {
              ok: true as const,
              target: await waitForDesktopTarget(
                bridge,
                request.threadId,
                tabId,
                request.deadline,
                controller.signal,
              ),
            }
          : {
              ok: true as const,
              target: {
                windowId: 1,
                threadId: request.threadId,
                tabId,
                targetGeneration: useBrowserAutomationStore.getState().liveTargets.get(
                  browserAutomationTargetKey(request.workspaceId, request.threadId, tabId),
                )?.revision ?? 1,
                active: !agentOwnedOpen,
                focused: !agentOwnedOpen,
                lastUsedAt: Date.now(),
              },
            };
        ensureActive();
        const target: BrowserAutomationHostDispatchTarget = {
          ...described.target,
          desktopInstanceId: lease.desktopInstanceId,
          connectionGeneration: lease.generation,
        };
        const dispatch = BrowserAutomationHostDispatchSchema().parse({
          scope: {
            workspaceId: request.workspaceId,
            threadId: request.threadId,
            providerSessionId: request.providerSessionId,
            providerInstanceId: request.providerInstanceId,
          },
          connection: {
            desktopInstanceId: target.desktopInstanceId,
            windowId: target.windowId,
            connectionGeneration: target.connectionGeneration,
            targetGeneration: target.targetGeneration,
          },
          request,
          target,
        });
        inFlightRef.current.set(key, dispatch);
        requestAbortRef.current.set(key, controller);
        const executionDispatch = !bridge && requestedWebUrl
          ? {
              ...dispatch,
              request: {
                ...dispatch.request,
                args: {
                  activate: request.args.activate,
                  ...(request.args.idempotencyKey ? { idempotencyKey: request.args.idempotencyKey } : {}),
                },
              },
            }
          : dispatch;
        projectAgentControl(executionDispatch);
        const response = await sessionDriverRef.current!.execute(executionDispatch, controller.signal);
        await restoreBackgroundContext();
        if (leaseRef.current === lease && !cancelledRef.current.has(key)) {
          await getTransport().respondToBrowserAutomationRequest(
            lease.hostId,
            lease.generation,
            response,
            target,
          );
          bootstrapSucceeded = true;
        }
      })().catch((cause) => {
        if (leaseRef.current !== lease || controller.signal.aborted) return;
        void getTransport().respondToBrowserAutomationRequest(
          lease.hostId,
          lease.generation,
          failureResponse(request, "TAB_UNAVAILABLE", cause instanceof Error ? cause.message : "Browser open failed"),
        );
      }).finally(async () => {
        try {
          await restoreBackgroundContext();
        } catch {
          // Restoration failure must not skip closing a tab created for this bootstrap.
        }
        if (createdTabId && !bootstrapSucceeded) {
          try {
            await usePreviewTabsStore.getState().closePage(request.workspaceId, request.threadId, createdTabId);
          } catch {
            // Keep finalizer cleanup settled; closePage preserves logical records on physical failure.
          }
        }
        if (createdWebTabId && !bootstrapSucceeded) {
          removePersistentWebTab(request.workspaceId, request.threadId, createdWebTabId);
        }
        if (!bootstrapSucceeded && agentOpenKey) agentOpenTabsRef.current.delete(agentOpenKey);
        window.clearTimeout(deadlineTimer);
        if (bootstrapAbortRef.current.get(key) === controller) bootstrapAbortRef.current.delete(key);
        bootstrapPendingRef.current.delete(key);
        bootstrapRequestRef.current.delete(key);
        inFlightRef.current.delete(key);
        requestAbortRef.current.delete(key);
        cancelledRef.current.delete(key);
        useBrowserAutomationStore.getState().clearPendingAgentOpen(
          request.requestId,
          request.sequence,
        );
      });
    });
  }, []);

  useEffect(() => onBrowserAutomationObservationInvalidation((workspaceId, threadId, tabId) => {
    sessionDriverRef.current?.invalidateTargetObservations(workspaceId, threadId, tabId);
  }), []);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge) return;
    return bridge.onControllerChanged((controller) => {
      const store = useBrowserAutomationStore.getState();
      const target = resolveBrowserAutomationControllerTarget(
        store.liveTargets.values(),
        controller,
      );
      store.setController(controller);
      if (controller.controller !== "human") return;
      if (!target) return;
      recorderRef.current.disposeTarget(target.workspaceId, target.threadId, target.tabId);
      for (const dispatch of inFlightRef.current.values()) {
        if (dispatch.scope.workspaceId !== target.workspaceId || dispatch.target.threadId !== target.threadId || dispatch.target.tabId !== target.tabId) continue;
        const lease = leaseRef.current;
        if (!lease) continue;
        const key = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
        cancelHostedRequest(key, dispatch, "human-interrupted", lease);
      }
    });
  }, [cancelHostedRequest]);

  useEffect(() => {
    const store = useBrowserAutomationStore.getState();
    for (const [targetKey, controller] of store.controllers) {
      if (controller.controller !== "agent") continue;
      const target = store.liveTargets.get(targetKey);
      if (!target || runningThreadIds.has(target.threadId)) continue;
      if (!controller.providerSessionId) continue;
      const bridge = window.desktopBridge?.preview?.automation;
      if (bridge) {
        void bridge.releaseAgentControl({
          threadId: target.threadId,
          tabId: target.tabId,
          controlEpoch: controller.controlEpoch,
          providerSessionId: controller.providerSessionId,
        });
      } else {
        store.setControllerForTarget(target.workspaceId, target.threadId, target.tabId, {
          tabId: target.tabId,
          controller: "none",
          controlEpoch: controller.controlEpoch,
        });
      }
    }
  }, [runningThreadIds]);

  useEffect(() => onBrowserAutomationInterruption((workspaceId, threadId, tabId, reason) => {
    recorderRef.current.disposeTarget(workspaceId, threadId, tabId);
    for (const dispatch of inFlightRef.current.values()) {
      if (dispatch.scope.workspaceId !== workspaceId || dispatch.target.threadId !== threadId || dispatch.target.tabId !== tabId) continue;
      const lease = leaseRef.current;
      if (!lease) continue;
      const key = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
      cancelHostedRequest(key, dispatch, reason, lease);
    }
  }), [cancelHostedRequest]);

  useEffect(() => onBrowserAutomationScopeRelease((release) => {
    const matches = (threadId: string, workspaceId: string): boolean =>
      release.threadId !== undefined
        ? workspaceId === release.workspaceId && threadId === release.threadId
        : workspaceId === release.workspaceId;
    if (release.threadId !== undefined) void sessionDriverRef.current?.releaseThread(release.workspaceId, release.threadId);
    else void sessionDriverRef.current?.releaseWorkspace(release.workspaceId);
    const nextScopes = backgroundScopesRef.current.filter(
      (scope) => !matches(scope.threadId, scope.workspaceId),
    );
    if (nextScopes.length !== backgroundScopesRef.current.length) {
      backgroundScopesRef.current = nextScopes;
      setBackgroundScopes(nextScopes);
      useBrowserAutomationStore.getState().setHostedScopeIds(
        new Set(nextScopes.map((scope) => browserAutomationScopeKey(scope.workspaceId, scope.threadId))),
      );
    }
    for (const tab of persistentWebTabsRef.current.values()) {
      if (matches(tab.threadId, tab.workspaceId)) {
        removePersistentWebTab(tab.workspaceId, tab.threadId, tab.tabId);
      }
    }
    const lease = leaseRef.current;
    for (const [key, request] of bootstrapRequestRef.current) {
      if (!matches(request.threadId, request.workspaceId)) continue;
      bootstrapAbortRef.current.get(key)?.abort(new Error("Browser scope was released"));
      if (!inFlightRef.current.has(key)) cancelledRef.current.add(key);
      if (lease && !inFlightRef.current.has(key)) {
        void getTransport().cancelBrowserAutomationRequest(
          lease.hostId,
          lease.generation,
          request.requestId,
          request.sequence,
          "host-shutdown",
        ).catch(() => undefined);
      }
    }
    for (const [key, dispatch] of inFlightRef.current) {
      if (!matches(dispatch.scope.threadId, dispatch.scope.workspaceId)) continue;
      cancelHostedRequest(key, dispatch, "host-shutdown", lease);
    }
  }), [cancelHostedRequest]);

  useEffect(() => pushEmitter.on("browserAutomation.sessionRelease", (input) => {
    const payload = input as { hostId?: unknown; generation?: unknown; providerSessionId?: unknown };
    const lease = leaseRef.current;
    if (
      !lease || payload.hostId !== lease.hostId || payload.generation !== lease.generation ||
      typeof payload.providerSessionId !== "string"
    ) return;
    void sessionDriverRef.current?.releaseProviderSession(payload.providerSessionId);
  }), []);

  useEffect(() => () => {
    // Registration cleanup runs before this effect during unmount, so retain
    // the last authorized lease solely for bounded shutdown cancellation.
    const lease = shutdownLeaseRef.current;
    if (lease) {
      for (const [key, dispatch] of inFlightRef.current) {
        cancelHostedRequest(key, dispatch, "host-shutdown", lease);
      }
      for (const [key, request] of bootstrapRequestRef.current) {
        bootstrapAbortRef.current.get(key)?.abort(new Error("Browser host unmounted"));
        void getTransport().cancelBrowserAutomationRequest(
          lease.hostId,
          lease.generation,
          request.requestId,
          request.sequence,
          "host-shutdown",
        ).catch(() => undefined);
      }
    }
    bootstrapAbortRef.current.clear();
    bootstrapRequestRef.current.clear();
    bootstrapPendingRef.current.clear();
    inFlightRef.current.clear();
    cancelledRef.current.clear();
    webNavigationRef.current.clear();
    recorderRef.current.dispose();
    for (const abort of webAbortRef.current.values()) abort.abort(new Error("Browser host was replaced"));
    for (const dispose of webObserverRef.current.values()) dispose();
    webAbortRef.current.clear();
    webObserverRef.current.clear();
    for (const tab of persistentWebTabsRef.current.values()) {
      usePreviewTabsStore.getState().removePersistentTab(tab.workspaceId, tab.threadId, tab.tabId);
    }
    persistentWebTabsRef.current.clear();
    sessionDriverRef.current?.clearIdempotency();
    useBrowserAutomationStore.getState().setLifecycleTabs([]);
    agentOpenTabsRef.current.clear();
  }, []);

  return backgroundScopes.map((scope) => (
    <PersistentAutomationPreviewSurface
      key={browserAutomationScopeKey(scope.workspaceId, scope.threadId)}
      scope={scope}
    />
  ));
}
