import { create } from "zustand";
import {
  getTransport,
  type ProviderCatalogRequest,
  type ProviderCatalogSnapshot,
} from "@/transport";
import type {
  ProviderCapabilityEntry,
  ProviderCatalogChange,
  SelectableProviderAgent,
} from "@mcode/contracts";

/** Cached provider catalog state for one discovery context. */
export interface ProviderCatalogCacheEntry {
  readonly snapshot: ProviderCatalogSnapshot | null;
  readonly isLoading: boolean;
  readonly needsRefresh: boolean;
  readonly error: Error | null;
  readonly inflight: Promise<ProviderCatalogSnapshot> | null;
  readonly loadEpoch: number;
  readonly lastFetchedAt: number;
}

/** Stable empty entry used by selectors before a catalog context has loaded. */
export const EMPTY_PROVIDER_CATALOG_CACHE_ENTRY: ProviderCatalogCacheEntry = Object.freeze({
  snapshot: null,
  isLoading: false,
  needsRefresh: true,
  error: null,
  inflight: null,
  loadEpoch: 0,
  lastFetchedAt: 0,
});

/** Builds a collision-safe cache key for one provider catalog request. */
export function providerCatalogCacheKey(request: ProviderCatalogRequest): string {
  return JSON.stringify([
    request.providerId,
    request.workspaceId ?? null,
    request.threadId ?? null,
    request.cwd ?? null,
  ]);
}

interface ProviderCatalogState {
  /** Catalogs keyed by {@link providerCatalogCacheKey}. */
  entries: Readonly<Record<string, ProviderCatalogCacheEntry>>;
  /** Loads one catalog context with per-key cache and single-flight behavior. */
  load(request: ProviderCatalogRequest, force?: boolean): Promise<ProviderCatalogSnapshot>;
  /** Marks every catalog stale while retaining visible rows during refresh. */
  invalidate(): void;
  /** Applies one server-produced identity reconciliation to a loaded context. */
  reconcile(change: ProviderCatalogChange): void;
  /** Clears every cached catalog and fences in-flight loads. */
  reset(): void;
}

const CACHE_TTL_MS = 5 * 60 * 1_000;

function replaceEntry(
  entries: Readonly<Record<string, ProviderCatalogCacheEntry>>,
  key: string,
  entry: ProviderCatalogCacheEntry,
): Readonly<Record<string, ProviderCatalogCacheEntry>> {
  return { ...entries, [key]: entry };
}

function capabilityIdentity(entry: ProviderCapabilityEntry): string {
  return JSON.stringify([
    entry.identity.providerId,
    entry.identity.kind,
    entry.identity.nativeId,
  ]);
}

function agentIdentity(agent: SelectableProviderAgent): string {
  return JSON.stringify([agent.providerId, agent.nativeId]);
}

/** Module-scoped store for provider capability catalog snapshots. */
export const useProviderCatalogStore = create<ProviderCatalogState>((set, get) => ({
  entries: {},

  load(request, force = false): Promise<ProviderCatalogSnapshot> {
    const key = providerCatalogCacheKey(request);
    const state = get();
    const existing = state.entries[key] ?? EMPTY_PROVIDER_CATALOG_CACHE_ENTRY;
    if (
      !force
      && !existing.needsRefresh
      && existing.snapshot !== null
      && Date.now() - existing.lastFetchedAt < CACHE_TTL_MS
    ) {
      return Promise.resolve(existing.snapshot);
    }
    if (existing.inflight) return existing.inflight;

    const epoch = existing.loadEpoch + 1;
    const promise = (async () => {
      const transport = getTransport();
      const attempt = () => transport.getProviderCatalog(request);
      try {
        try {
          return await attempt();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("disconnected") && !message.includes("not initialized")) {
            throw error;
          }
          const reconnectable = transport as unknown as {
            waitForConnection?: (timeoutMs: number) => Promise<void>;
          };
          await reconnectable.waitForConnection?.(5_000).catch(() => undefined);
          return await attempt();
        }
      } catch (value) {
        throw value instanceof Error ? value : new Error(String(value));
      }
    })();

    set({
      entries: replaceEntry(state.entries, key, {
        ...existing,
        isLoading: true,
        error: null,
        inflight: promise,
        loadEpoch: epoch,
      }),
    });

    void promise.then(
      (snapshot) => {
        const current = get();
        if (current.entries[key]?.loadEpoch !== epoch) return;
        set({
          entries: replaceEntry(current.entries, key, {
            snapshot,
            isLoading: false,
            needsRefresh: false,
            error: null,
            inflight: null,
            loadEpoch: epoch,
            lastFetchedAt: Date.now(),
          }),
        });
      },
      (error: Error) => {
        console.warn("[providerCatalogStore] load failed after retry", error);
        const current = get();
        const currentEntry = current.entries[key];
        if (currentEntry?.loadEpoch !== epoch) return;
        set({
          entries: replaceEntry(current.entries, key, {
            ...currentEntry,
            isLoading: false,
            error,
            inflight: null,
          }),
        });
      },
    );

    return promise;
  },

  invalidate() {
    const entries = Object.fromEntries(
      Object.entries(get().entries).map(([key, entry]) => [
        key,
        {
          ...entry,
          isLoading: false,
          needsRefresh: true,
          error: null,
          inflight: null,
          loadEpoch: entry.loadEpoch + 1,
        } satisfies ProviderCatalogCacheEntry,
      ]),
    );
    set({ entries });
  },

  reconcile(change) {
    const key = providerCatalogCacheKey(change.request);
    const current = get();
    const entry = current.entries[key];
    if (!entry?.snapshot) return;

    const removedEntries = new Set(change.removals.map((identity) => JSON.stringify([
      identity.providerId,
      identity.kind,
      identity.nativeId,
    ])));
    const updatedEntries = new Map(change.updates.map((item) => [capabilityIdentity(item), item]));
    const existingEntryIds = new Set(entry.snapshot.entries.map(capabilityIdentity));
    const entries = entry.snapshot.entries
      .filter((item) => !removedEntries.has(capabilityIdentity(item)))
      .map((item) => updatedEntries.get(capabilityIdentity(item)) ?? item);
    for (const addition of change.additions) {
      if (!existingEntryIds.has(capabilityIdentity(addition))) entries.push(addition);
    }

    const removedAgents = new Set(change.selectableAgents.removals);
    const updatedAgents = new Map(
      change.selectableAgents.updates.map((agent) => [agentIdentity(agent), agent]),
    );
    const existingAgentIds = new Set(entry.snapshot.selectableAgents.map(agentIdentity));
    const selectableAgents = entry.snapshot.selectableAgents
      .filter((agent) => !removedAgents.has(agent.nativeId))
      .map((agent) => updatedAgents.get(agentIdentity(agent)) ?? agent);
    for (const addition of change.selectableAgents.additions) {
      if (!existingAgentIds.has(agentIdentity(addition))) selectableAgents.push(addition);
    }

    set({
      entries: replaceEntry(current.entries, key, {
        ...entry,
        snapshot: {
          ...entry.snapshot,
          entries,
          selectableAgents,
          diagnostics: change.diagnostics ?? entry.snapshot.diagnostics,
          freshness: change.freshness ?? entry.snapshot.freshness,
        },
        isLoading: false,
        needsRefresh: false,
        error: null,
        inflight: null,
        lastFetchedAt: Date.now(),
      }),
    });
  },

  reset() {
    set({ entries: {} });
  },
}));
