import type {
  BrowserAutomationControllerState,
  BrowserAutomationHostDispatch,
} from "@mcode/contracts";
import { BROWSER_AUTOMATION_MAX_INSPECT_TABS, BROWSER_AUTOMATION_MAX_PENDING_REQUESTS } from "@mcode/contracts";
import { create } from "zustand";
import { browserTargetRegistry } from "./services/browserTargetRegistry";
import type {
  ViewportCoordinator,
  ViewportCoordinatorState,
} from "./services/viewportCoordinator";
import type { BrowserSessionLifecycleTab } from "./services/browserSessionDriver";

/** Maximum number of inactive, non-busy Browser targets retained warm. */
export const BROWSER_AUTOMATION_WARM_TARGET_LIMIT = 3;

/** Discovery state for the browser automation host in the current runtime. */
export type BrowserAutomationHostStatus = "disabled" | "unavailable" | "registered";

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

/** Agent-created Browser tab visible before its open bootstrap can dispatch. */
export interface BrowserAutomationPendingAgentOpen {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string | null;
  readonly startedAt: number;
}

interface BrowserAutomationState {
  readonly liveTargets: ReadonlyMap<string, BrowserAutomationLiveTarget>;
  readonly lifecycleTabs: ReadonlyMap<string, BrowserSessionLifecycleTab>;
  readonly controllers: ReadonlyMap<string, BrowserAutomationControllerState>;
  readonly activeRequests: ReadonlyMap<string, BrowserAutomationActiveRequest>;
  readonly pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>;
  readonly registered: boolean;
  readonly status: BrowserAutomationHostStatus;
  readonly viewportByTarget: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  readonly viewportStateByTarget: ReadonlyMap<string, ViewportCoordinatorState>;
  readonly viewportCoordinators: ReadonlyMap<string, ViewportCoordinator>;
  readonly hostedScopeIds: ReadonlySet<string>;
  registerTarget: (workspaceId: string, threadId: string, tabId: string) => void;
  refreshTarget: (workspaceId: string, threadId: string, tabId: string) => void;
  detachTarget: (workspaceId: string, threadId: string, tabId: string) => void;
  unregisterTarget: (workspaceId: string, threadId: string, tabId: string) => void;
  setLifecycleTabs: (tabs: readonly BrowserSessionLifecycleTab[]) => void;
  releaseThreadTargets: (workspaceId: string, threadId: string) => void;
  releaseWorkspaceTargets: (workspaceId: string) => void;
  setController: (state: BrowserAutomationControllerState) => void;
  setControllerForTarget: (
    workspaceId: string,
    threadId: string,
    tabId: string,
    state: BrowserAutomationControllerState,
  ) => void;
  setActiveRequest: (request: BrowserAutomationActiveRequest) => void;
  clearActiveRequest: (requestId: string, sequence: number) => void;
  setPendingAgentOpen: (
    requestId: string,
    sequence: number,
    pending: BrowserAutomationPendingAgentOpen,
  ) => void;
  clearPendingAgentOpen: (requestId: string, sequence: number) => void;
  setRegistered: (registered: boolean) => void;
  setStatus: (status: BrowserAutomationHostStatus) => void;
  setViewport: (workspaceId: string, threadId: string, tabId: string, width: number, height: number) => void;
  applyViewportIfCurrent: (
    workspaceId: string,
    threadId: string,
    tabId: string,
    coordinator: ViewportCoordinator,
    targetGeneration: number,
    size: { readonly width: number; readonly height: number },
  ) => boolean;
  resetViewportIfCurrent: (
    workspaceId: string,
    threadId: string,
    tabId: string,
    coordinator: ViewportCoordinator,
    targetGeneration: number,
  ) => boolean;
  setViewportState: (
    workspaceId: string,
    threadId: string,
    tabId: string,
    state: ViewportCoordinatorState,
    coordinator?: ViewportCoordinator,
  ) => void;
  setViewportCoordinator: (workspaceId: string, threadId: string, tabId: string, coordinator: ViewportCoordinator) => void;
  clearViewportCoordinator: (workspaceId: string, threadId: string, tabId: string) => void;
  setHostedScopeIds: (scopeIds: ReadonlySet<string>) => void;
}

/** Stable key for an exact renderer-owned Browser tab. */
export function browserAutomationTargetKey(workspaceId: string, threadId: string, tabId: string): string {
  return JSON.stringify([workspaceId, threadId, tabId]);
}

/** Decodes one exact renderer-owned Browser tab key. */
export function parseBrowserAutomationTargetKey(
  value: string,
): { workspaceId: string; threadId: string; tabId: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed.some((item) => typeof item !== "string")
    ) return null;
    return { workspaceId: parsed[0], threadId: parsed[1], tabId: parsed[2] };
  } catch {
    return null;
  }
}

/** Stable key for one workspace and Browser scope lease. */
export function browserAutomationScopeKey(workspaceId: string, scopeId: string): string {
  return JSON.stringify([workspaceId, scopeId]);
}

/** Decodes one workspace-qualified Browser scope key. */
export function parseBrowserAutomationScopeKey(
  value: string,
): { workspaceId: string; scopeId: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      parsed.some((item) => typeof item !== "string")
    ) return null;
    return { workspaceId: parsed[0], scopeId: parsed[1] };
  } catch {
    return null;
  }
}

/** Stable key for one lifecycle-backed tab across workspace and thread scopes. */
export function browserAutomationLifecycleKey(
  workspaceId: string,
  threadId: string,
  tabId: string,
): string {
  return JSON.stringify([workspaceId, threadId, tabId]);
}

/** Stable key for one broker request correlation pair. */
export function browserAutomationRequestKey(requestId: string, sequence: number): string {
  return JSON.stringify([requestId, sequence]);
}

/** Returns the pending agent open for one exact Browser target, if any. */
export function findPendingBrowserAutomationOpen(
  pendingAgentOpens: ReadonlyMap<string, BrowserAutomationPendingAgentOpen>,
  workspaceId: string,
  threadId: string,
  tabId: string,
): BrowserAutomationPendingAgentOpen | null {
  for (const pending of pendingAgentOpens.values()) {
    if (
      pending.threadId === threadId &&
      pending.tabId === tabId &&
      pending.workspaceId === workspaceId
    ) return pending;
  }
  return null;
}

/** Whether an agent controls or is opening one exact Browser target. */
export function isBrowserAutomationAgentControlled(
  state: Pick<BrowserAutomationState, "controllers" | "pendingAgentOpens">,
  workspaceId: string,
  threadId: string,
  tabId: string,
): boolean {
  if (state.controllers.get(browserAutomationTargetKey(workspaceId, threadId, tabId))?.controller === "agent") {
    return true;
  }
  return findPendingBrowserAutomationOpen(
    state.pendingAgentOpens,
    workspaceId,
    threadId,
    tabId,
  ) !== null;
}

/** Resolve a controller event only when its tab id maps to one exact live target. */
export function resolveBrowserAutomationControllerTarget(
  targets: Iterable<BrowserAutomationLiveTarget>,
  controller: BrowserAutomationControllerState,
): BrowserAutomationLiveTarget | null {
  const candidates = [...targets].filter((candidate) => candidate.tabId === controller.tabId);
  return candidates.length === 1 ? candidates[0]! : null;
}

function interruptViewportCoordinator(coordinator: ViewportCoordinator | undefined): void {
  coordinator?.interrupt();
}

/** Shared renderer state for browser host discovery, control, and warm leases. */
export const useBrowserAutomationStore = create<BrowserAutomationState>((set, get) => ({
  liveTargets: new Map(),
  lifecycleTabs: new Map(),
  controllers: new Map(),
  activeRequests: new Map(),
  pendingAgentOpens: new Map(),
  registered: false,
  status: "unavailable",
  viewportByTarget: new Map(),
  viewportStateByTarget: new Map(),
  viewportCoordinators: new Map(),
  hostedScopeIds: new Set(),
  registerTarget: (workspaceId, threadId, tabId) =>
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      const previous = browserTargetRegistry.get(workspaceId, threadId, tabId);
      if (previous?.attached && !state.liveTargets.has(key)) {
        browserTargetRegistry.releaseTarget(workspaceId, threadId, tabId);
      }
      const currentRecord = browserTargetRegistry.register(workspaceId, threadId, tabId);
      const current = previous?.attached === false
        ? browserTargetRegistry.refresh(workspaceId, threadId, tabId) ?? currentRecord
        : currentRecord;
      const liveTargets = new Map(state.liveTargets);
      liveTargets.set(key, {
        workspaceId,
        threadId,
        tabId,
        revision: current.revision,
        lastUsedAt: current.lastUsedAt,
      });
      if (state.liveTargets.has(key)) return { liveTargets };
      const viewportCoordinators = new Map(state.viewportCoordinators);
      interruptViewportCoordinator(viewportCoordinators.get(key));
      viewportCoordinators.delete(key);
      return { liveTargets, viewportCoordinators };
    }),
  refreshTarget: (workspaceId, threadId, tabId) =>
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      const current = browserTargetRegistry.refresh(workspaceId, threadId, tabId);
      if (!current) return state;
      const liveTargets = new Map(state.liveTargets);
      liveTargets.set(key, {
        ...current,
        revision: current.revision,
        lastUsedAt: Date.now(),
      });
      return { liveTargets };
    }),
  detachTarget: (workspaceId, threadId, tabId) => {
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    const coordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(key);
    interruptViewportCoordinator(coordinator);
    browserTargetRegistry.detach(workspaceId, threadId, tabId);
    set((state) => {
      if (!state.liveTargets.has(key)) return state;
      const liveTargets = new Map(state.liveTargets);
      liveTargets.delete(key);
      const controllers = new Map(state.controllers);
      controllers.delete(key);
      const viewportCoordinators = new Map(state.viewportCoordinators);
      viewportCoordinators.delete(key);
      const viewportState = coordinator?.snapshot();
      const viewportStateByTarget = new Map(state.viewportStateByTarget);
      const viewportByTarget = new Map(state.viewportByTarget);
      if (viewportState) {
        viewportStateByTarget.set(key, viewportState);
        if (viewportState.mode === "responsive" || viewportByTarget.has(key)) {
          viewportByTarget.set(key, viewportState.confirmed);
        }
      }
      return { liveTargets, controllers, viewportByTarget, viewportStateByTarget, viewportCoordinators };
    });
  },
  unregisterTarget: (workspaceId, threadId, tabId) => {
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    interruptViewportCoordinator(useBrowserAutomationStore.getState().viewportCoordinators.get(key));
    browserTargetRegistry.releaseTarget(workspaceId, threadId, tabId);
    set((state) => {
      if (!state.liveTargets.has(key)) return state;
      const liveTargets = new Map(state.liveTargets);
      liveTargets.delete(key);
      const controllers = new Map(state.controllers);
      controllers.delete(key);
      const viewportByTarget = new Map(state.viewportByTarget);
      viewportByTarget.delete(key);
      const viewportStateByTarget = new Map(state.viewportStateByTarget);
      viewportStateByTarget.delete(key);
      const viewportCoordinators = new Map(state.viewportCoordinators);
      viewportCoordinators.delete(key);
      const lifecycleTabs = new Map(state.lifecycleTabs);
      for (const [lifecycleKey, tab] of lifecycleTabs) {
        if (
          tab.workspaceId === workspaceId &&
          tab.threadId === threadId &&
          tab.tabId === tabId
        ) lifecycleTabs.delete(lifecycleKey);
      }
      return {
        liveTargets,
        controllers,
        viewportByTarget,
        viewportStateByTarget,
        viewportCoordinators,
        lifecycleTabs,
      };
    });
  },
  setLifecycleTabs: (tabs) =>
    set(() => {
      const lifecycleTabs = new Map<string, BrowserSessionLifecycleTab>();
      for (const tab of tabs.slice(0, BROWSER_AUTOMATION_MAX_INSPECT_TABS)) {
        if (tab.ownership === "released") continue;
        lifecycleTabs.set(
          browserAutomationLifecycleKey(tab.workspaceId, tab.threadId, tab.tabId),
          tab,
        );
      }
      return { lifecycleTabs };
    }),
  releaseThreadTargets: (workspaceId, threadId) => {
    const current = useBrowserAutomationStore.getState();
    for (const target of current.liveTargets.values()) {
      if (target.workspaceId === workspaceId && target.threadId === threadId) {
        interruptViewportCoordinator(current.viewportCoordinators.get(
          browserAutomationTargetKey(target.workspaceId, target.threadId, target.tabId),
        ));
      }
    }
    browserTargetRegistry.releaseThread(workspaceId, threadId);
    set((state) => {
      const liveTargets = new Map(state.liveTargets);
      const controllers = new Map(state.controllers);
      const viewportByTarget = new Map(state.viewportByTarget);
      const viewportStateByTarget = new Map(state.viewportStateByTarget);
      const viewportCoordinators = new Map(state.viewportCoordinators);
      const lifecycleTabs = new Map(state.lifecycleTabs);
      for (const target of state.liveTargets.values()) {
        if (target.workspaceId !== workspaceId || target.threadId !== threadId) continue;
        const key = browserAutomationTargetKey(target.workspaceId, target.threadId, target.tabId);
        liveTargets.delete(key);
        controllers.delete(key);
        viewportByTarget.delete(key);
        viewportStateByTarget.delete(key);
        viewportCoordinators.delete(key);
      }
      for (const [lifecycleKey, tab] of lifecycleTabs) {
        if (tab.workspaceId === workspaceId && tab.threadId === threadId) lifecycleTabs.delete(lifecycleKey);
      }
      return {
        liveTargets,
        controllers,
        viewportByTarget,
        viewportStateByTarget,
        viewportCoordinators,
        lifecycleTabs,
      };
    });
  },
  releaseWorkspaceTargets: (workspaceId) => {
    const current = useBrowserAutomationStore.getState();
    for (const target of current.liveTargets.values()) {
      if (target.workspaceId === workspaceId) {
        interruptViewportCoordinator(current.viewportCoordinators.get(
          browserAutomationTargetKey(target.workspaceId, target.threadId, target.tabId),
        ));
      }
    }
    browserTargetRegistry.releaseWorkspace(workspaceId);
    set((state) => {
      const liveTargets = new Map(state.liveTargets);
      const controllers = new Map(state.controllers);
      const viewportByTarget = new Map(state.viewportByTarget);
      const viewportStateByTarget = new Map(state.viewportStateByTarget);
      const viewportCoordinators = new Map(state.viewportCoordinators);
      const lifecycleTabs = new Map(state.lifecycleTabs);
      for (const target of state.liveTargets.values()) {
        if (target.workspaceId !== workspaceId) continue;
        const key = browserAutomationTargetKey(target.workspaceId, target.threadId, target.tabId);
        liveTargets.delete(key);
        controllers.delete(key);
        viewportByTarget.delete(key);
        viewportStateByTarget.delete(key);
        viewportCoordinators.delete(key);
      }
      for (const [lifecycleKey, tab] of lifecycleTabs) {
        if (tab.workspaceId === workspaceId) lifecycleTabs.delete(lifecycleKey);
      }
      return {
        liveTargets,
        controllers,
        viewportByTarget,
        viewportStateByTarget,
        viewportCoordinators,
        lifecycleTabs,
      };
    });
  },
  setController: (controller) => {
    const target = resolveBrowserAutomationControllerTarget(get().liveTargets.values(), controller);
    if (!target) return;
    get().setControllerForTarget(target.workspaceId, target.threadId, target.tabId, controller);
  },
  setControllerForTarget: (workspaceId, threadId, tabId, controller) =>
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      const controllers = new Map(state.controllers);
      if (controller.controller === "agent") {
        for (const target of state.liveTargets.values()) {
          if (target.workspaceId !== workspaceId || target.threadId !== threadId || target.tabId === tabId) continue;
          const otherKey = browserAutomationTargetKey(target.workspaceId, target.threadId, target.tabId);
          const other = controllers.get(otherKey);
          if (other?.controller !== "agent") continue;
          controllers.set(otherKey, {
            tabId: target.tabId,
            controller: "none",
            controlEpoch: other.controlEpoch,
          });
        }
      }
      controllers.set(key, controller);
      return { controllers };
    }),
  setActiveRequest: (request) =>
    set((state) => {
      const activeRequests = new Map(state.activeRequests);
      const { requestId, sequence } = request.dispatch.request;
      activeRequests.set(browserAutomationRequestKey(requestId, sequence), request);
      while (activeRequests.size > BROWSER_AUTOMATION_MAX_PENDING_REQUESTS) {
        const oldest = activeRequests.keys().next().value as string | undefined;
        if (!oldest) break;
        activeRequests.delete(oldest);
      }
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
  setPendingAgentOpen: (requestId, sequence, pending) =>
    set((state) => {
      const pendingAgentOpens = new Map(state.pendingAgentOpens);
      pendingAgentOpens.set(browserAutomationRequestKey(requestId, sequence), pending);
      while (pendingAgentOpens.size > BROWSER_AUTOMATION_MAX_PENDING_REQUESTS) {
        const oldest = pendingAgentOpens.keys().next().value as string | undefined;
        if (!oldest) break;
        pendingAgentOpens.delete(oldest);
      }
      return { pendingAgentOpens };
    }),
  clearPendingAgentOpen: (requestId, sequence) =>
    set((state) => {
      const key = browserAutomationRequestKey(requestId, sequence);
      if (!state.pendingAgentOpens.has(key)) return state;
      const pendingAgentOpens = new Map(state.pendingAgentOpens);
      pendingAgentOpens.delete(key);
      return { pendingAgentOpens };
    }),
  setRegistered: (registered) => set({ registered }),
  setStatus: (status) => set({ status }),
  setHostedScopeIds: (hostedScopeIds) => set({ hostedScopeIds: new Set([...hostedScopeIds].slice(0, 5)) }),
  setViewport: (workspaceId, threadId, tabId, width, height) =>
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      const viewportByTarget = new Map(state.viewportByTarget);
      viewportByTarget.set(key, { width, height });
      return { viewportByTarget };
    }),
  applyViewportIfCurrent: (workspaceId, threadId, tabId, coordinator, targetGeneration, size) => {
    let applied = false;
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      const liveTarget = state.liveTargets.get(key);
      if (
        !liveTarget ||
        liveTarget.revision !== targetGeneration ||
        state.viewportCoordinators.get(key) !== coordinator
      ) return state;
      const viewportByTarget = new Map(state.viewportByTarget);
      viewportByTarget.set(key, size);
      applied = true;
      return { viewportByTarget };
    });
    return applied;
  },
  resetViewportIfCurrent: (workspaceId, threadId, tabId, coordinator, targetGeneration) => {
    let reset = false;
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      const liveTarget = state.liveTargets.get(key);
      if (
        !liveTarget ||
        liveTarget.revision !== targetGeneration ||
        state.viewportCoordinators.get(key) !== coordinator
      ) return state;
      const viewportByTarget = new Map(state.viewportByTarget);
      viewportByTarget.delete(key);
      reset = true;
      return { viewportByTarget };
    });
    return reset;
  },
  setViewportState: (workspaceId, threadId, tabId, viewportState, coordinator) =>
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      if (
        coordinator &&
        (state.viewportCoordinators.get(key) !== coordinator ||
          state.liveTargets.get(key)?.revision !== viewportState.targetGeneration)
      ) return state;
      const viewportStateByTarget = new Map(state.viewportStateByTarget);
      viewportStateByTarget.set(key, viewportState);
      const viewportByTarget = new Map(state.viewportByTarget);
      if (viewportState.mode === "responsive" || viewportByTarget.has(key)) {
        viewportByTarget.set(key, viewportState.confirmed);
      }
      return { viewportStateByTarget, viewportByTarget };
    }),
  setViewportCoordinator: (workspaceId, threadId, tabId, coordinator) =>
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      if (!state.liveTargets.has(key)) return state;
      const viewportCoordinators = new Map(state.viewportCoordinators);
      viewportCoordinators.set(key, coordinator);
      const viewportStateByTarget = new Map(state.viewportStateByTarget);
      const snapshot = coordinator.snapshot();
      viewportStateByTarget.set(key, snapshot);
      const viewportByTarget = new Map(state.viewportByTarget);
      if (snapshot.mode === "responsive" || viewportByTarget.has(key)) {
        viewportByTarget.set(key, snapshot.confirmed);
      }
      return { viewportCoordinators, viewportStateByTarget, viewportByTarget };
    }),
  clearViewportCoordinator: (workspaceId, threadId, tabId) =>
    set((state) => {
      const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
      if (!state.viewportCoordinators.has(key)) return state;
      interruptViewportCoordinator(state.viewportCoordinators.get(key));
      const viewportCoordinators = new Map(state.viewportCoordinators);
      viewportCoordinators.delete(key);
      const viewportStateByTarget = new Map(state.viewportStateByTarget);
      viewportStateByTarget.delete(key);
      return { viewportCoordinators, viewportStateByTarget };
    }),
}));

type BrowserAutomationInterruptionReason = "human-interrupted" | "user-stopped";
type InterruptionListener = (
  workspaceId: string,
  threadId: string,
  tabId: string,
  reason: BrowserAutomationInterruptionReason,
) => void;
const interruptionListeners = new Set<InterruptionListener>();
const pendingInterruptions = new Map<string, Promise<boolean>>();
type ObservationInvalidationListener = (workspaceId: string, threadId: string, tabId: string) => void;
const observationInvalidationListeners = new Set<ObservationInvalidationListener>();

/** Subscribe to trusted human input without changing Browser controller state. */
export function onBrowserAutomationObservationInvalidation(
  listener: ObservationInvalidationListener,
): () => void {
  observationInvalidationListeners.add(listener);
  return () => observationInvalidationListeners.delete(listener);
}

/** Notify Browser automation listeners that one target received trusted human input. */
export function invalidateBrowserAutomationTargetObservation(
  workspaceId: string,
  threadId: string,
  tabId: string,
): void {
  for (const listener of observationInvalidationListeners) listener(workspaceId, threadId, tabId);
}

/** Identifies persistent automation surfaces that must be released. */
export type BrowserAutomationScopeRelease =
  | { readonly workspaceId: string; readonly threadId: string }
  | { readonly workspaceId: string; readonly threadId?: never };

type ScopeReleaseListener = (release: BrowserAutomationScopeRelease) => void;
const scopeReleaseListeners = new Set<ScopeReleaseListener>();

/** Subscribe the root host to authoritative thread and workspace removal. */
export function onBrowserAutomationScopeRelease(listener: ScopeReleaseListener): () => void {
  scopeReleaseListeners.add(listener);
  return () => scopeReleaseListeners.delete(listener);
}

/** Release the persistent Browser surface owned by one deleted thread. */
export function releaseBrowserAutomationThreadScope(workspaceId: string, threadId: string): void {
  useBrowserAutomationStore.getState().releaseThreadTargets(workspaceId, threadId);
  for (const listener of scopeReleaseListeners) listener({ workspaceId, threadId });
}

/** Release all persistent Browser surfaces owned by one deleted workspace. */
export function releaseBrowserAutomationWorkspaceScopes(workspaceId: string): void {
  useBrowserAutomationStore.getState().releaseWorkspaceTargets(workspaceId);
  for (const listener of scopeReleaseListeners) listener({ workspaceId });
}

/** Subscribe the root host to local human-takeover and Stop requests. */
export function onBrowserAutomationInterruption(listener: InterruptionListener): () => void {
  interruptionListeners.add(listener);
  return () => interruptionListeners.delete(listener);
}

/** Transfer one exact target to the human after desktop-main accepts takeover. */
export function interruptBrowserAutomationTarget(
  workspaceId: string,
  threadId: string,
  tabId: string,
  reason: BrowserAutomationInterruptionReason,
): void {
  const bridge = window.desktopBridge?.preview?.automation;
  if (!bridge) {
    for (const listener of interruptionListeners) listener(workspaceId, threadId, tabId, reason);
    return;
  }
  const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
  if (pendingInterruptions.has(key)) return;
  const interruption = bridge.interrupt({ threadId, tabId });
  pendingInterruptions.set(key, interruption);
  void interruption.then((accepted) => {
    if (!accepted) return;
    for (const listener of interruptionListeners) listener(workspaceId, threadId, tabId, reason);
  }).catch(() => undefined).finally(() => {
    if (pendingInterruptions.get(key) === interruption) pendingInterruptions.delete(key);
  });
}

/** Return whether an exact target currently has an executing browser request. */
export function isBrowserAutomationTargetBusy(workspaceId: string, threadId: string, tabId: string): boolean {
  return [...useBrowserAutomationStore.getState().activeRequests.values()].some(
    ({ dispatch }) =>
      dispatch.request.workspaceId === workspaceId &&
      dispatch.target.threadId === threadId &&
      dispatch.target.tabId === tabId,
  );
}

/** Select active and busy tabs first, then fill the bounded pool by recency. */
export function selectWarmBrowserTabIds(
  tabs: readonly { id: string }[],
  workspaceId: string,
  threadId: string,
  activeTabId: string,
): ReadonlySet<string> {
  const state = useBrowserAutomationStore.getState();
  const byRecency = [...tabs].sort((left, right) => {
    const leftTarget = state.liveTargets.get(browserAutomationTargetKey(workspaceId, threadId, left.id));
    const rightTarget = state.liveTargets.get(browserAutomationTargetKey(workspaceId, threadId, right.id));
    return (rightTarget?.lastUsedAt ?? 0) - (leftTarget?.lastUsedAt ?? 0);
  });
  const selected = new Set<string>([activeTabId]);
  for (const { dispatch } of state.activeRequests.values()) {
    if (dispatch.request.workspaceId === workspaceId && dispatch.target.threadId === threadId) {
      selected.add(dispatch.target.tabId);
    }
  }
  for (const tab of byRecency) {
    if (selected.size >= BROWSER_AUTOMATION_WARM_TARGET_LIMIT) break;
    selected.add(tab.id);
  }
  return selected;
}
