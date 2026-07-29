import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
  BROWSER_AUTOMATION_OPERATIONS,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationRequestSchema,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationHostDispatchTarget,
  type BrowserAutomationOperation,
  type BrowserAutomationResponse,
  type BrowserAutomationRequest,
  type BrowserAutomationTargetIdentity,
} from "@mcode/contracts";
import { getTransport, pushEmitter } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  browserAutomationRequestKey,
  browserAutomationTargetKey,
  onBrowserAutomationInterruption,
  onBrowserAutomationScopeRelease,
  resolveBrowserAutomationControllerTarget,
  useBrowserAutomationStore,
} from "@/stores/browserAutomationStore";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewTabsStore } from "@/stores/previewTabsStore";
import { BrowserAutomationRecorder } from "./browserAutomationRecorder";
import { PreviewPanel } from "./PreviewPanel";
import type { PreviewAutomationBridge } from "@/transport/desktop-bridge";
import { isBrowserAutomationWebRuntimeEnabled } from "./browserAutomationRuntime";

const HEARTBEAT_INTERVAL_MS = 10_000;
const UNAVAILABLE_OPERATIONS = new Map<BrowserAutomationOperation, string>([
]);

const WEB_AUTOMATION_UNAVAILABLE_REASON = "Web automation executor is unavailable";

export { isBrowserAutomationWebRuntimeEnabled } from "./browserAutomationRuntime";

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
  code: "INVALID_REQUEST" | "TAB_UNAVAILABLE" | "INTERNAL_ERROR",
  message: string,
): BrowserAutomationResponse {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: request.requestId,
    sequence: request.sequence,
    ok: false,
    error: { code, message, retryable: code !== "INVALID_REQUEST" },
  };
}

async function afterBrowserLayout(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function executeBrowserDispatch(
  bridge: PreviewAutomationBridge,
  recorder: BrowserAutomationRecorder,
  dispatch: BrowserAutomationHostDispatch,
): Promise<BrowserAutomationResponse> {
  const rendererOwned = dispatch.request.operation === "resize" ||
    dispatch.request.operation === "recordingStart" ||
    dispatch.request.operation === "recordingStop";
  if (rendererOwned) {
    const lease = await bridge.beginRendererOperation(dispatch);
    if (!lease.ok) return lease.response;
    let response: BrowserAutomationResponse;
    try {
      if (dispatch.request.operation === "resize") {
    useBrowserAutomationStore.getState().setViewport(
      dispatch.target.threadId,
      dispatch.target.tabId,
      dispatch.request.args.width,
      dispatch.request.args.height,
    );
    await afterBrowserLayout();
    const key = browserAutomationTargetKey(dispatch.target.threadId, dispatch.target.tabId);
    const applied = useBrowserAutomationStore.getState().viewportByTarget.get(key);
        if (!applied) {
          response = failureResponse(dispatch.request, "TAB_UNAVAILABLE", "Browser viewport target is unavailable");
        } else response = {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: true,
      result: {
        operation: "resize",
        width: applied.width,
        height: applied.height,
        controlEpoch: dispatch.request.expectedControlEpoch,
      },
        };
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
      capabilities: BROWSER_AUTOMATION_OPERATIONS.filter((operation) =>
        recordingAvailable() || (operation !== "recordingStart" && operation !== "recordingStop"),
      ),
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
  threadId: string,
  tabId: string,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  const key = browserAutomationTargetKey(threadId, tabId);
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

interface HostLease {
  readonly hostId: string;
  readonly generation: number;
  readonly desktopInstanceId: string;
  readonly epoch: number;
}

interface BackgroundBrowserScope {
  readonly threadId: string;
  readonly workspaceId: string;
}

interface PersistentSurfaceLayout {
  readonly visible: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function findAutomationDock(threadId: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>("[data-automation-preview-dock]")]
    .find((candidate) =>
      candidate.dataset.automationPreviewDock === threadId && candidate.dataset.visible === "true",
    ) ?? null;
}

/** Keeps one exact automation PreviewPanel mounted while moving it into its visible dock. */
function PersistentAutomationPreviewSurface({ scope }: { readonly scope: BackgroundBrowserScope }) {
  const [layout, setLayout] = useState<PersistentSurfaceLayout>({
    visible: false,
    left: -20_000,
    top: 0,
    width: 1_280,
    height: 720,
  });

  useEffect(() => {
    let observedDock: HTMLElement | null = null;
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => update())
      : null;
    const update = () => {
      const dock = findAutomationDock(scope.threadId);
      if (dock !== observedDock) {
        resizeObserver?.disconnect();
        observedDock = dock;
        if (dock) resizeObserver?.observe(dock);
      }
      const rect = dock?.getBoundingClientRect();
      const next: PersistentSurfaceLayout = rect && rect.width > 0 && rect.height > 0
        ? { visible: true, left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : { visible: false, left: -20_000, top: 0, width: 1_280, height: 720 };
      setLayout((current) => (
        current.visible === next.visible && current.left === next.left && current.top === next.top &&
        current.width === next.width && current.height === next.height ? current : next
      ));
    };
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-visible"],
    });
    window.addEventListener("resize", update);
    update();
    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [scope.threadId]);

  return (
    <div
      data-automation-persistent-scope={scope.threadId}
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
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const liveTargets = useBrowserAutomationStore((state) => state.liveTargets);
  const registered = useBrowserAutomationStore((state) => state.registered);
  const leaseRef = useRef<HostLease | null>(null);
  const shutdownLeaseRef = useRef<HostLease | null>(null);
  const recorderRef = useRef(new BrowserAutomationRecorder());
  const registrationEpochRef = useRef(0);
  const inFlightRef = useRef(new Map<string, BrowserAutomationHostDispatch>());
  const bootstrapPendingRef = useRef(new Set<string>());
  const bootstrapAbortRef = useRef(new Map<string, AbortController>());
  const bootstrapRequestRef = useRef(new Map<string, BrowserAutomationRequest>());
  const priorLiveTargetKeysRef = useRef(new Set<string>());
  const cancelledRef = useRef(new Set<string>());
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
      new Set(backgroundScopes.map((scope) => scope.threadId)),
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
    const transport = getTransport();
    const liveTargetSnapshot = useBrowserAutomationStore.getState().liveTargets;
    const activeTarget = [...liveTargetSnapshot.values()].find((target) => target.workspaceId === activeWorkspaceId);
    const worktreeIdentity = import.meta.env.VITE_MCODE_WORKTREE_IDENTITY?.trim() || "web-runtime";
    void transport.registerBrowserAutomationHost({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      hostId: stableHostId,
      runtime: desktopAutomation ? "electron" : "web",
      desktopInstanceId: "pending-desktop",
      worktreeIdentity: desktopAutomation ? "pending-worktree" : worktreeIdentity,
      workspaceIds,
      ...(activeTarget && !desktopAutomation && webAutomationEnabled ? {
        targetIdentity: webTargetIdentity(worktreeIdentity, "pending-desktop", activeTarget),
      } : {}),
      capabilities: BROWSER_AUTOMATION_OPERATIONS.map((operation) => {
        if (!desktopAutomation) {
          return { operation, available: false, unavailableReason: WEB_AUTOMATION_UNAVAILABLE_REASON };
        }
        const recordingUnavailable =
          (operation === "recordingStart" || operation === "recordingStop") &&
          !recordingAvailable();
        const unavailableReason = UNAVAILABLE_OPERATIONS.get(operation) ??
          (recordingUnavailable ? "Visible tab recording is unavailable in this renderer" : undefined);
        return unavailableReason
          ? { operation, available: false, unavailableReason }
          : { operation, available: true };
      }),
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
        useBrowserAutomationStore.getState().setRegistered(false);
        useBrowserAutomationStore.getState().setStatus("unavailable");
      }
    };
  }, [cancelHostedRequest, connectionStatus, stableHostId, workspaceSignature]);

  useEffect(() => {
    const lease = leaseRef.current;
    if (!lease || connectionStatus !== "connected") return;
    let cancelled = false;
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge && !isBrowserAutomationWebRuntimeEnabled()) return;
    if (!bridge) {
      const targets = [...liveTargets.values()].slice(0, 64).map((candidate) => ({
        desktopInstanceId: lease.desktopInstanceId,
        windowId: 1,
        connectionGeneration: lease.generation,
        threadId: candidate.threadId,
        tabId: candidate.tabId,
        targetGeneration: Math.max(1, candidate.revision),
        active: candidate.threadId === useWorkspaceStore.getState().activeThreadId,
        focused: candidate.threadId === useWorkspaceStore.getState().activeThreadId,
        lastUsedAt: candidate.lastUsedAt,
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
    void Promise.all(targets.map(async (candidate) => {
      const described = await bridge.describeTarget({
        threadId: candidate.threadId,
        tabId: candidate.tabId,
      });
      if (!described.ok) return null;
      return {
        ...described.target,
        desktopInstanceId: lease.desktopInstanceId,
        connectionGeneration: lease.generation,
      } satisfies BrowserAutomationHostDispatchTarget;
    })).then((resolved) => {
      if (cancelled || leaseRef.current !== lease) return;
      return getTransport().updateBrowserAutomationHostTargets(
        lease.hostId,
        lease.generation,
        resolved.filter((target): target is BrowserAutomationHostDispatchTarget => target !== null),
      );
    }).catch(() => {
      // A replacement or release can race target discovery. The next registry
      // revision retries with desktop-main identity as the source of truth.
    });
    return () => {
      cancelled = true;
    };
  }, [cancelHostedRequest, connectionStatus, liveTargets, registered]);

  useEffect(() => {
    const next = new Set(liveTargets.keys());
    for (const removed of priorLiveTargetKeysRef.current) {
      if (next.has(removed)) continue;
      const [threadId, tabId] = JSON.parse(removed) as [string, string];
      recorderRef.current.disposeTarget(threadId, tabId);
      for (const [key, dispatch] of inFlightRef.current) {
        if (dispatch.target.threadId !== threadId || dispatch.target.tabId !== tabId) continue;
        cancelHostedRequest(key, dispatch, "host-shutdown");
      }
    }
    priorLiveTargetKeysRef.current = next;
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
    if (!bridge) return;
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
      void executeBrowserDispatch(bridge, recorderRef.current, dispatch).then((response) => {
        if (leaseRef.current !== lease || cancelledRef.current.has(key)) return;
        return getTransport().respondToBrowserAutomationRequest(
          lease.hostId,
          lease.generation,
          response,
        );
      }).catch(() => undefined).finally(() => {
        if (inFlightRef.current.get(key) === dispatch) inFlightRef.current.delete(key);
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
      recorderRef.current.cancel(inFlightRef.current.get(key)!);
      void bridge.cancel(payload.requestId);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeCancel();
    };
  }, [cancelHostedRequest]);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge) return;
    return pushEmitter.on("browserAutomation.bootstrap", (input) => {
      const payload = input as { hostId?: unknown; generation?: unknown; request?: unknown };
      const lease = leaseRef.current;
      const parsed = BrowserAutomationRequestSchema().safeParse(payload.request);
      if (
        !lease || payload.hostId !== lease.hostId || payload.generation !== lease.generation ||
        !parsed.success || parsed.data.operation !== "open"
      ) return;
      const request = parsed.data;
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
      const previousTabId = usePreviewTabsStore.getState().tabSetByScope[request.threadId]?.activeTabId ?? null;
      const previousPanel = useDiffStore.getState().getRightPanel(request.workspaceId, request.threadId);
      let backgroundContextRestored = false;
      let createdTabId: string | null = null;
      let bootstrapSucceeded = false;
      let visibleContextModified = false;
      const restoreBackgroundContext = async () => {
        if (request.args.activate || backgroundContextRestored) return;
        backgroundContextRestored = true;
        if (createdTabId && previousTabId && previousTabId !== createdTabId) {
          await usePreviewTabsStore.getState().activatePage(request.threadId, previousTabId);
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
        const existingScope = currentScopes.find((scope) => scope.threadId === request.threadId);
        if (existingScope) {
          const nextScopes = [
            ...currentScopes.filter((scope) => scope.threadId !== request.threadId),
            existingScope,
          ];
          backgroundScopesRef.current = nextScopes;
          setBackgroundScopes(nextScopes);
        } else {
          const isBusy = (scope: BackgroundBrowserScope): boolean =>
            [...bootstrapRequestRef.current.values()].some(
              (candidate) => candidate.threadId === scope.threadId,
            ) || [...inFlightRef.current.values()].some(
              (candidate) => candidate.scope.threadId === scope.threadId,
            ) || recorderRef.current.hasActiveThread(scope.threadId) ||
            findAutomationDock(scope.threadId) !== null;
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
          backgroundScopesRef.current = nextScopes;
          useBrowserAutomationStore.getState().setHostedScopeIds(
            new Set(nextScopes.map((scope) => scope.threadId)),
          );
          setBackgroundScopes(nextScopes);
        }
        if (ownsVisibleContext) {
          visibleContextModified = true;
          diff.showRightPanel(request.workspaceId, request.threadId);
          diff.setRightPanelTab(request.workspaceId, request.threadId, "preview");
        }
        await afterBrowserLayout();
        const listed = await window.desktopBridge?.preview?.tabs.list?.(request.threadId);
        if (listed?.ok && listed.data.threadId === request.threadId) {
          usePreviewTabsStore.getState().setTabSet(request.threadId, listed.data);
        }
        const existingSet = usePreviewTabsStore.getState().tabSetByScope[request.threadId];
        let tabId = existingSet?.activeTabId || existingSet?.tabs[0]?.id || null;
        if (!tabId) {
          tabId = await usePreviewTabsStore.getState().createPage(request.threadId, {
            focusOmnibox: ownsVisibleContext && request.args.activate,
          });
          if (tabId) createdTabId = tabId;
        }
        if (!tabId) throw new Error("Browser tab could not be created or restored");
        const selectedTab = existingSet?.tabs.find((tab) => tab.id === tabId);
        if (!selectedTab?.url) {
          usePreviewTabsStore.getState().updateTabChrome(request.threadId, tabId, {
            title: null,
            url: "about:blank",
            favicon: null,
          });
          diff.setPreviewUrlForThread(request.threadId, "about:blank");
        }
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        await waitForLiveTarget(request.threadId, tabId, request.deadline, controller.signal);
        ensureActive();
        const described = await bridge.describeTarget({ threadId: request.threadId, tabId });
        if (!described.ok) throw new Error("Browser target could not be described");
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
        const response = await executeBrowserDispatch(bridge, recorderRef.current, dispatch);
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
      }).finally(() => {
        void restoreBackgroundContext();
        if (createdTabId && !bootstrapSucceeded) {
          void window.desktopBridge?.preview?.tabs.close?.(request.threadId, createdTabId);
        }
        window.clearTimeout(deadlineTimer);
        if (bootstrapAbortRef.current.get(key) === controller) bootstrapAbortRef.current.delete(key);
        bootstrapPendingRef.current.delete(key);
        bootstrapRequestRef.current.delete(key);
        inFlightRef.current.delete(key);
        cancelledRef.current.delete(key);
      });
    });
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.automation;
    if (!bridge) return;
    return bridge.onControllerChanged((controller) => {
      useBrowserAutomationStore.getState().setController(controller);
      if (controller.controller !== "human") return;
      const target = resolveBrowserAutomationControllerTarget(
        useBrowserAutomationStore.getState().liveTargets.values(),
        controller,
      );
      if (!target) return;
      recorderRef.current.disposeTarget(target.threadId, target.tabId);
      for (const dispatch of inFlightRef.current.values()) {
        if (dispatch.target.threadId !== target.threadId || dispatch.target.tabId !== target.tabId) continue;
        const lease = leaseRef.current;
        if (!lease) continue;
        const key = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
        cancelHostedRequest(key, dispatch, "human-interrupted", lease);
      }
    });
  }, [cancelHostedRequest]);

  useEffect(() => onBrowserAutomationInterruption((threadId, tabId, reason) => {
    recorderRef.current.disposeTarget(threadId, tabId);
    for (const dispatch of inFlightRef.current.values()) {
      if (dispatch.target.threadId !== threadId || dispatch.target.tabId !== tabId) continue;
      const lease = leaseRef.current;
      if (!lease) continue;
      const key = browserAutomationRequestKey(dispatch.request.requestId, dispatch.request.sequence);
      cancelHostedRequest(key, dispatch, reason, lease);
    }
  }), [cancelHostedRequest]);

  useEffect(() => onBrowserAutomationScopeRelease((release) => {
    const matches = (threadId: string, workspaceId: string): boolean =>
      release.threadId !== undefined ? threadId === release.threadId : workspaceId === release.workspaceId;
    const nextScopes = backgroundScopesRef.current.filter(
      (scope) => !matches(scope.threadId, scope.workspaceId),
    );
    if (nextScopes.length !== backgroundScopesRef.current.length) {
      backgroundScopesRef.current = nextScopes;
      setBackgroundScopes(nextScopes);
      useBrowserAutomationStore.getState().setHostedScopeIds(
        new Set(nextScopes.map((scope) => scope.threadId)),
      );
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
    recorderRef.current.dispose();
  }, []);

  return backgroundScopes.map((scope) => (
    <PersistentAutomationPreviewSurface key={scope.threadId} scope={scope} />
  ));
}
