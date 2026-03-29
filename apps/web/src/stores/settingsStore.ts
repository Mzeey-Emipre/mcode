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

const OLD_SETTINGS_KEY = "mcode-settings";
const MIGRATION_FLAG = "mcode-settings-migrated";

/**
 * One-time migration from the old localStorage-based settings to the
 * new RPC-backed settings store.
 *
 * Reads the legacy `mcode-settings` localStorage key, extracts any
 * values that map to the new schema, and sends them to the server
 * via `update()`. After migration the old key is removed and a flag
 * is set so this runs only once.
 */
async function migrateFromLocalStorage(
  update: (partial: DeepPartial<Settings>) => Promise<void>,
): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG)) return;

  const raw = localStorage.getItem(OLD_SETTINGS_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATION_FLAG, "1");
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const patch: DeepPartial<Settings> = {};

    // Old flat format: { theme: "dark", maxConcurrentAgents: 3, ... }
    if (typeof parsed.theme === "string") {
      patch.appearance = { theme: parsed.theme };
    }
    if (typeof parsed.maxConcurrentAgents === "number") {
      patch.agent = { maxConcurrent: parsed.maxConcurrentAgents };
    }
    if (typeof parsed.notificationsEnabled === "boolean") {
      patch.notifications = { enabled: parsed.notificationsEnabled };
    }

    // Nested global worktree settings
    const global = parsed.global;
    if (global && typeof global === "object") {
      const naming: DeepPartial<Settings["worktree"]["naming"]> = {};
      if (typeof global.defaultNamingMode === "string") {
        naming.mode = global.defaultNamingMode;
      }
      if (typeof global.aiConfirmation === "boolean") {
        naming.aiConfirmation = global.aiConfirmation;
      }
      if (Object.keys(naming).length > 0) {
        patch.worktree = { naming };
      }
    }

    if (Object.keys(patch).length > 0) {
      await update(patch);
    }
  } catch {
    // Non-fatal: migration failure should not block the app.
  }

  localStorage.removeItem(OLD_SETTINGS_KEY);
  localStorage.setItem(MIGRATION_FLAG, "1");
}

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
export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  fetch: async () => {
    const wasLoaded = get().loaded;
    try {
      const transport = getTransport();
      const settings = await transport.getSettings();
      set({ settings, loaded: true });
    } catch {
      // Degrade gracefully to defaults; loaded stays false so a retry can happen.
      return;
    }

    // Run one-time localStorage migration after the first successful fetch.
    if (!wasLoaded) {
      await migrateFromLocalStorage(get().update);
    }
  },

  update: async (partial) => {
    try {
      const transport = getTransport();
      const settings = await transport.updateSettings(partial as PartialSettings);
      set({ settings });
    } catch {
      // Best-effort: server-side state is unchanged, local state stays as-is.
    }
  },

  _applyPush: (settings) => set({ settings }),
}));
