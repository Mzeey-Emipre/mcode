import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_MAX_PENDING_REQUESTS } from "@mcode/contracts";
import {
  browserAutomationLifecycleKey,
  browserAutomationRequestKey,
  browserAutomationScopeKey,
  browserAutomationTargetKey,
  parseBrowserAutomationScopeKey,
  parseBrowserAutomationTargetKey,
  onBrowserAutomationScopeRelease,
  invalidateBrowserAutomationTargetObservation,
  onBrowserAutomationObservationInvalidation,
  releaseBrowserAutomationThreadScope,
  releaseBrowserAutomationWorkspaceScopes,
  resolveBrowserAutomationControllerTarget,
  selectWarmBrowserTabIds,
  useBrowserAutomationStore,
  type BrowserAutomationActiveRequest,
  type BrowserAutomationLiveTarget,
} from "../browserAutomationStore";
import type { BrowserSessionLifecycleTab } from "../services/browserSessionDriver";
import { selectBrowserAutomationWorkspaceIds } from "../BrowserAutomationHost";
import { reconcileWarmPreviewScopes } from "@/components/panels/RightPanel";
import { browserTargetRegistry } from "../services/browserTargetRegistry";
import { ViewportCoordinator } from "../services/viewportCoordinator";
import { createViewportCoordinator } from "../services/viewportCoordinatorFactory";

function target(
  workspaceId: string,
  threadId: string,
  tabId: string,
  lastUsedAt = 1,
): BrowserAutomationLiveTarget {
  return { workspaceId, threadId, tabId, lastUsedAt, revision: 1 };
}

function lifecycleTab(
  workspaceId: string,
  threadId: string,
  tabId: string,
): BrowserSessionLifecycleTab {
  return {
    workspaceId,
    threadId,
    tabId,
    providerSessionId: "session",
    providerInstanceId: "instance",
    provenance: "claimed-user",
    ownership: "claimed",
    target: {
      desktopInstanceId: "desktop",
      windowId: 1,
      connectionGeneration: 1,
      threadId,
      tabId,
      targetGeneration: 1,
      active: false,
      focused: false,
      lastUsedAt: 1,
    },
  };
}

describe("browser automation renderer scope", () => {
  it("projects lifecycle-backed tabs by exact workspace/thread/tab tuple and releases their scope", () => {
    const lifecycleTab = {
      workspaceId: "workspace-a",
      threadId: "thread-a",
      tabId: "tab-a",
      providerSessionId: "session-a",
      providerInstanceId: "instance-a",
      provenance: "claimed-user",
      ownership: "claimed",
      target: {
        desktopInstanceId: "desktop-a",
        windowId: 1,
        connectionGeneration: 1,
        threadId: "thread-a",
        tabId: "tab-a",
        targetGeneration: 1,
        active: false,
        focused: false,
        lastUsedAt: 1,
      },
    } satisfies BrowserSessionLifecycleTab;
    useBrowserAutomationStore.getState().setLifecycleTabs([
      lifecycleTab,
      { ...lifecycleTab, workspaceId: "workspace-b", threadId: "thread-b", tabId: "tab-b", target: { ...lifecycleTab.target, threadId: "thread-b", tabId: "tab-b" } },
    ]);

    const lifecycle = useBrowserAutomationStore.getState().lifecycleTabs;
    expect(lifecycle).toHaveLength(2);
    expect([...lifecycle.values()].map((tab) => [tab.workspaceId, tab.threadId, tab.tabId])).toEqual([
      ["workspace-a", "thread-a", "tab-a"],
      ["workspace-b", "thread-b", "tab-b"],
    ]);

    useBrowserAutomationStore.getState().releaseThreadTargets("workspace-a", "thread-a");
    expect([...useBrowserAutomationStore.getState().lifecycleTabs.values()]).toEqual([
      expect.objectContaining({ workspaceId: "workspace-b", threadId: "thread-b", tabId: "tab-b" }),
    ]);

    useBrowserAutomationStore.getState().releaseWorkspaceTargets("workspace-b");
    expect(useBrowserAutomationStore.getState().lifecycleTabs).toHaveLength(0);
  });

  it("uses collision-proof tuple keys for adversarial external ids", () => {
    expect(browserAutomationTargetKey("a", "\u0000b", "c")).not.toBe(
      browserAutomationTargetKey("a", "b", "\u0000c"),
    );
    expect(browserAutomationRequestKey("request\u00001", 2)).not.toBe(
      browserAutomationRequestKey("request", 12),
    );
  });

  it("decodes only valid scope and target tuple keys", () => {
    expect(parseBrowserAutomationScopeKey(browserAutomationScopeKey("workspace-a", "thread-a"))).toEqual({
      workspaceId: "workspace-a",
      scopeId: "thread-a",
    });
    expect(parseBrowserAutomationTargetKey(browserAutomationTargetKey("workspace-a", "thread-a", "tab-a"))).toEqual({
      workspaceId: "workspace-a",
      threadId: "thread-a",
      tabId: "tab-a",
    });
    expect(parseBrowserAutomationScopeKey('["workspace-a"]')).toBeNull();
    expect(parseBrowserAutomationTargetKey('["workspace-a","thread-a",1]')).toBeNull();
    expect(parseBrowserAutomationTargetKey("not-json")).toBeNull();
  });

  it("does not resolve a controller event when duplicate tab ids span threads", () => {
    const targets = [target("ws-a", "thread-a", "same-tab"), target("ws-a", "thread-b", "same-tab")];
    expect(resolveBrowserAutomationControllerTarget(targets, {
      tabId: "same-tab",
      controller: "human",
      controlEpoch: 2,
    })).toBeNull();
  });

  it("prioritizes active and live-target workspaces within the 32 item bound", () => {
    const available = Array.from({ length: 40 }, (_, index) => `ws-${index}`);
    const selected = selectBrowserAutomationWorkspaceIds(
      available,
      "ws-39",
      [target("ws-38", "thread-a", "tab-a", 10)],
    );
    expect(selected).toHaveLength(32);
    expect(selected.slice(0, 2)).toEqual(["ws-39", "ws-38"]);
  });

  it("retains active and busy scopes before filling the warm LRU budget", () => {
    const result = reconcileWarmPreviewScopes(
      [
        { scopeId: "old", workspaceId: "ws", lastUsedAt: 1 },
        { scopeId: "recent", workspaceId: "ws", lastUsedAt: 3 },
        { scopeId: "busy", workspaceId: "ws", lastUsedAt: 0 },
      ],
      { scopeId: "active", workspaceId: "ws", lastUsedAt: 4 },
      new Set([browserAutomationScopeKey("ws", "busy")]),
    );
    expect(result.map((scope) => scope.scopeId)).toEqual(["active", "busy", "recent"]);
  });

  it("keeps equal thread and tab ids isolated across workspaces", () => {
    const store = useBrowserAutomationStore.getState();
    store.registerTarget("workspace-a", "thread", "tab");
    store.registerTarget("workspace-b", "thread", "tab");
    store.setControllerForTarget("workspace-a", "thread", "tab", {
      tabId: "tab",
      controller: "agent",
      controlEpoch: 1,
    });

    expect(useBrowserAutomationStore.getState().liveTargets).toHaveLength(2);
    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("workspace-a", "thread", "tab"),
    )).toEqual(expect.objectContaining({ controller: "agent" }));
    expect(useBrowserAutomationStore.getState().controllers.has(
      browserAutomationTargetKey("workspace-b", "thread", "tab"),
    )).toBe(false);
    expect(browserTargetRegistry.get("workspace-a", "thread", "tab")?.workspaceId).toBe("workspace-a");
    expect(browserTargetRegistry.get("workspace-b", "thread", "tab")?.workspaceId).toBe("workspace-b");
  });

  it("unregisters lifecycle state only for the exact workspace target", () => {
    const store = useBrowserAutomationStore.getState();
    store.registerTarget("workspace-a", "thread", "tab");
    store.registerTarget("workspace-b", "thread", "tab");
    store.setLifecycleTabs([
      lifecycleTab("workspace-a", "thread", "tab"),
      lifecycleTab("workspace-b", "thread", "tab"),
    ]);

    store.unregisterTarget("workspace-a", "thread", "tab");

    expect(useBrowserAutomationStore.getState().lifecycleTabs.has(
      browserAutomationLifecycleKey("workspace-a", "thread", "tab"),
    )).toBe(false);
    expect(useBrowserAutomationStore.getState().lifecycleTabs.has(
      browserAutomationLifecycleKey("workspace-b", "thread", "tab"),
    )).toBe(true);
  });

  it("leases a busy warm scope by workspace and thread", () => {
    const result = reconcileWarmPreviewScopes(
      [
        { scopeId: "shared-thread", workspaceId: "workspace-a", lastUsedAt: 4 },
        { scopeId: "shared-thread", workspaceId: "workspace-b", lastUsedAt: 1 },
        { scopeId: "other-thread", workspaceId: "workspace-a", lastUsedAt: 3 },
        { scopeId: "other-thread", workspaceId: "workspace-b", lastUsedAt: 2 },
      ],
      null,
      new Set([browserAutomationScopeKey("workspace-b", "shared-thread")]),
    );

    expect(result.map((scope) => [scope.workspaceId, scope.scopeId])).toEqual([
      ["workspace-b", "shared-thread"],
      ["workspace-a", "shared-thread"],
      ["workspace-a", "other-thread"],
    ]);
  });

  it("bounds a 20-tab pool while preserving active and busy leases exactly", () => {
    const tabs = Array.from({ length: 20 }, (_, index) => ({ id: `tab-${index}` }));
    useBrowserAutomationStore.setState({
      liveTargets: new Map(tabs.map((tab, index) => [
        browserAutomationTargetKey("ws-a", "thread-a", tab.id),
        target("ws-a", "thread-a", tab.id, index),
      ])),
      activeRequests: new Map([1, 2, 3, 4].map((index) => {
        const activeDispatch = {
          request: { workspaceId: "ws-a" },
          target: { threadId: "thread-a", tabId: `tab-${index}` },
        } as never;
        return [`request-${index}`, { dispatch: activeDispatch, startedAt: index }];
      })),
    });
    const leased = selectWarmBrowserTabIds(tabs, "ws-a", "thread-a", "tab-0");
    expect(leased).toEqual(new Set(["tab-0", "tab-1", "tab-2", "tab-3", "tab-4"]));

    useBrowserAutomationStore.setState({ activeRequests: new Map() });
    const settled = selectWarmBrowserTabIds(tabs, "ws-a", "thread-a", "tab-0");
    expect(settled.size).toBe(3);
    expect(settled.has("tab-0")).toBe(true);
  });

  it("bounds active requests while keeping the newest in-flight target visible for cancellation", () => {
    useBrowserAutomationStore.setState({ activeRequests: new Map() });
    const requests = Array.from({ length: BROWSER_AUTOMATION_MAX_PENDING_REQUESTS + 1 }, (_, index) => {
      const activeDispatch = {
        request: { workspaceId: "ws-a", requestId: `request-${index}`, sequence: index },
        target: { threadId: "thread-a", tabId: `tab-${index}` },
      } as BrowserAutomationActiveRequest["dispatch"];
      return {
        dispatch: activeDispatch,
        startedAt: index,
      };
    });

    for (const request of requests) useBrowserAutomationStore.getState().setActiveRequest(request);

    const activeRequests = useBrowserAutomationStore.getState().activeRequests;
    const newest = requests.at(-1)!;
    const newestRequestId = `request-${BROWSER_AUTOMATION_MAX_PENDING_REQUESTS}`;
    expect(activeRequests).toHaveLength(BROWSER_AUTOMATION_MAX_PENDING_REQUESTS);
    expect(activeRequests.has(browserAutomationRequestKey("request-0", 0))).toBe(false);
    expect(activeRequests.has(browserAutomationRequestKey(
      newestRequestId,
      BROWSER_AUTOMATION_MAX_PENDING_REQUESTS,
    ))).toBe(true);
    expect(selectWarmBrowserTabIds(
      requests.map((request) => ({ id: request.dispatch.target.tabId })),
      "ws-a",
      "thread-a",
      "tab-0",
    )).toContain("tab-32");

    useBrowserAutomationStore.getState().clearActiveRequest(
      newest.dispatch.request.requestId,
      newest.dispatch.request.sequence,
    );
    expect(useBrowserAutomationStore.getState().activeRequests.has(
      browserAutomationRequestKey(newestRequestId, BROWSER_AUTOMATION_MAX_PENDING_REQUESTS),
    )).toBe(false);
  });

  it("does not reattach a detached target after a late refresh", () => {
    const workspaceId = "workspace-late-refresh";
    const threadId = "thread-late-refresh";
    const tabId = "tab-late-refresh";
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    const store = useBrowserAutomationStore.getState();

    store.unregisterTarget(workspaceId, threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    const attachedRevision = useBrowserAutomationStore.getState().liveTargets.get(key)?.revision;
    expect(attachedRevision).toBeDefined();

    store.refreshTarget(workspaceId, threadId, tabId);
    expect(useBrowserAutomationStore.getState().liveTargets.get(key)?.revision).toBe(
      attachedRevision! + 1,
    );

    store.detachTarget(workspaceId, threadId, tabId);
    store.refreshTarget(workspaceId, threadId, tabId);

    expect(useBrowserAutomationStore.getState().liveTargets.has(key)).toBe(false);
    expect(browserTargetRegistry.get(workspaceId, threadId, tabId)?.attached).toBe(false);

    store.unregisterTarget(workspaceId, threadId, tabId);
  });

  it("interrupts a detached viewport host without creating a Regular-mode viewport on remount", async () => {
    const workspaceId = "workspace-viewport-remount";
    const threadId = "thread-viewport-remount";
    const tabId = "tab-viewport-remount";
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    const store = useBrowserAutomationStore.getState();
    store.unregisterTarget(workspaceId, threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    const target = useBrowserAutomationStore.getState().liveTargets.get(key)!;
    let resolveHost!: (result: { status: "applied"; applied: { width: number; height: number } }) => void;
    const coordinator = new ViewportCoordinator({
      initial: { width: 1280, height: 800 },
      targetGeneration: target.revision,
      apply: () => new Promise((resolve) => { resolveHost = resolve; }),
    });
    store.setViewportCoordinator(workspaceId, threadId, tabId, coordinator);

    const pending = coordinator.requestUserResize({ width: 900, height: 700 });
    store.detachTarget(workspaceId, threadId, tabId);
    expect(await pending).toMatchObject({ status: "stale", applied: { width: 1280, height: 800 } });
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toBeUndefined();
    expect(useBrowserAutomationStore.getState().viewportStateByTarget.get(key)?.confirmed).toEqual({ width: 1280, height: 800 });

    store.registerTarget(workspaceId, threadId, tabId);
    const remounted = useBrowserAutomationStore.getState().liveTargets.get(key)!;
    expect(remounted.revision).toBeGreaterThan(target.revision);
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toBeUndefined();

    resolveHost({ status: "applied", applied: { width: 900, height: 700 } });
    await Promise.resolve();
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toBeUndefined();

    store.unregisterTarget(workspaceId, threadId, tabId);
  });

  it("does not let a late renderer write update a remounted target", async () => {
    const workspaceId = "workspace-viewport-late-renderer";
    const threadId = "thread-viewport-late-renderer";
    const tabId = "tab-viewport-late-renderer";
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    const store = useBrowserAutomationStore.getState();
    store.unregisterTarget(workspaceId, threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    const target = useBrowserAutomationStore.getState().liveTargets.get(key)!;
    let releaseLayout!: () => void;
    let lateWrite!: () => void;
    const coordinator = createViewportCoordinator({
      target: { threadId, tabId },
      initial: { width: 1280, height: 800 },
      targetGeneration: target.revision,
      surface: {
        setViewport: (size, operation, currentCoordinator) => {
          lateWrite = () => store.applyViewportIfCurrent(
            workspaceId,
            threadId,
            tabId,
            currentCoordinator,
            operation.targetGeneration,
            size,
          );
          return true;
        },
        readViewport: () => useBrowserAutomationStore.getState().viewportByTarget.get(key) ?? null,
        waitForLayout: () => new Promise<void>((resolve) => { releaseLayout = resolve; }),
      },
      onStateChange: (state, currentCoordinator) => store.setViewportState(
        workspaceId,
        threadId,
        tabId,
        state,
        currentCoordinator,
      ),
    });
    store.setViewportCoordinator(workspaceId, threadId, tabId, coordinator);

    const pending = coordinator.requestUserResize({ width: 900, height: 700 });
    await Promise.resolve();
    store.detachTarget(workspaceId, threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    lateWrite();
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toBeUndefined();

    releaseLayout();
    await pending;
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toBeUndefined();

    store.unregisterTarget(workspaceId, threadId, tabId);
  });

  it("clears a current renderer viewport when Regular mode resets the host", () => {
    const workspaceId = "workspace-viewport-reset";
    const threadId = "thread-viewport-reset";
    const tabId = "tab-viewport-reset";
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    const store = useBrowserAutomationStore.getState();
    store.unregisterTarget(workspaceId, threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    const target = useBrowserAutomationStore.getState().liveTargets.get(key)!;
    const coordinator = new ViewportCoordinator({
      initial: { width: 960, height: 640 },
      targetGeneration: target.revision,
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
    });
    store.setViewportCoordinator(workspaceId, threadId, tabId, coordinator);
    store.applyViewportIfCurrent(workspaceId, threadId, tabId, coordinator, target.revision, {
      width: 960,
      height: 640,
    });

    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toEqual({
      width: 960,
      height: 640,
    });
    expect(store.resetViewportIfCurrent(workspaceId, threadId, tabId, coordinator, target.revision)).toBe(true);
    store.setViewportState(workspaceId, threadId, tabId, {
      ...coordinator.snapshot(),
      mode: "regular",
    }, coordinator);
    expect(useBrowserAutomationStore.getState().viewportByTarget.has(key)).toBe(false);

    store.unregisterTarget(workspaceId, threadId, tabId);
  });

  it("routes authoritative thread and workspace cleanup to exact host scopes", () => {
    const listener = vi.fn();
    const unsubscribe = onBrowserAutomationScopeRelease(listener);
    releaseBrowserAutomationThreadScope("workspace-a", "thread-a");
    releaseBrowserAutomationWorkspaceScopes("workspace-a");
    expect(listener.mock.calls).toEqual([
      [{ workspaceId: "workspace-a", threadId: "thread-a" }],
      [{ workspaceId: "workspace-a" }],
    ]);
    unsubscribe();
    releaseBrowserAutomationThreadScope("workspace-b", "thread-b");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("notifies exact human-input listeners without changing controller state", () => {
    useBrowserAutomationStore.getState().registerTarget("workspace-a", "thread-a", "tab-a");
    useBrowserAutomationStore.getState().setControllerForTarget("workspace-a", "thread-a", "tab-a", {
      tabId: "tab-a",
      controller: "agent",
      controlEpoch: 3,
    });
    const listener = vi.fn();
    const unsubscribe = onBrowserAutomationObservationInvalidation(listener);

    invalidateBrowserAutomationTargetObservation("workspace-a", "thread-a", "tab-a");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("workspace-a", "thread-a", "tab-a");
    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("workspace-a", "thread-a", "tab-a"),
    )).toEqual({ tabId: "tab-a", controller: "agent", controlEpoch: 3 });
    unsubscribe();
  });

  it("shows agent control on only the latest Browser page in one thread", () => {
    const store = useBrowserAutomationStore.getState();
    store.registerTarget("workspace-agent", "thread-agent", "tab-first");
    store.registerTarget("workspace-agent", "thread-agent", "tab-second");
    store.setControllerForTarget("workspace-agent", "thread-agent", "tab-first", {
      tabId: "tab-first",
      controller: "agent",
      controlEpoch: 1,
    });
    store.setControllerForTarget("workspace-agent", "thread-agent", "tab-second", {
      tabId: "tab-second",
      controller: "agent",
      controlEpoch: 2,
    });

    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("workspace-agent", "thread-agent", "tab-first"),
    )).toEqual({ tabId: "tab-first", controller: "none", controlEpoch: 1 });
    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("workspace-agent", "thread-agent", "tab-second"),
    )).toEqual({ tabId: "tab-second", controller: "agent", controlEpoch: 2 });

    store.releaseThreadTargets("workspace-agent", "thread-agent");
  });
});
