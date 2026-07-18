import { describe, expect, it, vi } from "vitest";
import {
  createPipeSessionState,
  handleRpcRequest,
  type RouterDeps,
} from "../browser-use/router.js";
import { TabIdMap } from "../browser-use/tab-id-map.js";
import type { BrowserHostBridge, BrowserHostSnapshot } from "../browser-use/host-bridge.js";

function makeSnapshot(threadId = "thread-1"): BrowserHostSnapshot {
  return {
    threadId,
    windowId: 1,
    activeWebContents: null,
    tabs: [
      { id: "tab-A", threadId, url: "https://a.test", title: "A", active: true },
      { id: "tab-B", threadId, url: "https://b.test", title: "B", active: false },
    ],
  };
}

function makeDeps(overrides?: Partial<{
  host: BrowserHostBridge;
  ensurePanelOpen: () => Promise<BrowserHostSnapshot | null>;
  appVersion: string;
}>): { deps: RouterDeps; broadcasts: Array<{ method: string; params: unknown }> } {
  const broadcasts: Array<{ method: string; params: unknown }> = [];
  const defaultHost: BrowserHostBridge = {
    getActiveSnapshot: vi.fn(() => makeSnapshot()),
    getSnapshotForThread: vi.fn(() => makeSnapshot()),
    attachDebugger: vi.fn(async () => undefined),
    detachDebugger: vi.fn(async () => undefined),
    executeCdp: vi.fn(async () => ({ result: "cdp-ok" })),
    subscribeCdpEvents: vi.fn(() => () => undefined),
  };
  const deps: RouterDeps = {
    host: overrides?.host ?? defaultHost,
    tabIds: new TabIdMap(),
    state: createPipeSessionState(),
    broadcast: (notification) => broadcasts.push(notification),
    ensurePanelOpen: overrides?.ensurePanelOpen ?? (async () => null),
    appVersion: overrides?.appVersion ?? "0.0.0-test",
  };
  return { deps, broadcasts };
}

describe("browser-use router", () => {
  it("ping returns 'pong' without a session_id", async () => {
    const { deps } = makeDeps();
    await expect(handleRpcRequest(deps, "ping", {})).resolves.toBe("pong");
  });

  it("getInfo returns Mcode metadata with optional codexSessionId", async () => {
    const { deps } = makeDeps({ appVersion: "1.2.3" });
    const r1 = (await handleRpcRequest(deps, "getInfo", {})) as Record<string, unknown>;
    expect(r1).toMatchObject({ name: "Mcode In-app Browser", version: "1.2.3", type: "iab" });
    expect(r1.metadata).toBeUndefined();

    const r2 = (await handleRpcRequest(deps, "getInfo", { session_id: "s-1" })) as Record<
      string,
      unknown
    >;
    expect(r2).toMatchObject({ metadata: { codexSessionId: "s-1" } });
  });

  it("getTabs requires session_id and tracks integer ids", async () => {
    const { deps } = makeDeps();
    await expect(handleRpcRequest(deps, "getTabs", {})).rejects.toThrow(/session_id/);

    const rows = (await handleRpcRequest(deps, "getTabs", { session_id: "s-1" })) as Array<{
      id: number;
      title: string;
      active: boolean;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(1);
    expect(rows[1]!.id).toBe(2);
    expect(rows[0]!.active).toBe(true); // host snapshot says tab-A is active
  });

  it("attach subscribes to CDP events for the chosen tab and broadcasts onCDPEvent", async () => {
    const host: BrowserHostBridge = {
      getActiveSnapshot: vi.fn(() => makeSnapshot()),
      getSnapshotForThread: vi.fn(() => makeSnapshot()),
      attachDebugger: vi.fn(async () => undefined),
      detachDebugger: vi.fn(async () => undefined),
      executeCdp: vi.fn(),
      subscribeCdpEvents: vi.fn((_target, listener) => {
        // Simulate a CDP event during the subscription.
        queueMicrotask(() =>
          listener({ method: "Network.requestWillBeSent", params: { foo: 1 } }),
        );
        return () => undefined;
      }),
    };
    const { deps, broadcasts } = makeDeps({ host });

    // Seed tab tracking via getTabs so the integer id is known.
    await handleRpcRequest(deps, "getTabs", { session_id: "s-1" });
    await handleRpcRequest(deps, "attach", { session_id: "s-1", tabId: 1 });

    // Yield to microtask queue so the listener fires.
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    expect(host.attachDebugger).toHaveBeenCalledWith("thread-1", "tab-A");
    expect(broadcasts).toHaveLength(1);
    const note = broadcasts[0]!;
    expect(note.method).toBe("onCDPEvent");
    expect(note.params).toMatchObject({
      source: { tabId: 1 },
      method: "Network.requestWillBeSent",
    });
  });

  it("detach drops the subscription disposer for the session", async () => {
    const dispose = vi.fn();
    const host: BrowserHostBridge = {
      getActiveSnapshot: vi.fn(() => makeSnapshot()),
      getSnapshotForThread: vi.fn(() => makeSnapshot()),
      attachDebugger: vi.fn(async () => undefined),
      detachDebugger: vi.fn(async () => undefined),
      executeCdp: vi.fn(),
      subscribeCdpEvents: vi.fn(() => dispose),
    };
    const { deps } = makeDeps({ host });

    await handleRpcRequest(deps, "getTabs", { session_id: "s-1" });
    await handleRpcRequest(deps, "attach", { session_id: "s-1", tabId: 1 });
    await handleRpcRequest(deps, "detach", { session_id: "s-1" });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("executeCdp forwards method + commandParams to host with resolved tab", async () => {
    const { deps } = makeDeps();
    await handleRpcRequest(deps, "getTabs", { session_id: "s-1" });

    await handleRpcRequest(deps, "executeCdp", {
      session_id: "s-1",
      method: "Page.navigate",
      commandParams: { url: "https://x.test" },
      target: { tabId: 2 },
    });

    expect(deps.host.executeCdp).toHaveBeenCalledWith({
      threadId: "thread-1",
      tabId: "tab-B",
      method: "Page.navigate",
      params: { url: "https://x.test" },
    });
  });

  it("executeCdp without a target uses the previously selected tab", async () => {
    const { deps } = makeDeps();
    await handleRpcRequest(deps, "getTabs", { session_id: "s-1" });
    await handleRpcRequest(deps, "attach", { session_id: "s-1", tabId: 2 });

    await handleRpcRequest(deps, "executeCdp", {
      session_id: "s-1",
      method: "Runtime.evaluate",
      commandParams: { expression: "1+1" },
    });

    expect(deps.host.executeCdp).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "tab-B", method: "Runtime.evaluate" }),
    );
  });

  it("rejects unknown methods", async () => {
    const { deps } = makeDeps();
    await expect(handleRpcRequest(deps, "totally.unknown", {})).rejects.toThrow(
      /No handler/,
    );
  });

  it("nameSession requires session_id and name", async () => {
    const { deps } = makeDeps();
    await expect(
      handleRpcRequest(deps, "nameSession", { session_id: "s-1" }),
    ).rejects.toThrow(/name/);
    await expect(
      handleRpcRequest(deps, "nameSession", { session_id: "s-1", name: "codex-1" }),
    ).resolves.toEqual({});
  });
});

describe("TabIdMap", () => {
  it("returns stable integer ids for the same (threadId, tabId)", async () => {
    const { TabIdMap } = await import("../browser-use/tab-id-map.js");
    const map = new TabIdMap();
    const a = map.track("t", "A");
    const b = map.track("t", "A");
    expect(a.id).toBe(b.id);
    const c = map.track("t", "B");
    expect(c.id).not.toBe(a.id);
    expect(map.byTrackedId(a.id)).toEqual(a);
    expect(map.byTrackedId(9999)).toBeNull();
  });

  it("untrack frees an id for cleanup", async () => {
    const { TabIdMap } = await import("../browser-use/tab-id-map.js");
    const map = new TabIdMap();
    const t = map.track("t", "A");
    map.untrack("t", "A");
    expect(map.byTrackedId(t.id)).toBeNull();
  });

  it("does not collide when thread and tab ids contain delimiters", async () => {
    const { TabIdMap } = await import("../browser-use/tab-id-map.js");
    const map = new TabIdMap();
    const first = map.track("a:b", "c");
    const second = map.track("a", "b:c");
    expect(first.id).not.toBe(second.id);
    expect(map.byTrackedId(first.id)).toMatchObject({ threadId: "a:b", tabId: "c" });
    expect(map.byTrackedId(second.id)).toMatchObject({ threadId: "a", tabId: "b:c" });
  });
});
