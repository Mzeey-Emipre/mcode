import { create } from "zustand";
import { MODEL_PROVIDERS, type ModelDefinition } from "@/lib/model-registry";
import { getTransport } from "@/transport";

/** How long cached models remain valid before a background refresh. */
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** State and actions for the provider models Zustand store. */
interface ProviderModelsState {
  /** Dynamically fetched models keyed by provider ID. */
  models: Record<string, ModelDefinition[]>;
  /** Timestamp of last successful fetch per provider. */
  lastFetched: Record<string, number>;
  /** Providers currently being fetched. */
  loading: Record<string, boolean>;
  /**
   * Fetch models for a single provider.
   * No-ops if a fetch is in-flight or the cache is still fresh.
   */
  fetchModels: (providerId: string) => Promise<void>;
  /**
   * Eagerly fetch models for all providers that support dynamic listing.
   * Called on WS connection and reconnection.
   */
  initialize: () => void;
}

/** Zustand store for dynamically fetched provider models with TTL caching. */
export const useProviderModelsStore = create<ProviderModelsState>((set, get) => ({
  models: {},
  lastFetched: {},
  loading: {},

  fetchModels: async (providerId: string) => {
    // Atomic check-and-set: read loading + TTL inside the updater to avoid a
    // TOCTOU race where two concurrent callers both pass the guard.
    let shouldFetch = false;
    set((s) => {
      if (s.loading[providerId]) return s;
      const lastFetch = s.lastFetched[providerId] ?? 0;
      if (Date.now() - lastFetch < MODEL_CACHE_TTL_MS) return s;
      shouldFetch = true;
      return { loading: { ...s.loading, [providerId]: true } };
    });
    if (!shouldFetch) return;
    try {
      const info = await getTransport().listProviderModels(providerId);
      const mapped: ModelDefinition[] = info.map((m) => ({
        id: m.id,
        label: m.name,
        providerId,
        group: m.group,
        multiplier: m.multiplier,
      }));
      set((s) => ({
        models: { ...s.models, [providerId]: mapped },
        lastFetched: { ...s.lastFetched, [providerId]: Date.now() },
        loading: { ...s.loading, [providerId]: false },
      }));
    } catch (err) {
      console.warn(`[providerModelsStore] Failed to fetch models for "${providerId}":`, err);
      set((s) => ({ loading: { ...s.loading, [providerId]: false } }));
    }
  },

  initialize: () => {
    const providers = MODEL_PROVIDERS.filter(
      (p) => p.supportsModelListing && !p.comingSoon,
    );
    for (const p of providers) {
      void get().fetchModels(p.id);
    }
  },
}));
