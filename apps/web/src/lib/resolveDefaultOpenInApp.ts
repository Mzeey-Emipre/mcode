import type { OpenInApp } from "@/transport/types";

/**
 * Stable id of the File Explorer adapter, mirrored from the desktop registry
 * (`apps/desktop/src/main/open-in/file-explorer-adapter.ts`). Used as the
 * ultimate fallback when no editor or file manager is installed.
 */
export const FILE_EXPLORER_ID = "explorer";

/** Whether an app id is present in the list and currently installed/detected. */
function isUsable(appId: string | null | undefined, installedApps: readonly OpenInApp[]): boolean {
  return appId != null && installedApps.some((a) => a.id === appId && a.detected);
}

/**
 * Resolves the effective default open-in app id using the three tiers from
 * ADR-0005, in order:
 *
 * 1. **Thread override** - the app last picked from this thread's menu.
 * 2. **Global default** - the `externalApps.defaultEditor` user setting.
 * 3. **Auto-resolve** - the highest-priority installed editor (registration
 *    order, e.g. VS Code -> Cursor -> Zed), falling back to the first installed
 *    file manager, then to {@link FILE_EXPLORER_ID}.
 *
 * Tiers 1 and 2 are honored only when the referenced app is actually installed;
 * an override pointing at an uninstalled app falls through to the next tier.
 * The function is pure: it never reads global state, so the split button and the
 * `mod+o` shortcut resolve to identical results.
 *
 * @param threadOverride - The thread's persisted app id, or null when unset.
 * @param globalDefault - The global default app id, or null/empty when unset.
 * @param installedApps - All registry apps with their detection status.
 * @returns The id of the app to open.
 */
export function resolveDefaultOpenInApp(
  threadOverride: string | null | undefined,
  globalDefault: string | null | undefined,
  installedApps: readonly OpenInApp[],
): string {
  if (isUsable(threadOverride, installedApps)) return threadOverride!;
  if (isUsable(globalDefault, installedApps)) return globalDefault!;

  const editor = installedApps.find((a) => a.kind === "editor" && a.detected);
  if (editor) return editor.id;

  const fileManager = installedApps.find((a) => a.kind === "fileManager" && a.detected);
  if (fileManager) return fileManager.id;

  return FILE_EXPLORER_ID;
}
