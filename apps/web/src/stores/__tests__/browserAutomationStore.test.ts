import { describe, expect, it, vi } from "vitest";
import { BROWSER_AUTOMATION_MAX_PENDING_REQUESTS } from "@mcode/contracts";
import {
  browserAutomationRequestKey,
  browserAutomationTargetKey,
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
import type { BrowserSessionLifecycleTab } from "@/services/browser-automation/browserSessionDriver";
import { selectBrowserAutomationWorkspaceIds } from "@/components/panels/BrowserAutomationHost";
import { reconcileWarmPreviewScopes } from "@/components/panels/RightPanel";
import { browserTargetRegistry } from "@/services/browser-automation/browserTargetRegistry";

function target(
  workspaceId: string,
  threadId: string,
  tabId: string,
  lastUsedAt = 1,
): BrowserAutomationLiveTarget {
  return { workspaceId, threadId, tabId, lastUsedAt, revision: 1 };
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

    useBrowserAutomationStore.getState().releaseThreadTargets("thread-a");
    expect([...useBrowserAutomationStore.getState().lifecycleTabs.values()]).toEqual([
      expect.objectContaining({ workspaceId: "workspace-b", threadId: "thread-b", tabId: "tab-b" }),
    ]);

    useBrowserAutomationStore.getState().releaseWorkspaceTargets("workspace-b");
    expect(useBrowserAutomationStore.getState().lifecycleTabs).toHaveLength(0);
  });

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

  it("notifies exact human-input listeners without changing controller state", () => {
    useBrowserAutomationStore.getState().registerTarget("workspace-a", "thread-a", "tab-a");
    useBrowserAutomationStore.getState().setControllerForTarget("thread-a", "tab-a", {
      tabId: "tab-a",
      controller: "agent",
      controlEpoch: 3,
    });
    const listener = vi.fn();
    const unsubscribe = onBrowserAutomationObservationInvalidation(listener);

    invalidateBrowserAutomationTargetObservation("thread-a", "tab-a");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("thread-a", "tab-a");
    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("thread-a", "tab-a"),
    )).toEqual({ tabId: "tab-a", controller: "agent", controlEpoch: 3 });
    unsubscribe();
  });

  it("shows agent control on only the latest Browser page in one thread", () => {
    const store = useBrowserAutomationStore.getState();
    store.registerTarget("workspace-agent", "thread-agent", "tab-first");
    store.registerTarget("workspace-agent", "thread-agent", "tab-second");
    store.setControllerForTarget("thread-agent", "tab-first", {
      tabId: "tab-first",
      controller: "agent",
      controlEpoch: 1,
    });
    store.setControllerForTarget("thread-agent", "tab-second", {
      tabId: "tab-second",
      controller: "agent",
      controlEpoch: 2,
    });

    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("thread-agent", "tab-first"),
    )).toEqual({ tabId: "tab-first", controller: "none", controlEpoch: 1 });
    expect(useBrowserAutomationStore.getState().controllers.get(
      browserAutomationTargetKey("thread-agent", "tab-second"),
    )).toEqual({ tabId: "tab-second", controller: "agent", controlEpoch: 2 });

    store.releaseThreadTargets("thread-agent");
  });
});
