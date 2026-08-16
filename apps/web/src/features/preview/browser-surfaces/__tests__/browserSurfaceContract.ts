import { describe, expect, it } from "vitest";
import {
  BrowserSurfaceHost,
  type BrowserSurfaceAdapterEvent,
  type BrowserSurfaceAdapterEventPayload,
  type BrowserSurfaceAdapterFactory,
  type BrowserSurfaceIdentity,
  type BrowserSurfaceScheduling,
} from "../BrowserSurfaceHost";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "contract-workspace",
  scope: { kind: "thread", id: "contract-thread" },
  tabId: "contract-tab",
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

interface AdapterGenerationRecord {
  readonly identity: BrowserSurfaceIdentity;
  readonly generation: number;
  subscribeCalls: number;
}

interface ContractFixture {
  readonly host: BrowserSurfaceHost;
  readonly scheduling: TestScheduling;
  readonly records: AdapterGenerationRecord[];
  readonly activeAdapterCount: () => number;
  readonly activeSubscriptionCount: () => number;
}

function trackedFactory(adapterFactory: BrowserSurfaceAdapterFactory): {
  factory: BrowserSurfaceAdapterFactory;
  records: AdapterGenerationRecord[];
  activeAdapterCount: () => number;
  activeSubscriptionCount: () => number;
} {
  const records: AdapterGenerationRecord[] = [];
  let activeAdapters = 0;
  let activeSubscriptions = 0;

  const factory: BrowserSurfaceAdapterFactory = (identity, generation) => {
    const adapter = adapterFactory(identity, generation);
    const record: AdapterGenerationRecord = { identity, generation, subscribeCalls: 0 };
    records.push(record);
    activeAdapters += 1;

    const subscribe = adapter.subscribe.bind(adapter);
    adapter.subscribe = (listener) => {
      record.subscribeCalls += 1;
      activeSubscriptions += 1;
      const stop = subscribe(listener);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        activeSubscriptions -= 1;
        stop();
      };
    };

    const dispose = adapter.dispose.bind(adapter);
    let disposed = false;
    adapter.dispose = (reason) => {
      if (!disposed) {
        disposed = true;
        activeAdapters -= 1;
      }
      dispose(reason);
    };
    return adapter;
  };

  return {
    factory,
    records,
    activeAdapterCount: () => activeAdapters,
    activeSubscriptionCount: () => activeSubscriptions,
  };
}

function contractFixture(adapterFactory: BrowserSurfaceAdapterFactory): ContractFixture {
  const tracked = trackedFactory(adapterFactory);
  const scheduling = new TestScheduling();
  return {
    host: new BrowserSurfaceHost({ adapterFactory: tracked.factory, scheduling }),
    scheduling,
    records: tracked.records,
    activeAdapterCount: tracked.activeAdapterCount,
    activeSubscriptionCount: tracked.activeSubscriptionCount,
  };
}

function eventFor(
  identity: BrowserSurfaceIdentity,
  generation: number,
  event: BrowserSurfaceAdapterEventPayload,
): BrowserSurfaceAdapterEvent {
  return { ...event, identity, generation } as BrowserSurfaceAdapterEvent;
}

function identityKey(identity: BrowserSurfaceIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.scope.kind, identity.scope.id, identity.tabId]);
}

/** Runs the durable lifecycle contract against any Browser surface adapter. */
export function runBrowserSurfaceContract(name: string, adapterFactory: BrowserSurfaceAdapterFactory): void {
  describe(name, () => {
    it("isolates every identity field", () => {
      const fixture = contractFixture(adapterFactory);
      const { host, scheduling } = fixture;
      const variants: BrowserSurfaceIdentity[] = [
        { ...IDENTITY, workspaceId: "other-workspace" },
        { ...IDENTITY, scope: { kind: "workspace", id: IDENTITY.scope.id } },
        { ...IDENTITY, scope: { kind: "thread", id: "other-thread" } },
        { ...IDENTITY, tabId: "other-tab" },
      ];
      const identities = [IDENTITY, ...variants];
      const snapshots = new Map(identities.map((identity) => [identityKey(identity), host.create(identity)]));
      const publications = new Map<string, number>();
      for (const identity of identities) {
        publications.set(identityKey(identity), 0);
        host.subscribe(identity, () => {
          publications.set(identityKey(identity), publications.get(identityKey(identity))! + 1);
        });
      }

      const primary = snapshots.get(identityKey(IDENTITY))!;
      host.handleEvent(eventFor(IDENTITY, primary.generation, { type: "title-updated", title: "primary" }));
      scheduling.flush();

      expect(host.getSnapshot(IDENTITY)?.title).toBe("primary");
      expect(publications.get(identityKey(IDENTITY))).toBe(1);
      for (const identity of variants) {
        expect(host.getSnapshot(identity)).toBe(snapshots.get(identityKey(identity)));
        expect(publications.get(identityKey(identity))).toBe(0);
      }
      fixture.records.forEach((record) => expect(record.subscribeCalls).toBe(1));
      host.disposeHost();
    });

    it("creates, presents, and hides without remounting", () => {
      const baselineChildren = document.body.childElementCount;
      const fixture = contractFixture(adapterFactory);
      const { host } = fixture;
      const snapshot = host.create(IDENTITY);

      host.present(IDENTITY, { left: 0, top: 0, width: 640, height: 480 });
      host.hide(IDENTITY);

      expect(host.ensure(IDENTITY)).toBe(snapshot);
      expect(fixture.records).toHaveLength(1);
      expect(fixture.records[0]?.subscribeCalls).toBe(1);
      expect(fixture.activeAdapterCount()).toBe(1);
      expect(fixture.activeSubscriptionCount()).toBe(1);
      expect(document.body.childElementCount).toBe(baselineChildren + 1);

      host.dispose(IDENTITY);
      expect(fixture.activeAdapterCount()).toBe(0);
      expect(fixture.activeSubscriptionCount()).toBe(0);
      expect(document.body.childElementCount).toBe(baselineChildren);
      host.disposeHost();
    });

    it("does not publish no-op state changes and preserves the snapshot object", () => {
      const fixture = contractFixture(adapterFactory);
      const { host, scheduling } = fixture;
      const initial = host.create(IDENTITY);
      const publications: string[] = [];
      host.subscribe(IDENTITY, (snapshot) => publications.push(snapshot.title));

      host.handleEvent(eventFor(IDENTITY, initial.generation, {
        type: "navigation-state",
        navigation: { canGoBack: false, canGoForward: false },
      }));
      scheduling.flush();
      publications.length = 0;
      const knownNavigation = host.getSnapshot(IDENTITY)!;

      host.handleEvent(eventFor(IDENTITY, initial.generation, {
        type: "navigation-state",
        navigation: { canGoBack: false, canGoForward: false },
      }));
      scheduling.flush();

      expect(host.getSnapshot(IDENTITY)).toBe(knownNavigation);
      expect(publications).toEqual([]);
      host.disposeHost();
    });

    it("publishes changed state at most once per frame", () => {
      const fixture = contractFixture(adapterFactory);
      const { host, scheduling } = fixture;
      const initial = host.create(IDENTITY);
      const publications: string[] = [];
      host.subscribe(IDENTITY, (snapshot) => publications.push(snapshot.title));

      host.handleEvent(eventFor(IDENTITY, initial.generation, { type: "title-updated", title: "A" }));
      host.handleEvent(eventFor(IDENTITY, initial.generation, { type: "title-updated", title: "B" }));
      expect(scheduling.frames.size).toBe(1);
      scheduling.flush();
      expect(publications).toEqual(["B"]);

      host.handleEvent(eventFor(IDENTITY, initial.generation, { type: "title-updated", title: "C" }));
      scheduling.flush();
      expect(publications).toEqual(["B", "C"]);
      host.disposeHost();
    });

    it("does not publish an unrelated identity", () => {
      const fixture = contractFixture(adapterFactory);
      const { host, scheduling } = fixture;
      const other: BrowserSurfaceIdentity = { ...IDENTITY, tabId: "other-tab" };
      const primary = host.create(IDENTITY);
      const otherSnapshot = host.create(other);
      const primaryPublications: string[] = [];
      const otherPublications: string[] = [];
      host.subscribe(IDENTITY, (snapshot) => primaryPublications.push(snapshot.title));
      host.subscribe(other, (snapshot) => otherPublications.push(snapshot.title));

      host.handleEvent(eventFor(IDENTITY, primary.generation, { type: "title-updated", title: "primary" }));
      scheduling.flush();

      expect(primaryPublications).toEqual(["primary"]);
      expect(otherPublications).toEqual([]);
      expect(host.getSnapshot(other)).toBe(otherSnapshot);
      host.disposeHost();
    });

    it("advances generation on discard and rejects late old events", () => {
      const fixture = contractFixture(adapterFactory);
      const { host, scheduling } = fixture;
      const first = host.create(IDENTITY, { address: "https://example.test/recovery" });
      const publications: string[] = [];
      host.subscribe(IDENTITY, (snapshot) => publications.push(snapshot.title));

      expect(host.discard(IDENTITY, first.generation)).toBe(true);
      expect(host.getSnapshot(IDENTITY)).toBeNull();
      const second = host.ensure(IDENTITY);
      expect(second.generation).toBe(first.generation + 1);
      expect(fixture.records).toHaveLength(2);
      expect(fixture.records.every((record) => record.subscribeCalls === 1)).toBe(true);
      scheduling.flush();
      publications.length = 0;

      host.handleEvent(eventFor(IDENTITY, first.generation, { type: "title-updated", title: "old" }));
      scheduling.flush();

      expect(host.getSnapshot(IDENTITY)).toBe(second);
      expect(second.title).toBe("");
      expect(publications).toEqual([]);
      host.disposeHost();
    });

    it("disposes exact identities, scopes, and workspaces", () => {
      const baselineChildren = document.body.childElementCount;
      const fixture = contractFixture(adapterFactory);
      const { host } = fixture;
      const sibling: BrowserSurfaceIdentity = {
        ...IDENTITY,
        tabId: "sibling-tab",
      };
      const otherScope: BrowserSurfaceIdentity = {
        ...IDENTITY,
        scope: { kind: "thread", id: "other-scope" },
        tabId: "other-scope-tab",
      };
      const otherWorkspace: BrowserSurfaceIdentity = {
        ...IDENTITY,
        workspaceId: "other-workspace",
        tabId: "other-workspace-tab",
      };
      for (const identity of [IDENTITY, sibling, otherScope, otherWorkspace]) host.create(identity);

      host.dispose(IDENTITY);
      expect(host.getSnapshot(IDENTITY)).toBeNull();
      expect(host.getSnapshot(sibling)).not.toBeNull();

      host.disposeScope(IDENTITY.workspaceId, IDENTITY.scope);
      expect(host.getSnapshot(sibling)).toBeNull();
      expect(host.getSnapshot(otherScope)).not.toBeNull();
      expect(host.getSnapshot(otherWorkspace)).not.toBeNull();

      host.disposeWorkspace(IDENTITY.workspaceId);
      expect(host.getSnapshot(otherScope)).toBeNull();
      expect(host.getSnapshot(otherWorkspace)).not.toBeNull();

      host.disposeWorkspace(otherWorkspace.workspaceId);
      expect(host.getSnapshot(otherWorkspace)).toBeNull();
      expect(fixture.activeAdapterCount()).toBe(0);
      expect(fixture.activeSubscriptionCount()).toBe(0);
      expect(document.body.childElementCount).toBe(baselineChildren);
      host.disposeHost();
    });

    it("returns fixture resources to baseline after 25 lifecycle cycles", () => {
      const baselineChildren = document.body.childElementCount;
      const fixture = contractFixture(adapterFactory);
      const { host, scheduling } = fixture;
      const identity: BrowserSurfaceIdentity = { ...IDENTITY, tabId: "cycle-tab" };
      const baselineFrames = scheduling.frames.size;
      const publications: string[] = [];

      for (let cycle = 0; cycle < 25; cycle += 1) {
        const first = host.create(identity);
        const unsubscribe = host.subscribe(identity, (snapshot) => publications.push(snapshot.title));
        host.present(identity, { left: 0, top: 0, width: 640, height: 480 });
        host.hide(identity);
        expect(host.discard(identity, first.generation)).toBe(true);
        const rewarmed = host.ensure(identity);
        expect(rewarmed.generation).toBe(first.generation + 1);
        host.dispose(identity);

        host.handleEvent(eventFor(identity, rewarmed.generation, { type: "title-updated", title: "late" }));
        scheduling.flush();
        unsubscribe();

        expect(host.getSnapshot(identity)).toBeNull();
        expect(publications).toEqual([]);
        expect(fixture.activeAdapterCount()).toBe(0);
        expect(fixture.activeSubscriptionCount()).toBe(0);
        expect(document.body.childElementCount).toBe(baselineChildren);
        expect(scheduling.frames.size).toBe(baselineFrames);
      }

      expect(fixture.records).toHaveLength(50);
      expect(fixture.records.every((record) => record.subscribeCalls === 1)).toBe(true);
      expect(fixture.activeAdapterCount()).toBe(0);
      expect(fixture.activeSubscriptionCount()).toBe(0);
      expect(document.body.childElementCount).toBe(baselineChildren);
      host.disposeHost();
    });
  });
}
