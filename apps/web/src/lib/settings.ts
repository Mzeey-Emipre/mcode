/**
 * Lightweight localStorage-based settings for user preferences that
 * don't warrant a round-trip to the main process (e.g. UI defaults).
 *
 * Supports workspace-scoped overrides that fall back to global defaults.
 */

/** Branch naming strategy for new worktrees. */
export type NamingMode = "auto" | "custom" | "ai";

interface WorktreeSettings {
  defaultNamingMode: NamingMode;
  aiConfirmation: boolean;
}

interface StoredSettings {
  global: WorktreeSettings;
  workspaces: Record<string, Partial<WorktreeSettings>>;
}

const SETTINGS_KEY = "mcode-settings";

const GLOBAL_DEFAULTS: WorktreeSettings = {
  defaultNamingMode: "auto",
  aiConfirmation: true,
};

/** Flat keys used by callers, mapped to WorktreeSettings fields. */
type SettingKey = "worktree.defaultNamingMode" | "worktree.aiConfirmation";

type SettingValue<K extends SettingKey> =
  K extends "worktree.defaultNamingMode" ? NamingMode :
  K extends "worktree.aiConfirmation" ? boolean :
  never;

const KEY_MAP: Record<SettingKey, keyof WorktreeSettings> = {
  "worktree.defaultNamingMode": "defaultNamingMode",
  "worktree.aiConfirmation": "aiConfirmation",
};

function readStore(): StoredSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { global: { ...GLOBAL_DEFAULTS }, workspaces: {} };
    const parsed = JSON.parse(raw);

    // Migrate old flat format: { "worktree.defaultNamingMode": "auto", ... }
    if (parsed && !parsed.global && !parsed.workspaces) {
      const migrated: StoredSettings = { global: { ...GLOBAL_DEFAULTS }, workspaces: {} };
      if (typeof parsed["worktree.defaultNamingMode"] === "string") {
        migrated.global.defaultNamingMode = parsed["worktree.defaultNamingMode"] as NamingMode;
      }
      if (typeof parsed["worktree.aiConfirmation"] === "boolean") {
        migrated.global.aiConfirmation = parsed["worktree.aiConfirmation"];
      }
      return migrated;
    }

    return {
      global: { ...GLOBAL_DEFAULTS, ...parsed.global },
      workspaces: parsed.workspaces ?? {},
    };
  } catch {
    return { global: { ...GLOBAL_DEFAULTS }, workspaces: {} };
  }
}

function writeStore(store: StoredSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(store));
  } catch {
    // Non-fatal
  }
}

/**
 * Read a setting, optionally scoped to a workspace.
 * Falls back: workspace -> global -> built-in default.
 */
export function getSetting<K extends SettingKey>(key: K, workspaceId?: string): SettingValue<K> {
  const store = readStore();
  const field = KEY_MAP[key];

  if (workspaceId) {
    const ws = store.workspaces[workspaceId];
    if (ws && field in ws) {
      const val = ws[field];
      if (typeof val === typeof GLOBAL_DEFAULTS[field]) {
        return val as unknown as SettingValue<K>;
      }
    }
  }

  return store.global[field] as unknown as SettingValue<K>;
}

/**
 * Persist a setting. Pass workspaceId for a workspace-scoped override,
 * omit for global. Silently no-ops on storage errors.
 */
export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>, workspaceId?: string): void {
  const store = readStore();
  const field = KEY_MAP[key];

  if (workspaceId) {
    const ws: Record<string, unknown> = { ...store.workspaces[workspaceId] };
    ws[field] = value;
    store.workspaces[workspaceId] = ws as Partial<WorktreeSettings>;
  } else {
    const updated = { ...store.global, [field]: value };
    store.global = updated;
  }

  writeStore(store);
}
