import {
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationRequestSchema,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationHostDispatchTarget,
  type BrowserAutomationRequest,
} from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { isEmptyPreviewTabUrl } from "@/features/preview/navigation/open-url-in-preview";
import { previewTabsScopeKey, usePreviewTabsStore } from "@/features/preview/state/previewTabsStore";
import { WEB_RUNTIME_PREVIEW_TAB_ID } from "../surfaces/PreviewPanel";
import type { PreviewAutomationBridge } from "@/transport/desktop-bridge";
import { browserAutomationRequestKey, browserAutomationTargetKey, useBrowserAutomationStore } from "./browserAutomationStore";
import { failureResponse, projectAgentControl } from "./browserAutomationHostExecution";
import { normalizeWebPreviewUrl, } from "./browserAutomationRuntime";
import { waitForWebPreviewIframe } from "./browserAutomationHostNavigation";
import type { BrowserSessionDriver } from "./services/browserSessionDriver";
import type { BrowserAutomationHostLease } from "./services/browserAutomationHostSupervisor";
import { waitForViewportLayout } from "./services/viewportCoordinatorFactory";

const TARGET_DISCOVERY_RETRY_MS = 50;

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

interface AutomationTargetRef {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
}

/** Hold the mutable request state shared by browser bootstrap work. */
export interface BrowserAutomationBootstrapLifecycleState {
  readonly inFlight: Map<string, BrowserAutomationHostDispatch>;
  readonly requestAbort: Map<string, AbortController>;
  readonly cancelled: Set<string>;
  readonly bootstrapPending: Set<string>;
  readonly bootstrapAbort: Map<string, AbortController>;
  readonly bootstrapRequest: Map<string, BrowserAutomationRequest>;
  readonly agentOpenTabs: Map<string, AutomationTargetRef>;
  readonly persistentWebTabs: Map<string, PersistentAutomationWebTab>;
}

/** Supply host-owned state and UI operations to the bootstrap lifecycle. */
export interface BrowserAutomationBootstrapLifecycleDependencies {
  readonly bridge: PreviewAutomationBridge | undefined;
  readonly sessionDriver: BrowserSessionDriver;
  readonly state: BrowserAutomationBootstrapLifecycleState;
  readonly getLease: () => BrowserAutomationHostLease | null;
  readonly getBackgroundScopes: () => readonly BackgroundBrowserScope[];
  readonly setCurrentBackgroundScopes: (scopes: readonly BackgroundBrowserScope[]) => void;
  readonly setRenderedBackgroundScopes: (scopes: readonly BackgroundBrowserScope[]) => void;
  readonly setHostedScopeIds: (scopes: readonly BackgroundBrowserScope[]) => void;
  readonly isScopeBusy: (scope: BackgroundBrowserScope) => boolean;
  readonly addPersistentWebTab: (tab: PersistentAutomationWebTab) => void;
  readonly removePersistentWebTab: (workspaceId: string, threadId: string, tabId: string) => void;
}

interface BootstrapRun {
  readonly request: Extract<BrowserAutomationRequest, { readonly operation: "open" }>;
  readonly key: string;
  readonly lease: BrowserAutomationHostLease;
  readonly controller: AbortController;
  readonly agentOwnedOpen: boolean;
  readonly agentOpenKey: string | null;
  readonly previousTabId: string | null;
  readonly previousPanel: ReturnType<ReturnType<typeof useDiffStore.getState>["getRightPanel"]>;
  readonly state: BootstrapRunState;
}

interface BootstrapRunState {
  backgroundContextRestored: boolean;
  createdTabId: string | null;
  createdWebTabId: string | undefined;
  bootstrapSucceeded: boolean;
  visibleContextModified: boolean;
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
    const unsubscribe = useBrowserAutomationStore.subscribe((store) => {
      if (!store.liveTargets.has(key)) return;
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

function assertActive(run: BootstrapRun): void {
  if (run.controller.signal.aborted) throw run.controller.signal.reason;
}

function assertWorkspaceAvailable(request: BrowserAutomationRequest): void {
  if (!useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === request.workspaceId)) {
    throw new Error("Browser workspace is unavailable");
  }
}

function ownsVisibleContext(request: BrowserAutomationRequest): boolean {
  const workspace = useWorkspaceStore.getState();
  return workspace.activeWorkspaceId === request.workspaceId && workspace.activeThreadId === request.threadId;
}

function isBusyScope(
  scope: BackgroundBrowserScope,
  state: BrowserAutomationBootstrapLifecycleState,
  dependencies: BrowserAutomationBootstrapLifecycleDependencies,
): boolean {
  return [...state.bootstrapRequest.values()].some(
    (request) => request.workspaceId === scope.workspaceId && request.threadId === scope.threadId,
  ) || [...state.inFlight.values()].some(
    (dispatch) => dispatch.scope.workspaceId === scope.workspaceId && dispatch.scope.threadId === scope.threadId,
  ) || dependencies.isScopeBusy(scope);
}

function moveExistingScope(
  scope: BackgroundBrowserScope,
  dependencies: BrowserAutomationBootstrapLifecycleDependencies,
): void {
  const currentScopes = dependencies.getBackgroundScopes();
  const nextScopes = [
    ...currentScopes.filter((candidate) => candidate !== scope),
    scope,
  ];
  dependencies.setCurrentBackgroundScopes(nextScopes);
  dependencies.setRenderedBackgroundScopes(nextScopes);
}

function evictPersistentTabs(
  scope: BackgroundBrowserScope,
  dependencies: BrowserAutomationBootstrapLifecycleDependencies,
): void {
  for (const tab of dependencies.state.persistentWebTabs.values()) {
    if (tab.workspaceId === scope.workspaceId && tab.threadId === scope.threadId) {
      dependencies.removePersistentWebTab(tab.workspaceId, tab.threadId, tab.tabId);
    }
  }
}

function addBackgroundScope(
  request: BrowserAutomationRequest,
  dependencies: BrowserAutomationBootstrapLifecycleDependencies,
): void {
  const currentScopes = dependencies.getBackgroundScopes();
  const evicted = currentScopes.length >= 5
    ? currentScopes.find((scope) => !isBusyScope(scope, dependencies.state, dependencies))
    : undefined;
  if (currentScopes.length >= 5 && !evicted) {
    throw new Error("Browser automation has reached its five-thread surface limit");
  }
  const nextScopes = [
    ...currentScopes.filter((scope) => scope !== evicted),
    { threadId: request.threadId, workspaceId: request.workspaceId },
  ];
  if (evicted) evictPersistentTabs(evicted, dependencies);
  dependencies.setCurrentBackgroundScopes(nextScopes);
  dependencies.setHostedScopeIds(nextScopes);
  dependencies.setRenderedBackgroundScopes(nextScopes);
}

function ensureBackgroundScope(
  request: BrowserAutomationRequest,
  dependencies: BrowserAutomationBootstrapLifecycleDependencies,
): void {
  const existingScope = dependencies.getBackgroundScopes().find(
    (scope) => scope.workspaceId === request.workspaceId && scope.threadId === request.threadId,
  );
  if (existingScope) return moveExistingScope(existingScope, dependencies);
  addBackgroundScope(request, dependencies);
}

function showVisibleContext(
  run: BootstrapRun,
  visibleContext: boolean,
): void {
  if (!visibleContext || run.agentOwnedOpen) return;
  run.state.visibleContextModified = true;
  const diff = useDiffStore.getState();
  diff.showRightPanel(run.request.workspaceId, run.request.threadId);
  diff.setRightPanelTab(run.request.workspaceId, run.request.threadId, "preview");
}

function createBackgroundContextRestorer(run: BootstrapRun): () => Promise<void> {
  return async () => {
    if (run.agentOwnedOpen || run.request.args.activate || run.state.backgroundContextRestored) return;
    run.state.backgroundContextRestored = true;
    await restorePreviousTab(run);
    restorePreviousPanel(run);
  };
}

async function restorePreviousTab(run: BootstrapRun): Promise<void> {
  if (!run.state.createdTabId || !run.previousTabId || run.previousTabId === run.state.createdTabId) return;
  await usePreviewTabsStore.getState().activatePage(run.request.workspaceId, run.request.threadId, run.previousTabId);
}

function restorePreviousPanel(run: BootstrapRun): void {
  if (!run.state.visibleContextModified) return;
  const diff = useDiffStore.getState();
  if (!run.previousPanel.openTabs.includes("preview")) {
    diff.closeRightPanelTab(run.request.workspaceId, run.request.threadId, "preview");
  }
  if (run.previousPanel.openTabs.includes(run.previousPanel.activeTab)) {
    diff.setRightPanelTab(run.request.workspaceId, run.request.threadId, run.previousPanel.activeTab);
  }
  if (run.previousPanel.visible) diff.showRightPanel(run.request.workspaceId, run.request.threadId);
  else diff.hideRightPanel(run.request.workspaceId, run.request.threadId);
}

async function refreshDesktopTabSet(request: BrowserAutomationRequest): Promise<void> {
  const listed = await window.desktopBridge?.preview?.tabs.list?.(request.threadId, request.workspaceId);
  if (listed?.ok && listed.data.threadId === request.threadId) {
    usePreviewTabsStore.getState().setTabSet(request.workspaceId, request.threadId, listed.data);
  }
}

function requestedWebUrl(
  request: Extract<BrowserAutomationRequest, { readonly operation: "open" }>,
  bridge: PreviewAutomationBridge | undefined,
): string | undefined {
  return !bridge && request.args.url ? normalizeWebPreviewUrl(request.args.url) ?? undefined : undefined;
}

function currentTabSet(request: BrowserAutomationRequest) {
  return usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey(request.workspaceId, request.threadId)];
}

function existingTabId(
  run: BootstrapRun,
  tabSet: ReturnType<typeof currentTabSet>,
): string | null {
  if (run.agentOwnedOpen) return existingAgentTabId(run);
  const tabId = tabSet?.activeTabId || tabSet?.tabs[0]?.id;
  if (tabId) return tabId;
  return runDependencies(run).bridge ? null : WEB_RUNTIME_PREVIEW_TAB_ID;
}

function existingAgentTabId(run: BootstrapRun): string | null {
  if (!run.agentOpenKey) return null;
  return runDependencies(run).state.agentOpenTabs.get(run.agentOpenKey)?.tabId ?? null;
}

const bootstrapDependencies = new WeakMap<BootstrapRun, BrowserAutomationBootstrapLifecycleDependencies>();

function runDependencies(run: BootstrapRun): BrowserAutomationBootstrapLifecycleDependencies {
  return bootstrapDependencies.get(run)!;
}

function createAgentWebTab(run: BootstrapRun, url: string | undefined): string {
  const tabId = `web-agent-${globalThis.crypto.randomUUID()}`;
  const dependencies = runDependencies(run);
  run.state.createdWebTabId = tabId;
  if (run.agentOpenKey) {
    dependencies.state.agentOpenTabs.set(run.agentOpenKey, {
      workspaceId: run.request.workspaceId,
      threadId: run.request.threadId,
      tabId,
    });
  }
  dependencies.addPersistentWebTab({
    threadId: run.request.threadId,
    workspaceId: run.request.workspaceId,
    tabId,
    url: url ?? `${window.location.origin}/browser-automation-fixture.html`,
  });
  return tabId;
}

function reusableEmptyTabId(
  run: BootstrapRun,
  tabSet: ReturnType<typeof currentTabSet>,
): string | undefined {
  const onlyExistingTab = tabSet?.tabs.length === 1 ? tabSet.tabs[0] : undefined;
  const browserPanelWasVisible = run.previousPanel.visible && run.previousPanel.openTabs.includes("preview");
  return run.agentOwnedOpen && !browserPanelWasVisible && onlyExistingTab && isEmptyPreviewTabUrl(onlyExistingTab.url) && !onlyExistingTab.title && !onlyExistingTab.faviconUrl
    ? onlyExistingTab.id
    : undefined;
}

async function openBrowserTab(run: BootstrapRun, visibleContext: boolean, tabSet: ReturnType<typeof currentTabSet>): Promise<string | null> {
  const reusableTabId = reusableEmptyTabId(run, tabSet);
  const tabs = usePreviewTabsStore.getState();
  let tabId = await tabs.openPage(run.request.workspaceId, run.request.threadId, {
    activate: !run.agentOwnedOpen,
    focusOmnibox: visibleContext && run.request.args.activate && !run.agentOwnedOpen,
    ...(reusableTabId ? { tabId: reusableTabId } : {}),
  });
  if (!tabId && reusableTabId) {
    tabId = await tabs.openPage(run.request.workspaceId, run.request.threadId, {
      activate: false,
      focusOmnibox: false,
    });
  }
  if (!tabId) return null;
  run.state.createdTabId = tabId;
  if (run.agentOpenKey) {
    runDependencies(run).state.agentOpenTabs.set(run.agentOpenKey, {
      workspaceId: run.request.workspaceId,
      threadId: run.request.threadId,
      tabId,
    });
  }
  return tabId;
}

async function resolveBootstrapTab(
  run: BootstrapRun,
  visibleContext: boolean,
  url: string | undefined,
): Promise<string> {
  const tabSet = currentTabSet(run.request);
  let tabId = existingTabId(run, tabSet);
  const dependencies = runDependencies(run);
  if (!dependencies.bridge && run.agentOwnedOpen && !tabId) tabId = createAgentWebTab(run, url);
  if (!tabId) tabId = await openBrowserTab(run, visibleContext, tabSet);
  if (!tabId) throw new Error("Browser tab could not be created or restored");
  return tabId;
}

function setPendingAgentOpen(run: BootstrapRun, tabId: string): void {
  if (!run.agentOwnedOpen) return;
  useBrowserAutomationStore.getState().setPendingAgentOpen(run.request.requestId, run.request.sequence, {
    workspaceId: run.request.workspaceId,
    threadId: run.request.threadId,
    tabId,
    url: run.request.args.url ?? null,
    startedAt: Date.now(),
  });
}

function updateTabChrome(
  run: BootstrapRun,
  tabId: string,
  url: string | undefined,
): void {
  const tab = currentTabSet(run.request)?.tabs.find((candidate) => candidate.id === tabId);
  const existingUrl = tab?.url ?? undefined;
  if (!shouldUpdateTabChrome(run, existingUrl, url)) return;
  const initialUrl = initialTabUrl(run, existingUrl, url);
  usePreviewTabsStore.getState().updateTabChrome(run.request.workspaceId, run.request.threadId, tabId, {
    title: null,
    url: initialUrl,
    favicon: null,
  });
  updateVisiblePreviewUrl(run, initialUrl);
}

function initialTabUrl(
  run: BootstrapRun,
  existingUrl: string | undefined,
  url: string | undefined,
): string {
  const requestedUrl = run.agentOwnedOpen ? run.request.args.url ?? undefined : undefined;
  return url ?? requestedUrl ?? existingUrl ?? "about:blank";
}

function updateVisiblePreviewUrl(run: BootstrapRun, url: string): void {
  if (!run.agentOwnedOpen) useDiffStore.getState().setPreviewUrlForThread(run.request.threadId, url);
}

function shouldUpdateTabChrome(
  run: BootstrapRun,
  existingUrl: string | undefined,
  url: string | undefined,
): boolean {
  if (runDependencies(run).bridge && run.agentOwnedOpen) return false;
  return !existingUrl || Boolean(url) || Boolean(run.request.args.url);
}

async function waitForBootstrapTarget(run: BootstrapRun, tabId: string, url: string | undefined): Promise<void> {
  const dependencies = runDependencies(run);
  if (!dependencies.bridge && url) {
    await waitForWebPreviewIframe(run.request.workspaceId, run.request.threadId, tabId, url, run.request.deadline, run.controller.signal);
    assertActive(run);
  }
  await waitForLiveTarget(run.request.workspaceId, run.request.threadId, tabId, run.request.deadline, run.controller.signal);
  assertActive(run);
}

async function describeBootstrapTarget(run: BootstrapRun, tabId: string): Promise<BrowserAutomationHostDispatchTarget> {
  const dependencies = runDependencies(run);
  const target = dependencies.bridge
    ? await waitForDesktopTarget(dependencies.bridge, run.request.threadId, tabId, run.request.deadline, run.controller.signal)
    : {
        windowId: 1,
        threadId: run.request.threadId,
        tabId,
        targetGeneration: useBrowserAutomationStore.getState().liveTargets.get(
          browserAutomationTargetKey(run.request.workspaceId, run.request.threadId, tabId),
        )?.revision ?? 1,
        active: !run.agentOwnedOpen,
        focused: !run.agentOwnedOpen,
        lastUsedAt: Date.now(),
      };
  return {
    ...target,
    desktopInstanceId: run.lease.desktopInstanceId,
    connectionGeneration: run.lease.generation,
  };
}

function bootstrapDispatch(run: BootstrapRun, target: BrowserAutomationHostDispatchTarget): BrowserAutomationHostDispatch {
  return BrowserAutomationHostDispatchSchema().parse({
    scope: {
      workspaceId: run.request.workspaceId,
      threadId: run.request.threadId,
      providerSessionId: run.request.providerSessionId,
      providerInstanceId: run.request.providerInstanceId,
    },
    connection: {
      desktopInstanceId: target.desktopInstanceId,
      windowId: target.windowId,
      connectionGeneration: target.connectionGeneration,
      targetGeneration: target.targetGeneration,
    },
    request: run.request,
    target,
  });
}

function bootstrapExecutionDispatch(run: BootstrapRun, dispatch: BrowserAutomationHostDispatch, url: string | undefined): BrowserAutomationHostDispatch {
  if (runDependencies(run).bridge || !url) return dispatch;
  return {
    ...dispatch,
    request: {
      ...dispatch.request,
      args: {
        activate: run.request.args.activate,
        ...(run.request.args.idempotencyKey ? { idempotencyKey: run.request.args.idempotencyKey } : {}),
      },
    },
  };
}

async function executeBootstrap(run: BootstrapRun): Promise<void> {
  assertActive(run);
  assertWorkspaceAvailable(run.request);
  const visibleContext = ownsVisibleContext(run.request);
  const dependencies = runDependencies(run);
  ensureBackgroundScope(run.request, dependencies);
  showVisibleContext(run, visibleContext);
  await waitForViewportLayout(2);
  await refreshDesktopTabSet(run.request);
  const url = requestedWebUrl(run.request, dependencies.bridge);
  const tabId = await resolveBootstrapTab(run, visibleContext, url);
  setPendingAgentOpen(run, tabId);
  updateTabChrome(run, tabId, url);
  assertActive(run);
  await waitForBootstrapTarget(run, tabId, url);
  const target = await describeBootstrapTarget(run, tabId);
  assertActive(run);
  const dispatch = bootstrapDispatch(run, target);
  dependencies.state.inFlight.set(run.key, dispatch);
  dependencies.state.requestAbort.set(run.key, run.controller);
  const executionDispatch = bootstrapExecutionDispatch(run, dispatch, url);
  projectAgentControl(executionDispatch);
  const response = await dependencies.sessionDriver.execute(executionDispatch, run.controller.signal);
  await createBackgroundContextRestorer(run)();
  if (dependencies.getLease() !== run.lease || dependencies.state.cancelled.has(run.key)) return;
  await getTransport().respondToBrowserAutomationRequest(run.lease.hostId, run.lease.generation, response, target);
  run.state.bootstrapSucceeded = true;
}

async function finalizeBootstrap(
  run: BootstrapRun,
  restoreBackgroundContext: () => Promise<void>,
): Promise<void> {
  const dependencies = runDependencies(run);
  try {
    await restoreBackgroundContext();
  } catch {
    // Restoration failure must not skip closing a tab created for this bootstrap.
  }
  if (run.state.createdTabId && !run.state.bootstrapSucceeded) {
    try {
      await usePreviewTabsStore.getState().closePage(run.request.workspaceId, run.request.threadId, run.state.createdTabId);
    } catch {
      // Keep finalizer cleanup settled; closePage preserves logical records on physical failure.
    }
  }
  if (run.state.createdWebTabId && !run.state.bootstrapSucceeded) {
    dependencies.removePersistentWebTab(run.request.workspaceId, run.request.threadId, run.state.createdWebTabId);
  }
  if (!run.state.bootstrapSucceeded && run.agentOpenKey) dependencies.state.agentOpenTabs.delete(run.agentOpenKey);
  if (dependencies.state.bootstrapAbort.get(run.key) === run.controller) dependencies.state.bootstrapAbort.delete(run.key);
  dependencies.state.bootstrapPending.delete(run.key);
  dependencies.state.bootstrapRequest.delete(run.key);
  dependencies.state.inFlight.delete(run.key);
  dependencies.state.requestAbort.delete(run.key);
  dependencies.state.cancelled.delete(run.key);
  useBrowserAutomationStore.getState().clearPendingAgentOpen(run.request.requestId, run.request.sequence);
}

function respondToBootstrapFailure(run: BootstrapRun, cause: unknown): void {
  const dependencies = runDependencies(run);
  if (dependencies.getLease() !== run.lease || run.controller.signal.aborted) return;
  void getTransport().respondToBrowserAutomationRequest(
    run.lease.hostId,
    run.lease.generation,
    failureResponse(run.request, "TAB_UNAVAILABLE", cause instanceof Error ? cause.message : "Browser open failed"),
  );
}

function startBootstrap(
  request: Extract<BrowserAutomationRequest, { readonly operation: "open" }>,
  key: string,
  lease: BrowserAutomationHostLease,
  dependencies: BrowserAutomationBootstrapLifecycleDependencies,
): void {
  const controller = new AbortController();
  const run: BootstrapRun = {
    request,
    key,
    lease,
    controller,
    agentOwnedOpen: request.args.idempotencyKey !== undefined,
    agentOpenKey: request.args.idempotencyKey === undefined
      ? null
      : JSON.stringify([request.providerSessionId, request.providerInstanceId, request.workspaceId, request.threadId, request.args.idempotencyKey]),
    previousTabId: currentTabSet(request)?.activeTabId ?? null,
    previousPanel: useDiffStore.getState().getRightPanel(request.workspaceId, request.threadId),
    state: {
      backgroundContextRestored: false,
      createdTabId: null,
      createdWebTabId: undefined,
      bootstrapSucceeded: false,
      visibleContextModified: false,
    },
  };
  bootstrapDependencies.set(run, dependencies);
  dependencies.state.bootstrapPending.add(key);
  dependencies.state.bootstrapRequest.set(key, request);
  dependencies.state.bootstrapAbort.set(key, controller);
  const deadlineTimer = window.setTimeout(
    () => controller.abort(new Error("Browser bootstrap deadline elapsed")),
    Math.max(1, request.deadline - Date.now()),
  );
  const restoreBackgroundContext = createBackgroundContextRestorer(run);
  void executeBootstrap(run).catch((cause: unknown) => {
    respondToBootstrapFailure(run, cause);
  }).finally(async () => {
    await finalizeBootstrap(run, restoreBackgroundContext);
    window.clearTimeout(deadlineTimer);
    bootstrapDependencies.delete(run);
  });
}

function parseBootstrapRequest(
  input: unknown,
  getLease: () => BrowserAutomationHostLease | null,
): { readonly request: Extract<BrowserAutomationRequest, { readonly operation: "open" }>; readonly lease: BrowserAutomationHostLease } | null {
  const payload = input as { hostId?: unknown; generation?: unknown; request?: unknown };
  const lease = getLease();
  const parsed = BrowserAutomationRequestSchema().safeParse(payload.request);
  if (!lease || payload.hostId !== lease.hostId || payload.generation !== lease.generation || !parsed.success || parsed.data.operation !== "open") return null;
  return { request: parsed.data, lease };
}

/** Create the host-local browser bootstrap event handler. */
export function createBrowserAutomationBootstrapLifecycle(
  dependencies: BrowserAutomationBootstrapLifecycleDependencies,
): (input: unknown) => void {
  return (input) => {
    const parsed = parseBootstrapRequest(input, dependencies.getLease);
    if (!parsed) return;
    const key = browserAutomationRequestKey(parsed.request.requestId, parsed.request.sequence);
    if (dependencies.state.inFlight.has(key) || dependencies.state.bootstrapPending.has(key)) return;
    startBootstrap(parsed.request, key, parsed.lease, dependencies);
  };
}
