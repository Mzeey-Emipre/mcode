import { describe, expect, it } from "vitest";
import {
  BrowserSurfaceHost,
  type BrowserSurfaceAdapter,
  type BrowserSurfaceAdapterEvent,
  type BrowserSurfaceAdapterEventPayload,
  type BrowserSurfaceAdapterFactory,
  type BrowserSurfaceIdentity,
  type BrowserSurfacePresentation,
  type BrowserSurfaceScheduling,
  type BrowserSurfaceVisibility,
} from "../BrowserSurfaceHost";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-a",
  scope: { kind: "thread", id: "thread-a" },
  tabId: "tab-a",
};

class TestScheduling implements BrowserSurfaceScheduling {
  private nextHandle = 1;
  readonly frames = new Map<number, () => void>();

  requestAnimationFrame(callback: () => void): number {
    const handle = this.nextHandle++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelAnimationFrame(handle: number): void {
    this.frames.delete(handle);
  }

  flush(): void {
    const queued = [...this.frames.values()];
    this.frames.clear();
    for (const callback of queued) callback();
  }
}

class TestVisibility implements BrowserSurfaceVisibility {
  hidden = false;
  private readonly listeners = new Set<(hidden?: boolean) => void>();

  isHidden = (): boolean => this.hidden;

  subscribe = (listener: (hidden?: boolean) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener(hidden);
  }
}

class TestAdapter implements BrowserSurfaceAdapter {
  created = 0;
  presented = 0;
  hidden = 0;
  navigations: string[] = [];
  disposed = 0;
  readonly listeners = new Set<(event: BrowserSurfaceAdapterEvent) => void>();

  create(): void {
    this.created += 1;
  }

  present(_presentation?: BrowserSurfacePresentation): void {
    this.presented += 1;
  }

  hide(): void {
    this.hidden += 1;
  }

  navigate(address: string): void {
    this.navigations.push(address);
  }

  subscribe(listener: (event: BrowserSurfaceAdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed += 1;
    this.listeners.clear();
  }

  emit(event: BrowserSurfaceAdapterEventPayload, identity = IDENTITY, generation = 1): void {
    const complete = { ...event, identity, generation } as BrowserSurfaceAdapterEvent;
    for (const listener of [...this.listeners]) listener(complete);
  }
}

function key(identity: BrowserSurfaceIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.scope.kind, identity.scope.id, identity.tabId]);
}

function testHost(): { host: BrowserSurfaceHost; adapter: TestAdapter; scheduling: TestScheduling; visibility: TestVisibility } {
  const adapters = new Map<string, TestAdapter>();
  const scheduling = new TestScheduling();
  const visibility = new TestVisibility();
  const adapterFactory: BrowserSurfaceAdapterFactory = (identity) => {
    const adapter = new TestAdapter();
    adapters.set(key(identity), adapter);
    return adapter;
  };
  const host = new BrowserSurfaceHost({ adapterFactory, scheduling, visibility });
  host.create(IDENTITY);
  return { host, adapter: adapters.get(key(IDENTITY))!, scheduling, visibility };
}

describe("BrowserSurfaceHost", () => {
  it("keeps one adapter and generation when presentation reacquires a warm surface", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });

    const first = host.ensure(IDENTITY, { address: "https://example.test/" });
    host.hide(IDENTITY);
    const second = host.ensure(IDENTITY, { address: "https://example.test/" });
    host.present(IDENTITY, { left: 10, top: 20, width: 640, height: 480 });

    expect(second).toBe(first);
    expect(second.generation).toBe(first.generation);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.disposed).toBe(0);
    expect(adapters[0]?.hidden).toBe(1);
    expect(adapters[0]?.presented).toBe(1);
    host.disposeHost();
  });

  it("keeps canonical state synchronous and publishes once per frame", () => {
    const { host, adapter, scheduling } = testHost();
    const updates: string[] = [];
    host.subscribe(IDENTITY, (snapshot) => updates.push(snapshot.title));
    adapter.emit({ type: "title-updated", title: "A" });
    adapter.emit({ type: "title-updated", title: "B" });
    expect(host.getSnapshot(IDENTITY)?.title).toBe("B");
    expect(updates).toEqual([]);
    scheduling.flush();
    expect(updates).toEqual(["B"]);
  });

  it("reduces pending, commit, redirect, loading, error, title, favicon, and navigation", () => {
    const { host, adapter, scheduling } = testHost();
    adapter.emit({ type: "navigation-started", mainFrame: true, address: "https://example.test/start" });
    adapter.emit({ type: "navigation-committed", mainFrame: true, address: "https://example.test/redirect" });
    adapter.emit({ type: "title-updated", title: "x".repeat(500) });
    adapter.emit({ type: "favicon-updated", favicon: "https://example.test/icon" });
    adapter.emit({ type: "navigation-state", navigation: { canGoBack: true, canGoForward: false } });
    adapter.emit({ type: "document-access", access: "same-origin" });
    expect(host.getSnapshot(IDENTITY)).toMatchObject({
      pendingAddress: "https://example.test/start",
      committedAddress: "https://example.test/redirect",
      recoveryAddress: "https://example.test/redirect",
      title: "x".repeat(240),
      favicon: "https://example.test/icon",
      documentAccess: "same-origin",
      phase: "loading",
    });
    adapter.emit({ type: "load-stopped", mainFrame: true, address: "https://example.test/redirect" });
    expect(host.getSnapshot(IDENTITY)).toMatchObject({ pendingAddress: null, phase: "loaded" });
    adapter.emit({ type: "load-started", mainFrame: true, address: "https://example.test/fail" });
    adapter.emit({ type: "load-failed", mainFrame: true, address: "https://example.test/fail", error: "offline" });
    expect(host.getSnapshot(IDENTITY)).toMatchObject({ phase: "error", mainFrameError: "offline" });
    adapter.emit({ type: "load-stopped", mainFrame: true });
    expect(host.getSnapshot(IDENTITY)?.phase).toBe("error");
    adapter.emit({ type: "load-failed", mainFrame: true, expected: true, error: "aborted" });
    scheduling.flush();
  });

  it("ignores subframe events and semantic no-ops", () => {
    const { host, adapter, scheduling } = testHost();
    adapter.emit({ type: "navigation-started", mainFrame: false, address: "https://frame.test" });
    adapter.emit({ type: "title-updated", title: "" });
    adapter.emit({ type: "navigation-state", navigation: { canGoBack: false, canGoForward: false } });
    const withNavigation = host.getSnapshot(IDENTITY)!;
    adapter.emit({ type: "navigation-state", navigation: { canGoBack: false, canGoForward: false } });
    expect(host.getSnapshot(IDENTITY)).toBe(withNavigation);
    expect(scheduling.frames.size).toBe(1);
    scheduling.flush();
  });

  it("does not retain a stale failure from an older address after a later load succeeds", () => {
    const { host, adapter } = testHost();
    adapter.emit({ type: "navigation-started", mainFrame: true, address: "https://example.test/old" });
    adapter.emit({ type: "navigation-committed", mainFrame: true, address: "https://example.test/current" });
    adapter.emit({ type: "load-stopped", mainFrame: true, address: "https://example.test/current" });
    adapter.emit({ type: "load-failed", mainFrame: true, address: "https://example.test/old", error: "ERR_FAILED" });

    expect(host.getSnapshot(IDENTITY)).toMatchObject({
      phase: "loaded",
      committedAddress: "https://example.test/current",
      mainFrameError: null,
    });
    host.disposeHost();
  });

  it("pauses hidden publication and flushes latest state on visible", () => {
    const { host, adapter, scheduling, visibility } = testHost();
    const updates: string[] = [];
    host.subscribe(IDENTITY, (snapshot) => updates.push(snapshot.title));
    visibility.setHidden(true);
    adapter.emit({ type: "title-updated", title: "hidden" });
    expect(scheduling.frames.size).toBe(0);
    visibility.setHidden(false);
    expect(scheduling.frames.size).toBe(1);
    scheduling.flush();
    expect(updates).toEqual(["hidden"]);
  });

  it("cancels stale publication and publishes a replacement generation", () => {
    const { host, adapter, scheduling } = testHost();
    const generations: number[] = [];
    host.subscribe(IDENTITY, (snapshot) => generations.push(snapshot.generation));
    adapter.emit({ type: "title-updated", title: "old" });
    expect(scheduling.frames.size).toBe(1);
    const next = host.create(IDENTITY);
    expect(next.generation).toBe(2);
    scheduling.flush();
    expect(generations).toEqual([2]);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "https://user:password@example.test/",
    `https://example.test/${"x".repeat(5_000)}`,
  ])("rejects unsafe navigation addresses at the host boundary", (address) => {
    const { host, adapter } = testHost();
    const before = host.getSnapshot(IDENTITY);
    expect(() => host.navigate(IDENTITY, address)).toThrow(TypeError);
    expect(host.getSnapshot(IDENTITY)).toBe(before);
    expect(adapter.navigations).toEqual([]);
  });

  it("does not replace a current adapter with an explicit stale generation", () => {
    const adapters = new Map<string, TestAdapter>();
    const host = new BrowserSurfaceHost({
      adapterFactory: (identity) => {
        const adapter = new TestAdapter();
        adapters.set(key(identity), adapter);
        return adapter;
      },
    });
    const first = host.create(IDENTITY, { generation: 4 });
    const current = adapters.get(key(IDENTITY))!;
    expect(host.create(IDENTITY, { generation: 3 })).toBe(first);
    expect(current.disposed).toBe(0);
    expect(host.getSnapshot(IDENTITY)?.generation).toBe(4);
    host.disposeHost();
  });

  it("restores presentation when a visible surface generation is replaced", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    host.create(IDENTITY);
    host.present(IDENTITY, { left: 10, top: 20, width: 640, height: 480 });

    host.create(IDENTITY);

    expect(adapters).toHaveLength(2);
    expect(adapters[1]?.presented).toBe(1);
    host.disposeHost();
  });

  it("navigates only once when navigation re-warms a cold surface", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    const first = host.create(IDENTITY, { address: "https://example.test/start" });
    expect(host.discard(IDENTITY, first.generation)).toBe(true);

    host.navigate(IDENTITY, "https://example.test/next");

    expect(adapters[1]?.navigations).toEqual(["https://example.test/next"]);
    host.disposeHost();
  });

  it("discards to bounded cold metadata and re-warms the recovery address in a new generation", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    const first = host.create(IDENTITY, { address: "https://example.test/start" });
    adapters[0]!.emit({
      type: "navigation-committed",
      mainFrame: true,
      address: "https://example.test/recovery",
    });
    adapters[0]!.emit({ type: "title-updated", title: "Recovery title" });
    adapters[0]!.emit({ type: "favicon-updated", favicon: "https://example.test/icon.png" });

    expect(host.discard(IDENTITY, first.generation)).toBe(true);
    expect(adapters[0]!.disposed).toBe(1);
    expect(host.getSnapshot(IDENTITY)).toBeNull();
    expect(host.inspect(IDENTITY)).toEqual({
      identity: IDENTITY,
      residency: "cold",
      generation: first.generation,
      recoveryAddress: "https://example.test/recovery",
      title: "Recovery title",
      favicon: "https://example.test/icon.png",
    });
    expect(adapters).toHaveLength(1);

    const rewarmed = host.ensure(IDENTITY);
    expect(rewarmed.generation).toBe(first.generation + 1);
    expect(rewarmed.pendingAddress).toBe("https://example.test/recovery");
    expect(adapters).toHaveLength(2);
    expect(adapters[1]!.navigations).toEqual(["https://example.test/recovery"]);
    expect(host.inspect(IDENTITY)?.residency).toBe("warm");
    host.disposeHost();
  });

  it("protects visible, controlled, operation-pinned, and capture-pinned surfaces from discard", () => {
    const { host } = testHost();
    const generation = host.getSnapshot(IDENTITY)!.generation;

    host.present(IDENTITY);
    expect(host.discard(IDENTITY, generation)).toBe(false);
    host.hide(IDENTITY);

    host.setControlled(IDENTITY, true);
    expect(host.discard(IDENTITY, generation)).toBe(false);
    host.setControlled(IDENTITY, false);

    const releaseOperation = host.pinOperation(IDENTITY, generation);
    expect(host.discard(IDENTITY, generation)).toBe(false);
    releaseOperation();

    const releaseCapture = host.pinCapture(IDENTITY, generation);
    expect(host.discard(IDENTITY, generation)).toBe(false);
    releaseCapture();

    expect(host.discard(IDENTITY, generation)).toBe(true);
    host.disposeHost();
  });

  it("restores a protected unexpected loss and leaves an inactive loss cold", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    const first = host.create(IDENTITY, { address: "https://example.test/start" });
    adapters[0]!.emit({
      type: "navigation-committed",
      mainFrame: true,
      address: "https://example.test/recovery",
    });
    host.setControlled(IDENTITY, true);

    adapters[0]!.emit({ type: "surface-lost" });

    expect(host.getSnapshot(IDENTITY)?.generation).toBe(first.generation + 1);
    expect(adapters[1]!.navigations).toEqual(["https://example.test/recovery"]);
    host.setControlled(IDENTITY, false);
    adapters[1]!.emit({ type: "surface-lost" }, IDENTITY, first.generation + 1);
    expect(host.getSnapshot(IDENTITY)).toBeNull();
    expect(host.inspect(IDENTITY)?.residency).toBe("cold");
    expect(adapters).toHaveLength(2);
    host.disposeHost();
  });

  it("uses the main process generation after renderer state restarts", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    host.create(IDENTITY, { address: "https://example.test/recovery" });

    adapters[0]!.emit({ type: "surface-lost", nextGeneration: 8 });

    expect(host.getSnapshot(IDENTITY)?.generation).toBe(8);
    expect(adapters[1]!.navigations).toEqual(["https://example.test/recovery"]);
    host.disposeHost();
  });

  it("ignores a late loss event after a generation is already cold", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    const first = host.create(IDENTITY, { address: "https://example.test/recovery" });
    expect(host.discard(IDENTITY, first.generation)).toBe(true);
    host.setControlled(IDENTITY, true);

    host.handleEvent({ type: "surface-lost", identity: IDENTITY, generation: first.generation });

    expect(host.getSnapshot(IDENTITY)).toBeNull();
    expect(host.inspect(IDENTITY)?.residency).toBe("cold");
    expect(adapters).toHaveLength(1);
    host.disposeHost();
  });

  it("changes control ownership without changing the surface or generation", () => {
    const { host, adapter } = testHost();
    const snapshot = host.getSnapshot(IDENTITY)!;

    host.setControlled(IDENTITY, true);
    host.setControlled(IDENTITY, false);

    expect(host.getSnapshot(IDENTITY)).toBe(snapshot);
    expect(adapter.disposed).toBe(0);
    host.disposeHost();
  });

  it("disposes exact scopes and workspaces without allowing late resurrection", () => {
    const adapters: TestAdapter[] = [];
    const host = new BrowserSurfaceHost({
      adapterFactory: () => {
        const adapter = new TestAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    const sibling: BrowserSurfaceIdentity = {
      workspaceId: IDENTITY.workspaceId,
      scope: { kind: "thread", id: "thread-b" },
      tabId: "tab-b",
    };
    const otherWorkspace: BrowserSurfaceIdentity = {
      workspaceId: "workspace-b",
      scope: { kind: "thread", id: "thread-c" },
      tabId: "tab-c",
    };
    host.create(IDENTITY);
    host.create(sibling);
    host.create(otherWorkspace);

    host.disposeScope(IDENTITY.workspaceId, IDENTITY.scope);
    adapters[0]!.emit({ type: "surface-lost" });
    expect(host.inspect(IDENTITY)).toBeNull();
    expect(host.getSnapshot(sibling)).not.toBeNull();

    host.disposeWorkspace(IDENTITY.workspaceId);
    expect(host.inspect(sibling)).toBeNull();
    expect(host.getSnapshot(otherWorkspace)).not.toBeNull();
    host.disposeHost();
    expect(host.inspect(otherWorkspace)).toBeNull();
  });
});
