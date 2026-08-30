import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
  BrowserAutomationHostDispatchSchema,
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
import { BrowserAutomationRecorder } from "./browserAutomationRecorder";
import {
  resolveSameOriginFrame,
} from "./webBrowserInteractionExecutor";
import { PreviewPanel } from "../surfaces/PreviewPanel";
import { browserSurfacePresentationCoordinator } from "../surfaces/BrowserSurfaceHostRoot";
import type { PreviewAutomationBridge } from "@/transport/desktop-bridge";
import {
  isBrowserAutomationWebRuntimeEnabled,
  normalizeWebPreviewUrl,
} from "./browserAutomationRuntime";
import {
  BrowserSessionDriver,
  ElectronBrowserSessionAdapter,
  getBrowserAutomationRuntimeActOperations,
  getBrowserAutomationRuntimeOperations,
} from "./services/browserSessionDriver";
import { WebBrowserSessionAdapter } from "./services/webBrowserSessionAdapter";
import {
  BrowserAutomationHostSupervisor,
  type BrowserAutomationHostLease,
} from "./services/browserAutomationHostSupervisor";
import {
  completeViewportControlRun as completeViewportControlRunImplementation,
  executeBrowserDispatch as executeBrowserDispatchImplementation,
  interruptViewportCoordinator as interruptViewportCoordinatorImplementation,
  projectAgentControl as projectAgentControlImplementation,
  releaseHandedOffBrowserControl as releaseHandedOffBrowserControlImplementation,
} from "./browserAutomationHostExecution";
import {
  acceptExpectedWebNavigationRevision as acceptExpectedWebNavigationRevisionImplementation,
} from "./browserAutomationHostNavigation";
import { createBrowserAutomationBootstrapLifecycle } from "./browserAutomationHostLifecycle";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HOST_REGISTRATION_RETRY_MS = 1_000;
const TARGET_DISCOVERY_RETRY_MS = 50;
const TARGET_DISCOVERY_MAX_ATTEMPTS = 40;
const WEB_AUTOMATION_UNAVAILABLE_REASON = "Web automation executor is unavailable";
export { isBrowserAutomationWebRuntimeEnabled } from "./browserAutomationRuntime";

function requestRemovesBrowserTarget(dispatch: BrowserAutomationHostDispatch): boolean {
  return dispatch.request.operation === "tabs" &&
    (dispatch.request.args.action === "close" || dispatch.request.args.action === "finalize");
}

async function releaseHandedOffBrowserControl(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
): Promise<BrowserAutomationResponse> {
  return releaseHandedOffBrowserControlImplementation(dispatch, response);
}

function isBrowserTabHandoffInFlight(
  dispatches: Iterable<BrowserAutomationHostDispatch>,
  workspaceId: string,
  threadId: string,
  tabId: string,
): boolean {
  for (const dispatch of dispatches) {
    if (
      dispatch.scope.workspaceId !== workspaceId ||
      dispatch.target.threadId !== threadId ||
      dispatch.target.tabId !== tabId ||
      dispatch.request.operation !== "tabs" ||
      dispatch.request.args.action !== "finalize"
    ) continue;
    if (dispatch.request.args.dispositions.some(
      (entry: { tabId: string; disposition: "close" | "release" | "handoff" | "deliverable" }) =>
        entry.tabId === tabId && entry.disposition === "handoff",
    )) return true;
  }
  return false;
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

async function completeViewportControlRun(
  dispatch: BrowserAutomationHostDispatch,
  response: BrowserAutomationResponse,
): Promise<BrowserAutomationResponse> {
  return completeViewportControlRunImplementation(dispatch, response);
}

function interruptViewportCoordinator(dispatch: BrowserAutomationHostDispatch): void {
  interruptViewportCoordinatorImplementation(dispatch);
}

function projectAgentControl(dispatch: BrowserAutomationHostDispatch): void {
  projectAgentControlImplementation(dispatch);
}

async function executeBrowserDispatch(
  bridge: PreviewAutomationBridge | undefined,
  recorder: BrowserAutomationRecorder,
  dispatch: BrowserAutomationHostDispatch,
  signal: AbortSignal,
  runtimeOperations?: readonly BrowserAutomationOperation[],
): Promise<BrowserAutomationResponse> {
  return executeBrowserDispatchImplementation(bridge, recorder, dispatch, signal, runtimeOperations);
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
  return acceptExpectedWebNavigationRevisionImplementation(dispatch, navigation, target);
}

interface BrowserAutomationHostRequestState {
  readonly inFlight: Map<string, BrowserAutomationHostDispatch>;
  readonly requestAbort: Map<string, AbortController>;
  readonly webAbort: Map<string, AbortController>;
  readonly webObserver: Map<string, () => void>;
  readonly webNavigation: Map<string, WebNavigationExpectation>;
  readonly cancelled: Set<string>;
  readonly recorder: BrowserAutomationRecorder;
  readonly sessionDriver: BrowserSessionDriver;
  readonly getLease: () => BrowserAutomationHostLease | null;
}

interface BrowserAutomationWebRequestFlags {
  readonly interaction: boolean;
  readonly executor: boolean;
  readonly open: boolean;
  readonly navigate: boolean;
}

interface BrowserAutomationRequestContext {
  readonly bridge: PreviewAutomationBridge | undefined;
  readonly webAutomationEnabled: boolean;
  readonly state: BrowserAutomationHostRequestState;
  readonly dispatch: BrowserAutomationHostDispatch;
  readonly lease: BrowserAutomationHostLease;
  readonly key: string;
  readonly controller: AbortController;
  readonly operationAbort: AbortController | null;
  readonly targetKey: string;
  readonly flags: BrowserAutomationWebRequestFlags;
  readonly initialTargetMatches: boolean;
  readonly initialControlEpochMatches: boolean;
}

interface BrowserAutomationCancelPayload {
  readonly requestId: string;
  readonly sequence: number;
}

function parseBrowserAutomationRequest(
  input: unknown,
  getLease: () => BrowserAutomationHostLease | null,
): { readonly dispatch: BrowserAutomationHostDispatch; readonly lease: BrowserAutomationHostLease } | null {
  const payload = input as { hostId?: unknown; generation?: unknown; dispatch?: unknown };
  const lease = getLease();
  if (!lease) return null;
  if (payload.hostId !== lease.hostId) return null;
  if (payload.generation !== lease.generation) return null;
  const parsed = BrowserAutomationHostDispatchSchema().safeParse(payload.dispatch);
  if (!parsed.success) return null;
  return { dispatch: parsed.data, lease };
}

function browserAutomationWebRequestFlags(
  bridge: PreviewAutomationBridge | undefined,
  webAutomationEnabled: boolean,
  dispatch: BrowserAutomationHostDispatch,
): BrowserAutomationWebRequestFlags {
  const webRuntime = !bridge && webAutomationEnabled;
  const operation = dispatch.request.operation;
  const hasUrl = Boolean(dispatch.request.args.url);
  return {
    interaction: webRuntime && (operation === "click" || operation === "type"),
    executor: webRuntime,
    open: webRuntime && operation === "open" && hasUrl,
    navigate: webRuntime && operation === "navigate" && hasUrl,
  };
}

function createBrowserAutomationRequestContext(
  parsed: { readonly dispatch: BrowserAutomationHostDispatch; readonly lease: BrowserAutomationHostLease },
  bridge: PreviewAutomationBridge | undefined,
  webAutomationEnabled: boolean,
  state: BrowserAutomationHostRequestState,
): BrowserAutomationRequestContext | null {
  const { dispatch, lease } = parsed;
  const key = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
  if (state.inFlight.has(key)) return null;
  const flags = browserAutomationWebRequestFlags(bridge, webAutomationEnabled, dispatch);
  const controller = new AbortController();
  const operationAbort = flags.interaction ? new AbortController() : null;
  const targetKey = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
  state.inFlight.set(key, dispatch);
  const store = useBrowserAutomationStore.getState();
  store.setActiveRequest({ dispatch, startedAt: Date.now() });
  projectAgentControl(dispatch);
  state.requestAbort.set(key, controller);
  if (operationAbort) state.webAbort.set(key, operationAbort);
  const target = store.liveTargets.get(targetKey);
  const controlEpoch = store.controllers.get(targetKey)?.controlEpoch ?? dispatch.request.expectedControlEpoch;
  return {
    bridge,
    webAutomationEnabled,
    state,
    dispatch,
    lease,
    key,
    controller,
    operationAbort,
    targetKey,
    flags,
    initialTargetMatches: Boolean(target && target.revision === dispatch.target.targetGeneration),
    initialControlEpochMatches: controlEpoch === dispatch.request.expectedControlEpoch,
  };
}

function observeExpectedWebNavigationLoad(
  context: BrowserAutomationRequestContext,
  requestedUrl: string,
  navigation: WebNavigationExpectation,
): void {
  const selector = webIframeSelector(
    context.dispatch.scope.workspaceId,
    context.dispatch.target.threadId,
    context.dispatch.target.tabId,
  );
  const iframe = document.querySelector<HTMLIFrameElement>(selector);
  if (!iframe) return;
  const onLoad = () => {
    if (normalizeWebPreviewUrl(iframe.src) === requestedUrl) navigation.loadObserved = true;
  };
  iframe.addEventListener("load", onLoad, { once: true });
  context.state.webObserver.set(context.key, () => iframe.removeEventListener("load", onLoad));
}

function trackExpectedWebNavigation(context: BrowserAutomationRequestContext): void {
  if (!context.flags.navigate) return;
  const requestedUrl = normalizeWebPreviewUrl(context.dispatch.request.args.url ?? "");
  if (!requestedUrl || !isSameOriginWebPreviewUrl(requestedUrl)) return;
  const target = useBrowserAutomationStore.getState().liveTargets.get(context.targetKey);
  if (!target || target.revision !== context.dispatch.target.targetGeneration) return;
  const navigation: WebNavigationExpectation = {
    targetKey: context.targetKey,
    expectedUrl: requestedUrl,
    initialRevision: target.revision,
    loadObserved: false,
  };
  context.state.webNavigation.set(context.key, navigation);
  observeExpectedWebNavigationLoad(context, requestedUrl, navigation);
}

function initialBrowserRequestFailure(
  context: BrowserAutomationRequestContext,
): BrowserAutomationResponse | null {
  if (!context.initialTargetMatches) {
    return failureResponse(context.dispatch.request, "STALE_TARGET_GENERATION", "Browser operation is stale");
  }
  if (!context.initialControlEpochMatches) {
    return failureResponse(context.dispatch.request, "STALE_CONTROL_EPOCH", "Browser operation is stale");
  }
  return null;
}

function executeWebInteraction(
  context: BrowserAutomationRequestContext,
): Promise<BrowserAutomationResponse> {
  const staleResponse = initialBrowserRequestFailure(context);
  if (staleResponse) return Promise.resolve(staleResponse);
  if (!context.operationAbort) {
    return Promise.resolve(failureResponse(context.dispatch.request, "TAB_UNAVAILABLE", "Browser target is unavailable"));
  }
  return context.state.sessionDriver.execute(context.dispatch, context.controller.signal);
}

function sameOriginWebOpenUrl(context: BrowserAutomationRequestContext): string | null {
  if (!context.flags.open || context.dispatch.request.operation !== "open") return null;
  const requestedUrl = normalizeWebPreviewUrl(context.dispatch.request.args.url ?? "");
  if (!requestedUrl || !isSameOriginWebPreviewUrl(requestedUrl)) return null;
  return requestedUrl;
}

function staleCurrentWebTargetResponse(
  context: BrowserAutomationRequestContext,
): BrowserAutomationResponse | null {
  const target = useBrowserAutomationStore.getState().liveTargets.get(context.targetKey);
  if (!target || target.revision !== context.dispatch.target.targetGeneration) {
    return failureResponse(context.dispatch.request, "STALE_TARGET_GENERATION", "Browser operation is stale");
  }
  return null;
}

function markExpectedWebNavigationLoaded(
  context: BrowserAutomationRequestContext,
  requestedUrl: string,
): void {
  const navigation = context.state.webNavigation.get(context.key);
  if (navigation?.targetKey === context.targetKey && navigation.expectedUrl === requestedUrl) {
    navigation.loadObserved = true;
  }
}

function startWebOpenNavigation(
  context: BrowserAutomationRequestContext,
  requestedUrl: string,
  targetRevision: number,
): HTMLIFrameElement | null {
  const iframe = webPreviewIframe(
    context.dispatch.scope.workspaceId,
    context.dispatch.target.threadId,
    context.dispatch.target.tabId,
    requestedUrl,
  );
  if (iframe) return iframe;
  context.state.webNavigation.set(context.key, {
    targetKey: context.targetKey,
    expectedUrl: requestedUrl,
    initialRevision: targetRevision,
    loadObserved: false,
  });
  useDiffStore.getState().setPreviewUrlForThread(context.dispatch.target.threadId, requestedUrl);
  return null;
}

async function waitForWebOpenNavigation(
  context: BrowserAutomationRequestContext,
  requestedUrl: string,
  iframe: HTMLIFrameElement | null,
): Promise<void> {
  const onNavigationLoad = iframe
    ? undefined
    : () => markExpectedWebNavigationLoaded(context, requestedUrl);
  await waitForWebPreviewIframe(
    context.dispatch.scope.workspaceId,
    context.dispatch.target.threadId,
    context.dispatch.target.tabId,
    requestedUrl,
    context.dispatch.request.deadline,
    context.controller.signal,
    onNavigationLoad,
  );
}

function expectedWebNavigationRevision(context: BrowserAutomationRequestContext): number {
  const target = useBrowserAutomationStore.getState().liveTargets.get(context.targetKey);
  const navigation = context.state.webNavigation.get(context.key);
  return navigation?.acceptedRevision ??
    acceptExpectedWebNavigationRevision(context.dispatch, navigation, target) ??
    context.dispatch.target.targetGeneration;
}

function staleExpectedWebTargetResponse(
  context: BrowserAutomationRequestContext,
): BrowserAutomationResponse | null {
  const target = useBrowserAutomationStore.getState().liveTargets.get(context.targetKey);
  if (!target || target.revision !== expectedWebNavigationRevision(context)) {
    return failureResponse(context.dispatch.request, "STALE_TARGET_GENERATION", "Browser operation is stale");
  }
  return null;
}

function staleWebOpenResponse(context: BrowserAutomationRequestContext): BrowserAutomationResponse | null {
  const targetFailure = staleExpectedWebTargetResponse(context);
  if (targetFailure) return targetFailure;
  const controlEpoch = useBrowserAutomationStore.getState().controllers.get(context.targetKey)?.controlEpoch ??
    context.dispatch.request.expectedControlEpoch;
  if (controlEpoch !== context.dispatch.request.expectedControlEpoch) {
    return failureResponse(context.dispatch.request, "STALE_CONTROL_EPOCH", "Browser operation is stale");
  }
  return null;
}

function webOpenExecutionDispatch(context: BrowserAutomationRequestContext): BrowserAutomationHostDispatch {
  return {
    ...context.dispatch,
    request: {
      ...context.dispatch.request,
      args: { activate: context.dispatch.request.args.activate },
    },
  };
}

async function executeWebOpen(context: BrowserAutomationRequestContext): Promise<BrowserAutomationResponse> {
  const requestedUrl = sameOriginWebOpenUrl(context);
  if (!requestedUrl) return context.state.sessionDriver.execute(context.dispatch, context.controller.signal);
  const staleResponse = staleCurrentWebTargetResponse(context);
  if (staleResponse) return staleResponse;
  const target = useBrowserAutomationStore.getState().liveTargets.get(context.targetKey)!;
  const iframe = startWebOpenNavigation(context, requestedUrl, target.revision);
  await waitForWebOpenNavigation(context, requestedUrl, iframe);
  const readyFailure = staleWebOpenResponse(context);
  if (readyFailure) return readyFailure;
  return context.state.sessionDriver.execute(webOpenExecutionDispatch(context), context.controller.signal);
}

function selectBrowserAutomationOperation(
  context: BrowserAutomationRequestContext,
): Promise<BrowserAutomationResponse> {
  if (context.flags.interaction) return executeWebInteraction(context);
  if (context.flags.open) return executeWebOpen(context);
  if (context.bridge || context.flags.executor) {
    return context.state.sessionDriver.execute(context.dispatch, context.controller.signal);
  }
  return Promise.resolve(failureResponse(
    context.dispatch.request,
    "UNSUPPORTED_OPERATION",
    WEB_AUTOMATION_UNAVAILABLE_REASON,
  ));
}

function requiresWebTargetVerification(context: BrowserAutomationRequestContext): boolean {
  return context.flags.interaction || context.flags.open || context.flags.navigate;
}

function guardBrowserAutomationResponse(
  context: BrowserAutomationRequestContext,
  response: BrowserAutomationResponse,
): BrowserAutomationResponse {
  if (!requiresWebTargetVerification(context)) return response;
  return staleExpectedWebTargetResponse(context) ?? response;
}

function guardBrowserAutomationFailure(
  context: BrowserAutomationRequestContext,
  cause: unknown,
): BrowserAutomationResponse {
  if (requiresWebTargetVerification(context)) {
    const staleResponse = staleExpectedWebTargetResponse(context);
    if (staleResponse) return staleResponse;
  }
  throw cause;
}

function guardBrowserAutomationOperation(
  context: BrowserAutomationRequestContext,
  operation: Promise<BrowserAutomationResponse>,
): Promise<BrowserAutomationResponse> {
  return operation
    .then((response) => guardBrowserAutomationResponse(context, response))
    .catch((cause: unknown) => guardBrowserAutomationFailure(context, cause));
}

function includesResponseTarget(context: BrowserAutomationRequestContext): boolean {
  return context.flags.interaction ||
    context.flags.navigate ||
    context.dispatch.request.operation === "tabs" ||
    (!context.bridge && context.webAutomationEnabled && context.dispatch.request.operation === "screenshot");
}

async function respondToBrowserAutomationRequest(
  context: BrowserAutomationRequestContext,
  response: BrowserAutomationResponse,
): Promise<void> {
  if (context.state.getLease() !== context.lease || context.state.cancelled.has(context.key)) return;
  const completedResponse = await completeViewportControlRun(context.dispatch, response);
  const settledResponse = await releaseHandedOffBrowserControl(context.dispatch, completedResponse);
  const target = context.state.sessionDriver.responseTarget(context.dispatch, settledResponse);
  if (includesResponseTarget(context)) {
    await getTransport().respondToBrowserAutomationRequest(
      context.lease.hostId,
      context.lease.generation,
      settledResponse,
      target,
    );
    return;
  }
  await getTransport().respondToBrowserAutomationRequest(
    context.lease.hostId,
    context.lease.generation,
    settledResponse,
  );
}

function cleanupBrowserAutomationRequest(context: BrowserAutomationRequestContext): void {
  context.state.webObserver.get(context.key)?.();
  context.state.webObserver.delete(context.key);
  context.state.webAbort.delete(context.key);
  context.state.webNavigation.delete(context.key);
  if (context.state.inFlight.get(context.key) === context.dispatch) context.state.inFlight.delete(context.key);
  context.state.requestAbort.delete(context.key);
  context.state.cancelled.delete(context.key);
  useBrowserAutomationStore.getState().clearActiveRequest(
    context.dispatch.request.requestId,
    context.dispatch.request.sequence,
  );
}

function startBrowserAutomationRequest(context: BrowserAutomationRequestContext): void {
  const operation = guardBrowserAutomationOperation(context, selectBrowserAutomationOperation(context));
  void operation
    .then((response) => respondToBrowserAutomationRequest(context, response))
    .catch(() => undefined)
    .finally(() => cleanupBrowserAutomationRequest(context));
}

function handleBrowserAutomationRequest(
  input: unknown,
  bridge: PreviewAutomationBridge | undefined,
  webAutomationEnabled: boolean,
  state: BrowserAutomationHostRequestState,
): void {
  const parsed = parseBrowserAutomationRequest(input, state.getLease);
  if (!parsed) return;
  const context = createBrowserAutomationRequestContext(parsed, bridge, webAutomationEnabled, state);
  if (!context) return;
  trackExpectedWebNavigation(context);
  startBrowserAutomationRequest(context);
}

function parseBrowserAutomationCancel(
  input: unknown,
  getLease: () => BrowserAutomationHostLease | null,
): BrowserAutomationCancelPayload | null {
  const payload = input as { hostId?: unknown; generation?: unknown; requestId?: unknown; sequence?: unknown };
  const lease = getLease();
  if (!lease) return null;
  if (payload.hostId !== lease.hostId) return null;
  if (payload.generation !== lease.generation) return null;
  if (typeof payload.requestId !== "string") return null;
  if (typeof payload.sequence !== "number") return null;
  return { requestId: payload.requestId, sequence: payload.sequence };
}

function abortBootstrapRequest(
  key: string,
  bootstrapAbort: Map<string, AbortController>,
): void {
  bootstrapAbort.get(key)?.abort(new Error("Browser bootstrap was cancelled"));
}

function cancelBrowserAutomationRequest(
  payload: BrowserAutomationCancelPayload,
  bridge: PreviewAutomationBridge | undefined,
  state: BrowserAutomationHostRequestState,
): void {
  const key = browserAutomationRequestKey(payload.requestId, payload.sequence);
  const dispatch = state.inFlight.get(key);
  if (!dispatch || state.cancelled.has(key)) return;
  state.cancelled.add(key);
  interruptViewportCoordinator(dispatch);
  state.webAbort.get(key)?.abort(new Error("Browser operation was cancelled"));
  state.recorder.cancel(dispatch);
  state.requestAbort.get(key)?.abort(new Error("Browser operation was cancelled"));
  if (bridge) void bridge.cancel(payload.requestId);
}

function createBrowserAutomationRequestHandler(
  bridge: PreviewAutomationBridge | undefined,
  webAutomationEnabled: boolean,
  state: BrowserAutomationHostRequestState,
): (input: unknown) => void {
  return (input) => handleBrowserAutomationRequest(input, bridge, webAutomationEnabled, state);
}

function createBrowserAutomationCancelHandler(
  bridge: PreviewAutomationBridge | undefined,
  state: BrowserAutomationHostRequestState,
  bootstrapAbort: Map<string, AbortController>,
): (input: unknown) => void {
  return (input) => {
    const payload = parseBrowserAutomationCancel(input, state.getLease);
    if (!payload) return;
    const key = browserAutomationRequestKey(payload.requestId, payload.sequence);
    abortBootstrapRequest(key, bootstrapAbort);
    cancelBrowserAutomationRequest(payload, bridge, state);
  };
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
  readonly coveredLeft: number;
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
  const agentControlsScope = useBrowserAutomationStore((state) => {
    for (const [targetKey, controller] of state.controllers) {
      if (controller.controller !== "agent") continue;
      const target = state.liveTargets.get(targetKey);
      if (
        target?.workspaceId === scope.workspaceId &&
        target.threadId === scope.threadId
      ) return true;
    }
    return false;
  });
  const [layout, setLayout] = useState<PersistentSurfaceLayout>({
    visible: false,
    left: -20_000,
    top: 0,
    width: 1_280,
    height: 720,
    coveredLeft: 0,
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
            coveredLeft: browserSurfacePresentationCoordinator.getActivityRailOverlap(),
          }
        : {
            visible: false,
            left: -20_000,
            top: 0,
            width: 1_280,
            height: 720,
            coveredLeft: 0,
          };
      setLayout((current) => (
        current.visible === next.visible && current.left === next.left && current.top === next.top &&
        current.width === next.width && current.height === next.height &&
        current.coveredLeft === next.coveredLeft ? current : next
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

  let surfaceZIndex: number | undefined;
  if (!layout.visible) surfaceZIndex = -1;
  else if (agentControlsScope) surfaceZIndex = 30;

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
        zIndex: surfaceZIndex,
        pointerEvents: layout.visible ? "auto" : "none",
      }}
    >
      <PreviewPanel
        threadId={scope.threadId}
        workspaceId={scope.workspaceId}
        automationOnly={!layout.visible}
        coveredLeft={layout.visible ? layout.coveredLeft : 0}
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
  const leaseRef = useRef<BrowserAutomationHostLease | null>(null);
  const shutdownLeaseRef = useRef<BrowserAutomationHostLease | null>(null);
  const supervisorRef = useRef<BrowserAutomationHostSupervisor | null>(null);
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
    const activateLifecycleTarget = async (
      target: BrowserAutomationHostDispatchTarget,
      workspaceId: string,
    ): Promise<void> => {
      await usePreviewTabsStore.getState().activatePage(workspaceId, target.threadId, target.tabId);
      const tabSet = usePreviewTabsStore.getState().tabSetByScope[
        previewTabsScopeKey(workspaceId, target.threadId)
      ];
      if (tabSet?.activeTabId !== target.tabId) {
        throw new Error("Browser tab could not be activated");
      }
      const diff = useDiffStore.getState();
      diff.showRightPanel(workspaceId, target.threadId);
      diff.setRightPanelTab(workspaceId, target.threadId, "preview");
    };
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
        activate: activateLifecycleTarget,
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
        activate: activateLifecycleTarget,
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
  const workspaceSignature = JSON.stringify([...workspaceIds].sort());

  const shouldInterruptViewport = (dispatch: BrowserAutomationHostDispatch): boolean => {
    const targetKey = browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId);
    return useBrowserAutomationStore.getState().viewportCoordinators.get(targetKey)?.snapshot().agentActive === true ||
      dispatch.request.operation === "resize";
  };

  const cancelRemoteHostedRequest = (
    lease: BrowserAutomationHostLease | null,
    dispatch: BrowserAutomationHostDispatch,
    reason: "human-interrupted" | "user-stopped" | "host-shutdown",
  ): void => {
    if (!lease) return;
    void getTransport().cancelBrowserAutomationRequest(
      lease.hostId,
      lease.generation,
      dispatch.request.requestId,
      dispatch.request.sequence,
      reason,
    ).catch(() => undefined);
  };

  const cancelHostedRequest = useCallback((
    key: string,
    dispatch: BrowserAutomationHostDispatch,
    reason: "human-interrupted" | "user-stopped" | "host-shutdown",
    leaseOverride?: BrowserAutomationHostLease | null,
  ): void => {
    if (cancelledRef.current.has(key)) return;
    cancelledRef.current.add(key);
    if (shouldInterruptViewport(dispatch)) interruptViewportCoordinator(dispatch);
    webAbortRef.current.get(key)?.abort(new Error(`Browser operation was cancelled: ${reason}`));
    recorderRef.current.cancel(dispatch);
    void window.desktopBridge?.preview?.automation?.cancel(dispatch.request.requestId);
    cancelRemoteHostedRequest(leaseOverride ?? leaseRef.current, dispatch, reason);
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
    useBrowserAutomationStore.getState().setLifecycleTabs([]);
    const transport = getTransport();
    const liveTargetSnapshot = useBrowserAutomationStore.getState().liveTargets;
    const activeTarget = [...liveTargetSnapshot.values()].find((target) => target.workspaceId === activeWorkspaceId);
    const worktreeIdentity = import.meta.env.VITE_MCODE_WORKTREE_IDENTITY?.trim() || "web-runtime";
    const supervisor = new BrowserAutomationHostSupervisor({
      register: async () => {
        const result = await transport.registerBrowserAutomationHost({
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
        });
        return { hostId: stableHostId, ...result };
      },
      heartbeat: (lease) => transport.heartbeatBrowserAutomationHost(
        lease.hostId,
        lease.generation,
        Date.now(),
      ),
      onLeaseChanged: (lease) => {
        if (supervisorRef.current !== supervisor) return;
        const previousLease = leaseRef.current;
        leaseRef.current = lease;
        if (!lease) {
          if (previousLease) {
            for (const [key, dispatch] of inFlightRef.current) {
              cancelHostedRequest(key, dispatch, "host-shutdown", previousLease);
            }
            for (const [key, request] of bootstrapRequestRef.current) {
              bootstrapAbortRef.current.get(key)?.abort(new Error("Browser host lease was rejected"));
              void transport.cancelBrowserAutomationRequest(
                previousLease.hostId,
                previousLease.generation,
                request.requestId,
                request.sequence,
                "host-shutdown",
              ).catch(() => undefined);
            }
          }
          sessionDriverRef.current?.clearIdempotency();
          useBrowserAutomationStore.getState().setLifecycleTabs([]);
          agentOpenTabsRef.current.clear();
          useBrowserAutomationStore.getState().setRegistered(false);
          useBrowserAutomationStore.getState().setStatus("unavailable");
          return;
        }
        shutdownLeaseRef.current = lease;
        useBrowserAutomationStore.getState().setRegistered(true);
        useBrowserAutomationStore.getState().setStatus("registered");
        sessionDriverRef.current?.publishLifecycleProjection();
      },
      retryDelayMs: HOST_REGISTRATION_RETRY_MS,
    });
    supervisorRef.current = supervisor;
    void supervisor.start();
    return () => {
      const previousLease = leaseRef.current;
      for (const [key, dispatch] of inFlightRef.current) {
        cancelHostedRequest(key, dispatch, "host-shutdown", previousLease);
      }
      for (const [key, request] of bootstrapRequestRef.current) {
        bootstrapAbortRef.current.get(key)?.abort(new Error("Browser host registration was replaced"));
        if (previousLease) {
          void transport.cancelBrowserAutomationRequest(
            previousLease.hostId,
            previousLease.generation,
            request.requestId,
            request.sequence,
            "host-shutdown",
          ).catch(() => undefined);
        }
      }
      supervisor.stop();
      if (supervisorRef.current === supervisor) supervisorRef.current = null;
      leaseRef.current = null;
      sessionDriverRef.current?.clearIdempotency();
      useBrowserAutomationStore.getState().setLifecycleTabs([]);
      agentOpenTabsRef.current.clear();
      useBrowserAutomationStore.getState().setRegistered(false);
      useBrowserAutomationStore.getState().setStatus("unavailable");
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

  const abortRequestsForReplacedTarget = (
    targetKey: string,
    target: { readonly revision: number },
  ): void => {
    for (const [requestKey, dispatch] of inFlightRef.current) {
      if (browserAutomationTargetKey(dispatch.scope.workspaceId, dispatch.target.threadId, dispatch.target.tabId) !== targetKey) continue;
      const navigation = webNavigationRef.current.get(requestKey);
      if (acceptExpectedWebNavigationRevision(dispatch, navigation, target) !== undefined) continue;
      webAbortRef.current.get(requestKey)?.abort(new Error("Browser document was replaced"));
      requestAbortRef.current.get(requestKey)?.abort(new Error("Browser document was replaced"));
    }
  };

  const removeOpenTargetMappings = (targetKey: string): void => {
    for (const [openKey, mappedTarget] of agentOpenTabsRef.current) {
      if (browserAutomationTargetKey(mappedTarget.workspaceId, mappedTarget.threadId, mappedTarget.tabId) === targetKey) {
        agentOpenTabsRef.current.delete(openKey);
      }
    }
  };

  const cancelRequestsForDetachedTarget = (workspaceId: string, threadId: string, tabId: string): void => {
    for (const [key, dispatch] of inFlightRef.current) {
      if (dispatch.scope.workspaceId !== workspaceId || dispatch.target.threadId !== threadId || dispatch.target.tabId !== tabId) continue;
      if (!requestRemovesBrowserTarget(dispatch)) cancelHostedRequest(key, dispatch, "host-shutdown");
    }
  };

  useEffect(() => {
    const next = new Set(liveTargets.keys());
    const priorRevisions = priorLiveTargetRevisionsRef.current;
    for (const [key, target] of liveTargets) {
      const previousRevision = priorRevisions.get(key);
      if (previousRevision === undefined || previousRevision === target.revision) continue;
      if (!isBrowserTabHandoffInFlight(inFlightRef.current.values(), target.workspaceId, target.threadId, target.tabId)) {
        abortRequestsForReplacedTarget(key, target);
      }
    }
    for (const removed of priorLiveTargetKeysRef.current) {
      if (next.has(removed)) continue;
      const [workspaceId, threadId, tabId] = JSON.parse(removed) as [string, string, string];
      sessionDriverRef.current?.clearIdempotencyForTarget(workspaceId, threadId, tabId);
      removeOpenTargetMappings(removed);
      recorderRef.current.disposeTarget(workspaceId, threadId, tabId);
      cancelRequestsForDetachedTarget(workspaceId, threadId, tabId);
    }
    priorLiveTargetKeysRef.current = next;
    priorLiveTargetRevisionsRef.current = new Map(
      [...liveTargets].map(([key, target]) => [key, target.revision]),
    );
  }, [cancelHostedRequest, liveTargets]);

  useEffect(() => {
    const supervisor = supervisorRef.current;
    if (!supervisor || connectionStatus !== "connected") return;
    const heartbeat = (): void => {
      void supervisor.pulse();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") heartbeat();
    };
    const desktopAutomation = window.desktopBridge?.preview?.automation;
    const unsubscribeDesktop = desktopAutomation?.onHostHeartbeat(heartbeat);
    const timer = desktopAutomation ? null : window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    if (!desktopAutomation) heartbeat();
    window.addEventListener("focus", heartbeat);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribeDesktop?.();
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("focus", heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connectionStatus, workspaceSignature, liveTargets.size, registered]);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.automation;
    const webAutomationEnabled = isBrowserAutomationWebRuntimeEnabled();
    if (!bridge && !webAutomationEnabled) return;
    const requestState: BrowserAutomationHostRequestState = {
      inFlight: inFlightRef.current,
      requestAbort: requestAbortRef.current,
      webAbort: webAbortRef.current,
      webObserver: webObserverRef.current,
      webNavigation: webNavigationRef.current,
      cancelled: cancelledRef.current,
      recorder: recorderRef.current,
      sessionDriver: sessionDriverRef.current!,
      getLease: () => leaseRef.current,
    };
    const unsubscribeRequest = pushEmitter.on(
      "browserAutomation.request",
      createBrowserAutomationRequestHandler(bridge, webAutomationEnabled, requestState),
    );
    const unsubscribeCancel = pushEmitter.on(
      "browserAutomation.cancel",
      createBrowserAutomationCancelHandler(bridge, requestState, bootstrapAbortRef.current),
    );
    return () => {
      unsubscribeRequest();
      unsubscribeCancel();
    };
  }, [cancelHostedRequest]);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge && !isBrowserAutomationWebRuntimeEnabled()) return;
    const lifecycle = createBrowserAutomationBootstrapLifecycle({
      bridge,
      sessionDriver: sessionDriverRef.current!,
      getLease: () => leaseRef.current,
      state: {
        inFlight: inFlightRef.current,
        requestAbort: requestAbortRef.current,
        cancelled: cancelledRef.current,
        bootstrapPending: bootstrapPendingRef.current,
        bootstrapAbort: bootstrapAbortRef.current,
        bootstrapRequest: bootstrapRequestRef.current,
        agentOpenTabs: agentOpenTabsRef.current,
        persistentWebTabs: persistentWebTabsRef.current,
      },
      getBackgroundScopes: () => backgroundScopesRef.current,
      setCurrentBackgroundScopes: (scopes) => {
        backgroundScopesRef.current = scopes;
      },
      setRenderedBackgroundScopes: setBackgroundScopes,
      setHostedScopeIds: (scopes) => useBrowserAutomationStore.getState().setHostedScopeIds(
        new Set(scopes.map((scope) => browserAutomationScopeKey(scope.workspaceId, scope.threadId))),
      ),
      isScopeBusy: (scope) => recorderRef.current.hasActiveThread(scope.workspaceId, scope.threadId) ||
        browserSurfacePresentationCoordinator.hasAutomationAnchor(scope.workspaceId, scope.threadId),
      addPersistentWebTab,
      removePersistentWebTab,
    });
    return pushEmitter.on("browserAutomation.bootstrap", lifecycle);
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
      if (isBrowserTabHandoffInFlight(
        inFlightRef.current.values(),
        target.workspaceId,
        target.threadId,
        target.tabId,
      )) return;
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
    if (isBrowserTabHandoffInFlight(inFlightRef.current.values(), workspaceId, threadId, tabId)) {
      return;
    }
    recorderRef.current.disposeTarget(workspaceId, threadId, tabId);
    for (const dispatch of inFlightRef.current.values()) {
      if (dispatch.scope.workspaceId !== workspaceId || dispatch.target.threadId !== threadId || dispatch.target.tabId !== tabId) continue;
      const lease = leaseRef.current;
      if (!lease) continue;
      const key = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
      cancelHostedRequest(key, dispatch, reason, lease);
    }
  }), [cancelHostedRequest]);

  const releasedScopeMatches = (
    release: Parameters<typeof onBrowserAutomationScopeRelease>[0] extends (value: infer Value) => unknown ? Value : never,
    threadId: string,
    workspaceId: string,
  ): boolean => release.threadId === undefined
    ? workspaceId === release.workspaceId
    : workspaceId === release.workspaceId && threadId === release.threadId;

  const releaseBrowserDriverScope = (
    release: Parameters<typeof onBrowserAutomationScopeRelease>[0] extends (value: infer Value) => unknown ? Value : never,
  ): void => {
    if (release.threadId === undefined) void sessionDriverRef.current?.releaseWorkspace(release.workspaceId);
    else void sessionDriverRef.current?.releaseThread(release.workspaceId, release.threadId);
  };

  const removeReleasedBackgroundScopes = (
    release: Parameters<typeof onBrowserAutomationScopeRelease>[0] extends (value: infer Value) => unknown ? Value : never,
  ): void => {
    const nextScopes = backgroundScopesRef.current.filter(
      (scope) => !releasedScopeMatches(release, scope.threadId, scope.workspaceId),
    );
    if (nextScopes.length !== backgroundScopesRef.current.length) {
      backgroundScopesRef.current = nextScopes;
      setBackgroundScopes(nextScopes);
      useBrowserAutomationStore.getState().setHostedScopeIds(
        new Set(nextScopes.map((scope) => browserAutomationScopeKey(scope.workspaceId, scope.threadId))),
      );
    }
  };

  const removeReleasedPersistentTabs = (
    release: Parameters<typeof onBrowserAutomationScopeRelease>[0] extends (value: infer Value) => unknown ? Value : never,
  ): void => {
    for (const tab of persistentWebTabsRef.current.values()) {
      if (releasedScopeMatches(release, tab.threadId, tab.workspaceId)) {
        removePersistentWebTab(tab.workspaceId, tab.threadId, tab.tabId);
      }
    }
  };

  const cancelReleasedBootstrapRequests = (
    release: Parameters<typeof onBrowserAutomationScopeRelease>[0] extends (value: infer Value) => unknown ? Value : never,
  ): void => {
    const lease = leaseRef.current;
    for (const [key, request] of bootstrapRequestRef.current) {
      if (!releasedScopeMatches(release, request.threadId, request.workspaceId)) continue;
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
  };

  const cancelReleasedHostedRequests = (
    release: Parameters<typeof onBrowserAutomationScopeRelease>[0] extends (value: infer Value) => unknown ? Value : never,
  ): void => {
    const lease = leaseRef.current;
    for (const [key, dispatch] of inFlightRef.current) {
      if (!releasedScopeMatches(release, dispatch.scope.threadId, dispatch.scope.workspaceId)) continue;
      cancelHostedRequest(key, dispatch, "host-shutdown", lease);
    }
  };

  const handleScopeRelease = (
    release: Parameters<typeof onBrowserAutomationScopeRelease>[0] extends (value: infer Value) => unknown ? Value : never,
  ): void => {
    releaseBrowserDriverScope(release);
    removeReleasedBackgroundScopes(release);
    removeReleasedPersistentTabs(release);
    cancelReleasedBootstrapRequests(release);
    cancelReleasedHostedRequests(release);
  };

  useEffect(() => onBrowserAutomationScopeRelease((release) => {
    handleScopeRelease(release);
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
