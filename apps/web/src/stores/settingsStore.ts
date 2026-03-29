import { create } from "zustand";
import { DEFAULT_SETTINGS, SettingsSchema, type Settings, type PartialSettings } from "@mcode/contracts";
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

    // Zustand persist wraps state under a "state" key: { state: {...}, version: 0 }
    // lib/settings.ts stored flat: { global: {...}, workspaces: {...} }
    // Handle both formats defensively.
    const zustandState =
      parsed.state && typeof parsed.state === "object" ? parsed.state : parsed;

    if (typeof zustandState.theme === "string") {
      patch.appearance = { theme: zustandState.theme };
    }
    if (typeof zustandState.maxConcurrentAgents === "number") {
      patch.agent = { maxConcurrent: zustandState.maxConcurrentAgents };
    }
    if (typeof zustandState.notificationsEnabled === "boolean") {
      patch.notifications = { enabled: zustandState.notificationsEnabled };
    }

    // Nested global worktree settings come from the lib/settings.ts format
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

    // Only clean up after a successful migration so we can retry on failure.
    localStorage.removeItem(OLD_SETTINGS_KEY);
    localStorage.setItem(MIGRATION_FLAG, "1");
  } catch {
    // Non-fatal: migration failure should not block the app.
    // Old data is preserved for a retry on next startup.
  }
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
  /**
   * Apply a server push update. Validates the payload with Zod before
   * applying; invalid data is silently ignored to guard against wire corruption.
   */
  _applyPush: (settings: unknown) => void;
}

/**
 * Monotonically-increasing counter incremented on each successful `update()`.
 * `fetch()` captures the value before the async RPC and discards the result if
 * a newer update landed in the meantime, preventing stale fetch responses from
 * overwriting fresher data.
 */
let updateGeneration = 0;

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
    const genAtStart = updateGeneration;
    try {
      const transport = getTransport();
      const settings = await transport.getSettings();
      // Discard if an update resolved while this fetch was in flight.
      if (updateGeneration === genAtStart) {
        set({ settings, loaded: true });
      }
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
      updateGeneration++;
      set({ settings });
    } catch {
      // Best-effort: server-side state is unchanged, local state stays as-is.
    }
  },

  _applyPush: (raw) => {
    const result = SettingsSchema.safeParse(raw);
    if (result.success) {
      set({ settings: result.data, loaded: true });
    }
  },
}));
