import { describe, expect, it, vi } from "vitest";
import {
  browserAutomationRequestKey,
  browserAutomationTargetKey,
  onBrowserAutomationScopeRelease,
  releaseBrowserAutomationThreadScope,
  releaseBrowserAutomationWorkspaceScopes,
  resolveBrowserAutomationControllerTarget,
  selectWarmBrowserTabIds,
  useBrowserAutomationStore,
  type BrowserAutomationLiveTarget,
} from "../browserAutomationStore";
import { selectBrowserAutomationWorkspaceIds } from "@/components/panels/BrowserAutomationHost";
import { reconcileWarmPreviewScopes } from "@/components/panels/RightPanel";

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
