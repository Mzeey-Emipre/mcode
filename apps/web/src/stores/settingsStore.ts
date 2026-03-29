import { create } from "zustand";
import { DEFAULT_SETTINGS, type Settings, type PartialSettings } from "@mcode/contracts";
import { getTransport } from "@/transport";

/**
 * Recursive deep-partial utility type.
 *
 * Zod's `deepPartial()` does not recurse through `.default()` wrappers,
 * so the generated `PartialSettings` type may still require some nested
 * keys. This utility ensures every level is optional for consumer ergonomics.
 */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Zustand state shape for the settings store. */
interface SettingsState {
  /** Current settings from server. */
  settings: Settings;
  /** Whether initial fetch has completed. */
  loaded: boolean;
  /** Fetch full settings from server. */
  fetch: () => Promise<void>;
  /** Update settings via server (deep merge). */
  update: (partial: DeepPartial<Settings>) => Promise<void>;
  /** Apply a server push update. */
  _applyPush: (settings: Settings) => void;
}

/**
 * RPC-backed settings store.
 *
 * The server is the source of truth. Local state is hydrated via `fetch()`
 * and kept in sync through `settings.changed` push events.
 */
export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  fetch: async () => {
    const transport = getTransport();
    const settings = await transport.getSettings();
    set({ settings, loaded: true });
  },

  update: async (partial) => {
    const transport = getTransport();
    const settings = await transport.updateSettings(partial as PartialSettings);
    set({ settings });
  },

  _applyPush: (settings) => set({ settings }),
}));
