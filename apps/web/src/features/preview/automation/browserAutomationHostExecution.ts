import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  type BrowserAutomationErrorCode,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import {
  browserAutomationRequestKey,
  browserAutomationTargetKey,
  useBrowserAutomationStore,
} from "./browserAutomationStore";
import { BrowserAutomationRecorder } from "./browserAutomationRecorder";
import { executeWebBrowserDispatch } from "./browserAutomationWebExecutor";
import { captureVisibleWebLocation, sanitizeWebLocation } from "./web-browser-automation/capture";
import { webIframeSelector } from "./browserAutomationHostNavigation";
import {
  getBrowserAutomationRuntimeOperations,
} from "./services/browserSessionDriver";
import {
  type ViewportApplyResult,
} from "./services/viewportCoordinator";
import {
  getOrCreateViewportCoordinator,
  waitForViewportLayout,
} from "./services/viewportCoordinatorFactory";
import type { PreviewAutomationBridge } from "@/transport/desktop-bridge";

const viewportCoordinatorDispatches = new WeakMap<object, BrowserAutomationHostDispatch>();

/** Return whether a tab lifecycle request removes its target. */
export function requestRemovesBrowserTarget(dispatch: BrowserAutomationHostDispatch): boolean {
  return dispatch.request.operation === "tabs" &&
    (dispatch.request.args.action === "close" || dispatch.request.args.action === "finalize");
}

/** Create a typed browser automation failure response. */
export function failureResponse(
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

function handoffFailureResponse(request: BrowserAutomationRequest, message: string): BrowserAutomationResponse {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: false,
    error: {
      code: "TAB_UNAVAILABLE",
      message,
      retryable: true,
      stage: "effect",
      effect: "preserved",
      recovery: "inspect",
      correlationId: globalThis.crypto.randomUUID(),
    },
  };
}

function releasedHandoffTab(response: BrowserAutomationResponse): { readonly tabId: string } | null {
  if (!response.ok || response.result.operation !== "tabs" || response.result.action !== "finalize") return null;
  return response.result.tabs.find(
    (tab) => tab.disposition === "handoff" && tab.ownership === "released",
  ) ?? null;
}

function agentControllerForHandoff(dispatch: BrowserAutomationHostDispatch, tabId: string) {
  return useBrowserAutomationStore.getState().controllers.get(browserAutomationTargetKey(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    tabId,
  ));
}

function hasCurrentHandoffController(
  dispatch: BrowserAutomationHostDispatch,
  controller: ReturnType<typeof agentControllerForHandoff>,
): boolean {
  return controller?.controller === "agent" &&
    controller.controlEpoch === dispatch.request.expectedControlEpoch &&
    controller.providerSessionId === dispatch.request.providerSessionId;
}

async function releaseDesktopHandoff(
  bridge: PreviewAutomationBridge,
  dispatch: BrowserAutomationHostDispatch,
  tabId: string,
  controlEpoch: number,
  providerSessionId: string,
): Promise<boolean> {
  try {
    return await bridge.releaseAgentControl({
      threadId: dispatch.target.threadId,
      tabId,
      controlEpoch,
      providerSessionId,
    });
  } catch {
    return false;
  }
}

function releaseWebHandoff(
  dispatch: BrowserAutomationHostDispatch,
  tabId: string,
  controlEpoch: number,
): void {
  useBrowserAutomationStore.getState().setControllerForTarget(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    tabId,
    { tabId, controller: "none", controlEpoch },
  );
}

/** Release agent control after a successful browser handoff. */
export async function releaseHandedOffBrowserControl(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
): Promise<BrowserAutomationResponse> {
  const handoff = releasedHandoffTab(response);
  if (!handoff) return response;
  const controller = agentControllerForHandoff(dispatch, handoff.tabId);
  if (controller?.controller !== "agent") return response;
  if (!hasCurrentHandoffController(dispatch, controller)) {
    return handoffFailureResponse(dispatch.request, "Browser control changed before handoff completed");
  }
  const bridge = window.desktopBridge?.preview?.automation;
  if (!bridge) {
    releaseWebHandoff(dispatch, handoff.tabId, controller.controlEpoch);
    return response;
  }
  const released = await releaseDesktopHandoff(
    bridge,
    dispatch,
    handoff.tabId,
    controller.controlEpoch,
    dispatch.request.providerSessionId,
  );
  return released ? response : handoffFailureResponse(dispatch.request, "Browser handoff could not release agent control");
}

function recordingAvailable(): boolean {
  const mediaRecorder = globalThis.MediaRecorder;
  return typeof mediaRecorder === "function" &&
    (typeof mediaRecorder.isTypeSupported !== "function" || mediaRecorder.isTypeSupported("video/webm")) &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
}

function viewportFailureCode(status: ViewportApplyResult["status"]): BrowserAutomationErrorCode {
  if (status === "stale") return "STALE_TARGET_GENERATION";
  if (status === "superseded") return "OPERATION_CANCELLED";
  return "INTERNAL_ERROR";
}

function resizeResponse(dispatch: BrowserAutomationHostDispatch, result: ViewportApplyResult): BrowserAutomationResponse {
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

/** Restore the agent viewport after a completed act request. */
export async function completeViewportControlRun(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
): Promise<BrowserAutomationResponse> {
  if (!isCompletedAgentAct(dispatch, response)) return response;
  const coordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(
    browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId),
  );
  if (!coordinator?.snapshot().agentActive) return response;
  const result = await coordinator.completeAgent({ targetGeneration: dispatch.target.targetGeneration });
  useBrowserAutomationStore.getState().setViewportState(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    dispatch.target.tabId,
    coordinator.snapshot(),
    coordinator,
  );
  if (!result || result.status === "applied" || result.status === "clamped") return response;
  return failureResponse(
    dispatch.request,
    viewportFailureCode(result.status),
    result.error ?? `Browser viewport restore ${result.status}`,
    result.applied,
  );
}

function isCompletedAgentAct(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
): boolean {
  return response.ok && dispatch.request.operation === "act" &&
    response.result.operation === "act" && response.result.outcome === "completed";
}

/** Interrupt the viewport work for a browser dispatch. */
export function interruptViewportCoordinator(dispatch: BrowserAutomationHostDispatch): void {
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

function ensureViewportCoordinator(dispatch: BrowserAutomationHostDispatch): ReturnType<typeof getOrCreateViewportCoordinator> {
  const key = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
  const state = useBrowserAutomationStore.getState();
  let coordinator = state.viewportCoordinators.get(key);
  coordinator = getOrCreateViewportCoordinator({
    existing: coordinator,
    target: dispatch.target,
    initial: state.viewportStateByTarget.get(key)?.confirmed ?? state.viewportByTarget.get(key),
    mode: state.viewportStateByTarget.get(key)?.mode,
    presentation: state.viewportStateByTarget.get(key)?.presentation,
    targetGeneration: dispatch.target.targetGeneration,
    surface: {
      setViewport: (size, operation, current) => useBrowserAutomationStore.getState().applyViewportIfCurrent(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId, current, operation.targetGeneration, size),
      resetViewport: (operation, current) => useBrowserAutomationStore.getState().resetViewportIfCurrent(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId, current, operation.targetGeneration),
      readViewport: () => useBrowserAutomationStore.getState().viewportByTarget.get(key) ?? null,
      waitForLayout: () => waitForViewportLayout(2),
      isCurrent: (operation, current) => {
        const latest = useBrowserAutomationStore.getState();
        return latest.viewportCoordinators.get(key) === current && latest.liveTargets.get(key)?.revision === operation.targetGeneration;
      },
    },
    readConfirmed: () => useBrowserAutomationStore.getState().viewportStateByTarget.get(key)?.confirmed ?? useBrowserAutomationStore.getState().viewportByTarget.get(key) ?? null,
    operationId: (_operation, sequence) => {
      const currentDispatch = viewportCoordinatorDispatches.get(coordinator!) ?? dispatch;
      return browserAutomationRequestKey(currentDispatch.request.requestId, currentDispatch.request.sequence + sequence);
    },
    onStateChange: (nextState, current) => useBrowserAutomationStore.getState().setViewportState(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId, nextState, current),
    onCreated: (created) => useBrowserAutomationStore.getState().setViewportCoordinator(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId, created),
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

/** Project web agent control before the browser operation begins. */
export function projectAgentControl(dispatch: BrowserAutomationHostDispatch): void {
  if (window.desktopBridge?.preview?.automation || dispatch.request.operation === "status" || !useThreadStore.getState().runningThreadIds.has(dispatch.target.threadId)) return;
  const operation = dispatch.request.operation;
  useBrowserAutomationStore.getState().setControllerForTarget(
    dispatch.scope.workspaceId,
    dispatch.target.threadId,
    dispatch.target.tabId,
    {
      tabId: dispatch.target.tabId,
      controller: "agent",
      controlEpoch: dispatch.request.expectedControlEpoch,
      providerSessionId: dispatch.request.providerSessionId,
      ...(!["inspect", "act", "tabs"].includes(operation) ? { operation } : {}),
    },
  );
}

function mountedWebIframe(dispatch: BrowserAutomationHostDispatch): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(webIframeSelector(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId));
}

async function requestViewportResize(dispatch: BrowserAutomationHostDispatch): Promise<BrowserAutomationResponse> {
  const coordinator = ensureViewportCoordinator(dispatch);
  const result = await coordinator.requestAgentResize(dispatch.request.args, {
    operationId: browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence),
    targetGeneration: dispatch.target.targetGeneration,
  });
  useBrowserAutomationStore.getState().setViewportState(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId, coordinator.snapshot(), coordinator);
  return resizeResponse(dispatch, result);
}

function visibleWebStatusResponse(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
  operations: readonly BrowserAutomationOperation[],
): BrowserAutomationResponse {
  if (!response.ok || response.result.operation !== "status") return response;
  const iframe = mountedWebIframe(dispatch);
  if (!iframe) return { ...response, result: { ...response.result, url: sanitizeWebLocation(response.result.url), capabilities: [...operations] } };
  try {
    const frameUrl = iframe.src ? new URL(iframe.src, window.location.href) : null;
    if (frameUrl && frameUrl.origin !== window.location.origin) return failureResponse(dispatch.request, "CROSS_ORIGIN", "Visible preview is cross-origin");
  } catch {
    return failureResponse(dispatch.request, "CROSS_ORIGIN", "Visible preview is cross-origin");
  }
  const location = captureVisibleWebLocation(iframe);
  if (!location.ok) return failureResponse(dispatch.request, location.code, "Visible preview is cross-origin");
  return { ...response, result: { ...response.result, url: location.value, capabilities: [...operations] } };
}

async function executeWebRuntimeDispatch(
  dispatch: BrowserAutomationHostDispatch,
  signal: AbortSignal,
  operations: readonly BrowserAutomationOperation[],
): Promise<BrowserAutomationResponse> {
  if (dispatch.request.operation === "resize") return requestViewportResize(dispatch);
  const response = await executeWebBrowserDispatch(dispatch, signal);
  return dispatch.request.operation === "status" ? visibleWebStatusResponse(dispatch, response, operations) : response;
}

function isRendererOwnedOperation(operation: BrowserAutomationHostDispatch["request"]["operation"]): boolean {
  return operation === "resize" || operation === "recordingStart" || operation === "recordingStop";
}

async function executeRendererOwnedOperation(
  recorder: BrowserAutomationRecorder,
  dispatch: BrowserAutomationHostDispatch,
  bridge: PreviewAutomationBridge,
): Promise<BrowserAutomationResponse> {
  if (dispatch.request.operation === "resize") return requestViewportResize(dispatch);
  if (dispatch.request.operation === "recordingStart") return recorder.start(dispatch, bridge);
  return recorder.stop(dispatch);
}

async function executeRendererOperation(
  recorder: BrowserAutomationRecorder,
  dispatch: BrowserAutomationHostDispatch,
  bridge: PreviewAutomationBridge,
): Promise<BrowserAutomationResponse> {
  const lease = await bridge.beginRendererOperation(dispatch);
  if (!lease.ok) return lease.response;
  let response: BrowserAutomationResponse;
  try {
    response = await executeRendererOwnedOperation(recorder, dispatch, bridge);
  } catch (cause) {
    response = failureResponse(dispatch.request, "INTERNAL_ERROR", cause instanceof Error ? cause.message : "Renderer browser operation failed");
  }
  await bridge.finishRendererOperation({ leaseId: lease.leaseId, succeeded: response.ok });
  return response;
}

/** Execute a browser dispatch through the active runtime adapter. */
export async function executeBrowserDispatch(
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
  if (!bridge) return executeWebRuntimeDispatch(dispatch, signal, operations);
  if (isRendererOwnedOperation(dispatch.request.operation)) return executeRendererOperation(recorder, dispatch, bridge);
  const response = await bridge.execute(dispatch);
  if (!response.ok || response.result.operation !== "status") return response;
  return { ...response, result: { ...response.result, capabilities: [...operations] } };
}
