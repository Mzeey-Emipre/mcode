import type {
  BrowserAutomationControllerState,
  BrowserAutomationHostDispatch,
} from "@mcode/contracts";
import { create } from "zustand";

/** Maximum number of inactive, non-busy Browser targets retained warm. */
export const BROWSER_AUTOMATION_WARM_TARGET_LIMIT = 3;

/** Renderer-owned Browser tab currently eligible for desktop target discovery. */
export interface BrowserAutomationLiveTarget {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly revision: number;
  readonly lastUsedAt: number;
}

/** One request currently executing in the visible Browser. */
export interface BrowserAutomationActiveRequest {
  readonly dispatch: BrowserAutomationHostDispatch;
  readonly startedAt: number;
}

interface BrowserAutomationState {
  readonly liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  readonly controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  readonly activeRequests: ReadonlyMap<string, BrowserAutomationActiveRequest>;
  readonly registered: boolean;
  readonly viewportByTarget: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  readonly hostedScopeIds: ReadonlySet<string>;
  registerTarget: (workspaceId: string, threadId: string, tabId: string) => void;
  refreshTarget: (threadId: string, tabId: string) => void;
  unregisterTarget: (threadId: string, tabId: string) => void;
  setController: (state: BrowserAutomationControllerState) => void;
  setControllerForTarget: (
    threadId: string,
    tabId: string,
    state: BrowserAutomationControllerState,
  ) => void;
  setActiveRequest: (request: BrowserAutomationActiveRequest) => void;
  clearActiveRequest: (requestId: string, sequence: number) => void;
  setRegistered: (registered: boolean) => void;
  setViewport: (threadId: string, tabId: string, width: number, height: number) => void;
  setHostedScopeIds: (scopeIds: ReadonlySet<string>) => void;
}

/** Stable key for an exact renderer-owned Browser tab. */
export function browserAutomationTargetKey(threadId: string, tabId: string): string {
  return JSON.stringify([threadId, tabId]);
}

/** Stable key for one broker request correlation pair. */
export function browserAutomationRequestKey(requestId: string, sequence: number): string {
  return JSON.stringify([requestId, sequence]);
}

/** Resolve a controller event only when its tab id maps to one exact live target. */
export function resolveBrowserAutomationControllerTarget(
  targets: Iterable<BrowserAutomationLiveTarget>,
  controller: BrowserAutomationControllerState,
): BrowserAutomationLiveTarget | null {
  const candidates = [...targets].filter((candidate) => candidate.tabId === controller.tabId);
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Shared renderer state for browser host discovery, control, and warm leases. */
export const useBrowserAutomationStore = create<BrowserAutomationState>((set) => ({
  liveTargets: new Map(),
  controllers: new Map(),
  activeRequests: new Map(),
  registered: false,
  viewportByTarget: new Map(),
  hostedScopeIds: new Set(),
  registerTarget: (workspaceId, threadId, tabId) =>
    set((state) => {
      const key = browserAutomationTargetKey(threadId, tabId);
      const current = state.liveTargets.get(key);
      const liveTargets = new Map(state.liveTargets);
      liveTargets.set(key, {
        workspaceId,
        threadId,
        tabId,
        revision: (current?.revision ?? 0) + 1,
        lastUsedAt: Date.now(),
      });
      return { liveTargets };
    }),
  refreshTarget: (threadId, tabId) =>
    set((state) => {
      const key = browserAutomationTargetKey(threadId, tabId);
      const current = state.liveTargets.get(key);
      if (!current) return state;
      const liveTargets = new Map(state.liveTargets);
      liveTargets.set(key, {
        ...current,
        revision: current.revision + 1,
        lastUsedAt: Date.now(),
      });
      return { liveTargets };
    }),
  unregisterTarget: (threadId, tabId) =>
    set((state) => {
      const key = browserAutomationTargetKey(threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      const liveTargets = new Map(state.liveTargets);
      liveTargets.delete(key);
      const controllers = new Map(state.controllers);
      controllers.delete(key);
      const viewportByTarget = new Map(state.viewportByTarget);
      viewportByTarget.delete(key);
      return { liveTargets, controllers, viewportByTarget };
    }),
  setController: (controller) =>
    set((state) => {
      const target = resolveBrowserAutomationControllerTarget(state.liveTargets.values(), controller);
      if (!target) return state;
      const controllers = new Map(state.controllers);
      controllers.set(browserAutomationTargetKey(target.threadId, target.tabId), controller);
      return { controllers };
    }),
  setControllerForTarget: (threadId, tabId, controller) =>
    set((state) => {
      const key = browserAutomationTargetKey(threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      const controllers = new Map(state.controllers);
      controllers.set(key, controller);
      return { controllers };
    }),
  setActiveRequest: (request) =>
    set((state) => {
      const activeRequests = new Map(state.activeRequests);
      const { requestId, sequence } = request.dispatch.request;
      activeRequests.set(browserAutomationRequestKey(requestId, sequence), request);
      return { activeRequests };
    }),
  clearActiveRequest: (requestId, sequence) =>
    set((state) => {
      const key = browserAutomationRequestKey(requestId, sequence);
      if (!state.activeRequests.has(key)) return state;
      const activeRequests = new Map(state.activeRequests);
      activeRequests.delete(key);
      return { activeRequests };
    }),
  setRegistered: (registered) => set({ registered }),
  setHostedScopeIds: (hostedScopeIds) => set({ hostedScopeIds: new Set(hostedScopeIds) }),
  setViewport: (threadId, tabId, width, height) =>
    set((state) => {
      const key = browserAutomationTargetKey(threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      const viewportByTarget = new Map(state.viewportByTarget);
      viewportByTarget.set(key, { width, height });
      return { viewportByTarget };
    }),
}));

type BrowserAutomationInterruptionReason = "human-interrupted" | "user-stopped";
type InterruptionListener = (
  threadId: string,
  tabId: string,
  reason: BrowserAutomationInterruptionReason,
) => void;
const interruptionListeners = new Set<InterruptionListener>();
const pendingInterruptions = new Map<string, Promise<boolean>>();

/** Identifies persistent automation surfaces that must be released. */
export type BrowserAutomationScopeRelease =
  | { readonly threadId: string; readonly workspaceId?: never }
  | { readonly workspaceId: string; readonly threadId?: never };

type ScopeReleaseListener = (release: BrowserAutomationScopeRelease) => void;
const scopeReleaseListeners = new Set<ScopeReleaseListener>();

/** Subscribe the root host to authoritative thread and workspace removal. */
export function onBrowserAutomationScopeRelease(listener: ScopeReleaseListener): () => void {
  scopeReleaseListeners.add(listener);
  return () => scopeReleaseListeners.delete(listener);
}

/** Release the persistent Browser surface owned by one deleted thread. */
export function releaseBrowserAutomationThreadScope(threadId: string): void {
  for (const listener of scopeReleaseListeners) listener({ threadId });
}

/** Release all persistent Browser surfaces owned by one deleted workspace. */
export function releaseBrowserAutomationWorkspaceScopes(workspaceId: string): void {
  for (const listener of scopeReleaseListeners) listener({ workspaceId });
}

/** Subscribe the root host to local human-takeover and Stop requests. */
export function onBrowserAutomationInterruption(listener: InterruptionListener): () => void {
  interruptionListeners.add(listener);
  return () => interruptionListeners.delete(listener);
}

/** Transfer one exact target to the human after desktop-main accepts takeover. */
export function interruptBrowserAutomationTarget(
  threadId: string,
  tabId: string,
  reason: BrowserAutomationInterruptionReason,
): void {
  const bridge = window.desktopBridge?.preview.automation;
  if (!bridge) return;
  const key = browserAutomationTargetKey(threadId, tabId);
  if (pendingInterruptions.has(key)) return;
  const interruption = bridge.interrupt({ threadId, tabId });
  pendingInterruptions.set(key, interruption);
  void interruption.then((accepted) => {
    if (!accepted) return;
    for (const listener of interruptionListeners) listener(threadId, tabId, reason);
  }).catch(() => undefined).finally(() => {
    if (pendingInterruptions.get(key) === interruption) pendingInterruptions.delete(key);
  });
}

/** Return whether an exact target currently has an executing browser request. */
export function isBrowserAutomationTargetBusy(threadId: string, tabId: string): boolean {
  return [...useBrowserAutomationStore.getState().activeRequests.values()].some(
    ({ dispatch }) => dispatch.target.threadId === threadId && dispatch.target.tabId === tabId,
  );
}

/** Select active and busy tabs first, then fill the bounded pool by recency. */
export function selectWarmBrowserTabIds(
  tabs: readonly { id: string }[],
  threadId: string,
  activeTabId: string,
): ReadonlySet<string> {
  const state = useBrowserAutomationStore.getState();
  const byRecency = [...tabs].sort((left, right) => {
    const leftTarget = state.liveTargets.get(browserAutomationTargetKey(threadId, left.id));
    const rightTarget = state.liveTargets.get(browserAutomationTargetKey(threadId, right.id));
    return (rightTarget?.lastUsedAt ?? 0) - (leftTarget?.lastUsedAt ?? 0);
  });
  const selected = new Set<string>([activeTabId]);
  for (const { dispatch } of state.activeRequests.values()) {
    if (dispatch.target.threadId === threadId) selected.add(dispatch.target.tabId);
  }
  for (const tab of byRecency) {
    if (selected.size >= BROWSER_AUTOMATION_WARM_TARGET_LIMIT) break;
    selected.add(tab.id);
  }
  return selected;
}
