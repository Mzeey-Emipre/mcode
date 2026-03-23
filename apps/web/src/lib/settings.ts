export type NamingMode = "auto" | "custom";

const SETTINGS_KEY = "mcode-settings";

interface Settings {
  "worktree.defaultNamingMode": NamingMode;
  "worktree.aiConfirmation": boolean;
}

const DEFAULTS: Settings = {
  "worktree.defaultNamingMode": "auto",
  "worktree.aiConfirmation": true,
};

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored) return DEFAULTS[key];
    const parsed = JSON.parse(stored) as Partial<Settings>;
    return parsed[key] ?? DEFAULTS[key];
  } catch {
    return DEFAULTS[key];
  }
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    const current: Partial<Settings> = stored ? JSON.parse(stored) : {};
    current[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
  } catch {
    // Non-fatal
  }
}
