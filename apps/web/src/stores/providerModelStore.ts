import { create } from "zustand";
import type { ProviderModelInfo } from "@/transport/types";
import { getTransport } from "@/transport";

/** State shape for the provider model store. */
interface ProviderModelState {
  /** Cached models keyed by provider ID. */
  models: Record<string, ProviderModelInfo[]>;
  /** Loading state keyed by provider ID. */
  loading: Record<string, boolean>;
  /** Error message keyed by provider ID. */
  errors: Record<string, string | null>;

  /** Fetch models from a provider and cache the result. */
  fetchModels: (providerId: string) => Promise<void>;
  /** Clear cached models for a provider (e.g. on disconnect). */
  clearModels: (providerId: string) => void;
}

/** Store for dynamically discovered provider models (e.g. Copilot). */
export const useProviderModelStore = create<ProviderModelState>((set, get) => ({
  models: {},
  loading: {},
  errors: {},

  fetchModels: async (providerId: string) => {
    const state = get();
    if (state.loading[providerId]) return;

    set((s) => ({
      loading: { ...s.loading, [providerId]: true },
      errors: { ...s.errors, [providerId]: null },
    }));

    try {
      const transport = getTransport();
      const models = await transport.listProviderModels(providerId);
      set((s) => ({
        models: { ...s.models, [providerId]: models },
        loading: { ...s.loading, [providerId]: false },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        loading: { ...s.loading, [providerId]: false },
        errors: { ...s.errors, [providerId]: message },
      }));
    }
  },

  clearModels: (providerId: string) => {
    set((s) => ({
      models: { ...s.models, [providerId]: [] },
      errors: { ...s.errors, [providerId]: null },
    }));
  },
}));
