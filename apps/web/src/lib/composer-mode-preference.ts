/** Composer modes that can be reused when opening a new thread. */
export type RememberedComposerMode = "direct" | "worktree" | "existing-worktree";

const STORAGE_KEY = "mcode-composer-mode";

function isRememberedComposerMode(value: string | null): value is RememberedComposerMode {
  return value === "direct" || value === "worktree" || value === "existing-worktree";
}

/** Reads the last composer mode selected by the user. */
export function readRememberedComposerMode(): RememberedComposerMode {
  if (typeof window === "undefined") return "direct";

  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isRememberedComposerMode(value) ? value : "direct";
  } catch {
    return "direct";
  }
}

/** Remembers the composer mode selected by the user for future new threads. */
export function rememberComposerMode(mode: RememberedComposerMode): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Browser storage can be unavailable; the in-memory composer state still works.
  }
}
