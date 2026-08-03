import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_MAX_PENDING_REQUESTS } from "@mcode/contracts";
import {
  browserAutomationRequestKey,
  browserAutomationTargetKey,
  onBrowserAutomationScopeRelease,
  releaseBrowserAutomationThreadScope,
  releaseBrowserAutomationWorkspaceScopes,
  resolveBrowserAutomationControllerTarget,
  selectWarmBrowserTabIds,
  useBrowserAutomationStore,
  type BrowserAutomationActiveRequest,
  type BrowserAutomationLiveTarget,
} from "../browserAutomationStore";
import { selectBrowserAutomationWorkspaceIds } from "@/components/panels/BrowserAutomationHost";
import { reconcileWarmPreviewScopes } from "@/components/panels/RightPanel";
import { browserTargetRegistry } from "@/services/browser-automation/browserTargetRegistry";
import { ViewportCoordinator } from "@/services/browser-automation/viewportCoordinator";
import { createViewportCoordinator } from "@/services/browser-automation/viewportCoordinatorFactory";

function target(
  workspaceId: string,
  threadId: string,
  tabId: string,
  lastUsedAt = 1,
): BrowserAutomationLiveTarget {
  return { workspaceId, threadId, tabId, lastUsedAt, revision: 1 };
}

describe("browser automation renderer scope", () => {
  it("uses collision-proof tuple keys for adversarial external ids", () => {
    expect(browserAutomationTargetKey("a\u0000b", "c")).not.toBe(
      browserAutomationTargetKey("a", "b\u0000c"),
    );
    expect(browserAutomationRequestKey("request\u00001", 2)).not.toBe(
      browserAutomationRequestKey("request", 12),
    );
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
      new Set(["busy"]),
    );
    expect(result.map((scope) => scope.scopeId)).toEqual(["active", "busy", "recent"]);
  });

  it("bounds a 20-tab pool while preserving active and busy leases exactly", () => {
    const tabs = Array.from({ length: 20 }, (_, index) => ({ id: `tab-${index}` }));
    useBrowserAutomationStore.setState({
      liveTargets: new Map(tabs.map((tab, index) => [
        browserAutomationTargetKey("thread-a", tab.id),
        target("ws-a", "thread-a", tab.id, index),
      ])),
      activeRequests: new Map([1, 2, 3, 4].map((index) => {
        const activeDispatch = {
          target: { threadId: "thread-a", tabId: `tab-${index}` },
        } as never;
        return [`request-${index}`, { dispatch: activeDispatch, startedAt: index }];
      })),
    });
    const leased = selectWarmBrowserTabIds(tabs, "thread-a", "tab-0");
    expect(leased).toEqual(new Set(["tab-0", "tab-1", "tab-2", "tab-3", "tab-4"]));

    useBrowserAutomationStore.setState({ activeRequests: new Map() });
    const settled = selectWarmBrowserTabIds(tabs, "thread-a", "tab-0");
    expect(settled.size).toBe(3);
    expect(settled.has("tab-0")).toBe(true);
  });

  it("bounds active requests while keeping the newest in-flight target visible for cancellation", () => {
    useBrowserAutomationStore.setState({ activeRequests: new Map() });
    const requests = Array.from({ length: BROWSER_AUTOMATION_MAX_PENDING_REQUESTS + 1 }, (_, index) => {
      const activeDispatch = {
        request: { requestId: `request-${index}`, sequence: index },
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
    const key = browserAutomationTargetKey(threadId, tabId);
    const store = useBrowserAutomationStore.getState();

    store.unregisterTarget(threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    const attachedRevision = useBrowserAutomationStore.getState().liveTargets.get(key)?.revision;
    expect(attachedRevision).toBeDefined();

    store.refreshTarget(threadId, tabId);
    expect(useBrowserAutomationStore.getState().liveTargets.get(key)?.revision).toBe(
      attachedRevision! + 1,
    );

    store.detachTarget(threadId, tabId);
    store.refreshTarget(threadId, tabId);

    expect(useBrowserAutomationStore.getState().liveTargets.has(key)).toBe(false);
    expect(browserTargetRegistry.get(threadId, tabId)?.attached).toBe(false);

    store.unregisterTarget(threadId, tabId);
  });

  it("interrupts a detached viewport host and restores only confirmed state on remount", async () => {
    const workspaceId = "workspace-viewport-remount";
    const threadId = "thread-viewport-remount";
    const tabId = "tab-viewport-remount";
    const key = browserAutomationTargetKey(threadId, tabId);
    const store = useBrowserAutomationStore.getState();
    store.unregisterTarget(threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    const target = useBrowserAutomationStore.getState().liveTargets.get(key)!;
    let resolveHost!: (result: { status: "applied"; applied: { width: number; height: number } }) => void;
    const coordinator = new ViewportCoordinator({
      initial: { width: 1280, height: 800 },
      targetGeneration: target.revision,
      apply: () => new Promise((resolve) => { resolveHost = resolve; }),
    });
    store.setViewportCoordinator(threadId, tabId, coordinator);

    const pending = coordinator.requestUserResize({ width: 900, height: 700 });
    store.detachTarget(threadId, tabId);
    expect(await pending).toMatchObject({ status: "stale", applied: { width: 1280, height: 800 } });
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toEqual({ width: 1280, height: 800 });

    store.registerTarget(workspaceId, threadId, tabId);
    const remounted = useBrowserAutomationStore.getState().liveTargets.get(key)!;
    expect(remounted.revision).toBeGreaterThan(target.revision);
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toEqual({ width: 1280, height: 800 });

    resolveHost({ status: "applied", applied: { width: 900, height: 700 } });
    await Promise.resolve();
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toEqual({ width: 1280, height: 800 });

    store.unregisterTarget(threadId, tabId);
  });

  it("does not let a late renderer write update a remounted target", async () => {
    const workspaceId = "workspace-viewport-late-renderer";
    const threadId = "thread-viewport-late-renderer";
    const tabId = "tab-viewport-late-renderer";
    const key = browserAutomationTargetKey(threadId, tabId);
    const store = useBrowserAutomationStore.getState();
    store.unregisterTarget(threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    const target = useBrowserAutomationStore.getState().liveTargets.get(key)!;
    let releaseLayout!: () => void;
    let lateWrite!: () => void;
    const coordinator = createViewportCoordinator({
      target: { threadId, tabId },
      initial: { width: 1280, height: 800 },
      targetGeneration: target.revision,
      rendererHost: {
        setViewport: (size, operation, currentCoordinator) => {
          lateWrite = () => store.applyViewportIfCurrent(
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
        threadId,
        tabId,
        state,
        currentCoordinator,
      ),
    });
    store.setViewportCoordinator(threadId, tabId, coordinator);

    const pending = coordinator.requestUserResize({ width: 900, height: 700 });
    await Promise.resolve();
    store.detachTarget(threadId, tabId);
    store.registerTarget(workspaceId, threadId, tabId);
    lateWrite();
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toEqual({
      width: 1280,
      height: 800,
    });

    releaseLayout();
    await pending;
    expect(useBrowserAutomationStore.getState().viewportByTarget.get(key)).toEqual({
      width: 1280,
      height: 800,
    });

    store.unregisterTarget(threadId, tabId);
  });

  it("routes authoritative thread and workspace cleanup to exact host scopes", () => {
    const listener = vi.fn();
    const unsubscribe = onBrowserAutomationScopeRelease(listener);
    releaseBrowserAutomationThreadScope("thread-a");
    releaseBrowserAutomationWorkspaceScopes("workspace-a");
    expect(listener.mock.calls).toEqual([
      [{ threadId: "thread-a" }],
      [{ workspaceId: "workspace-a" }],
    ]);
    unsubscribe();
    releaseBrowserAutomationThreadScope("thread-b");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
