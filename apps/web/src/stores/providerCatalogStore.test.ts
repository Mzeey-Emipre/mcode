import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCatalogRequest, ProviderCatalogSnapshot } from "@/transport";
import { providerCatalogCacheKey, useProviderCatalogStore } from "./providerCatalogStore";

const REQUEST: ProviderCatalogRequest = {
  providerId: "codex",
  workspaceId: "workspace-1",
  threadId: "thread-1",
};
const SNAPSHOT: ProviderCatalogSnapshot = {
  providerId: "codex",
  context: { scope: "workspace", workspaceId: "workspace-1", threadId: "thread-1" },
  freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
  diagnostics: [],
  entries: [{
    kind: "skill",
    identity: { providerId: "codex", kind: "skill", nativeId: "review" },
    name: "review",
    description: "Review changes",
    source: "user",
  }],
  selectableAgents: [],
};
const STALE_SNAPSHOT: ProviderCatalogSnapshot = {
  ...SNAPSHOT,
  freshness: {
    status: "stale",
    fetchedAt: "2026-07-20T12:00:00.000Z",
    reason: "Provider returned its last known catalog",
  },
};

const getProviderCatalogMock = vi.fn(async () => SNAPSHOT);

vi.mock("@/transport", () => ({
  getTransport: () => ({ getProviderCatalog: getProviderCatalogMock }),
}));

describe("providerCatalogStore", () => {
  beforeEach(() => {
    getProviderCatalogMock.mockClear();
    useProviderCatalogStore.getState().reset();
  });

  it("loads and caches snapshots by provider and workspace context", async () => {
    await useProviderCatalogStore.getState().load(REQUEST);
    await useProviderCatalogStore.getState().load(REQUEST);

    const entry = useProviderCatalogStore.getState().entries[providerCatalogCacheKey(REQUEST)];
    expect(entry?.snapshot).toEqual(SNAPSHOT);
    expect(getProviderCatalogMock).toHaveBeenCalledTimes(1);
    expect(getProviderCatalogMock).toHaveBeenCalledWith(REQUEST);
  });

  it("caches a provider-stale snapshot until a local refresh boundary", async () => {
    getProviderCatalogMock.mockResolvedValueOnce(STALE_SNAPSHOT);

    await useProviderCatalogStore.getState().load(REQUEST);
    await useProviderCatalogStore.getState().load(REQUEST);

    const entry = useProviderCatalogStore.getState().entries[providerCatalogCacheKey(REQUEST)];
    expect(entry?.snapshot?.freshness).toEqual(STALE_SNAPSHOT.freshness);
    expect(entry?.needsRefresh).toBe(false);
    expect(getProviderCatalogMock).toHaveBeenCalledTimes(1);

    useProviderCatalogStore.getState().invalidate();
    await useProviderCatalogStore.getState().load(REQUEST);
    expect(getProviderCatalogMock).toHaveBeenCalledTimes(2);
  });

  it("single-flights only matching contexts", async () => {
    const sameFirst = useProviderCatalogStore.getState().load(REQUEST);
    const sameSecond = useProviderCatalogStore.getState().load(REQUEST);
    const other = useProviderCatalogStore.getState().load({
      ...REQUEST,
      threadId: "thread-2",
    });

    expect(sameFirst).toBe(sameSecond);
    expect(sameFirst).not.toBe(other);
    await Promise.all([sameFirst, sameSecond, other]);
  });

  it("retains the last snapshot when invalidated and refreshes on the next load", async () => {
    await useProviderCatalogStore.getState().load(REQUEST);
    useProviderCatalogStore.getState().invalidate();
    const stale = useProviderCatalogStore.getState().entries[providerCatalogCacheKey(REQUEST)];
    expect(stale?.snapshot).toEqual(SNAPSHOT);
    expect(stale?.needsRefresh).toBe(true);

    await useProviderCatalogStore.getState().load(REQUEST);
    expect(getProviderCatalogMock).toHaveBeenCalledTimes(2);
  });

  it("fences an in-flight result when invalidated", async () => {
    let resolveCatalog!: (snapshot: ProviderCatalogSnapshot) => void;
    getProviderCatalogMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCatalog = resolve; }),
    );

    const pending = useProviderCatalogStore.getState().load(REQUEST);
    useProviderCatalogStore.getState().invalidate();
    resolveCatalog(SNAPSHOT);
    await pending;

    const entry = useProviderCatalogStore.getState().entries[providerCatalogCacheKey(REQUEST)];
    expect(entry?.snapshot).toBeNull();
    expect(entry?.isLoading).toBe(false);
    expect(entry?.needsRefresh).toBe(true);
  });

  it("retries once after a WebSocket disconnect", async () => {
    const calls: number[] = [];
    vi.doMock("@/transport", () => ({
      getTransport: () => ({
        getProviderCatalog: vi.fn(async () => {
          calls.push(Date.now());
          if (calls.length === 1) throw new Error("WebSocket disconnected");
          return SNAPSHOT;
        }),
        waitForConnection: async () => undefined,
      }),
    }));
    vi.resetModules();
    const { useProviderCatalogStore: store } = await import("./providerCatalogStore");
    store.getState().reset();

    await expect(store.getState().load(REQUEST)).resolves.toEqual(SNAPSHOT);
    expect(calls).toHaveLength(2);
  });
});
