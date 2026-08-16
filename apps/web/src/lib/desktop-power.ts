/**
 * Desktop power-state reporting.
 *
 * Derives a single "server busy" boolean from renderer state (running agent
 * turns + open terminal sessions) and forwards changes to the Electron main
 * process via `desktopBridge.setServerBusy`. While busy, the main process
 * holds a power save blocker so the OS does not suspend the machine mid-turn.
 *
 * No-op in browser builds where `desktopBridge` is absent.
 */

import { useThreadStore } from "@/stores/threadStore";
import { useTerminalStore } from "@/features/terminal";

/** Trailing-edge debounce so rapid turn/terminal churn does not flap the blocker. */
const BUSY_DEBOUNCE_MS = 1_000;

/**
 * Derive the busy flag from store snapshots: busy while any agent turn is
 * running or any terminal session is open. Exported for unit testing.
 */
export function computeServerBusy(
  runningThreadIds: ReadonlySet<string>,
  terminals: Record<string, readonly unknown[]>,
): boolean {
  if (runningThreadIds.size > 0) return true;
  for (const instances of Object.values(terminals)) {
    if (instances.length > 0) return true;
  }
  return false;
}

let initialized = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent: boolean | null = null;

/** Read the current busy state from the live stores. */
function currentBusy(): boolean {
  return computeServerBusy(
    useThreadStore.getState().runningThreadIds,
    useTerminalStore.getState().terminals,
  );
}

/** Push the busy flag to the main process if it changed since the last send. */
function sendIfChanged(): void {
  const busy = currentBusy();
  if (busy === lastSent) return;
  lastSent = busy;
  void window.desktopBridge?.setServerBusy?.(busy)?.catch(() => {
    // Best-effort: a failed IPC call only means the blocker state lags.
  });
}

/**
 * Start reporting server-busy state to the desktop main process.
 * Call once at app bootstrap; subsequent calls are no-ops. Does nothing in
 * browser builds (no `desktopBridge`).
 */
export function initDesktopPowerReporting(): void {
  if (initialized) return;
  if (typeof window === "undefined" || !window.desktopBridge?.setServerBusy) return;
  initialized = true;

  const scheduleUpdate = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      sendIfChanged();
    }, BUSY_DEBOUNCE_MS);
  };

  useThreadStore.subscribe(scheduleUpdate);
  useTerminalStore.subscribe(scheduleUpdate);

  // Report the initial state immediately (no debounce) so a reload during a
  // running turn re-acquires the blocker without a one-second gap.
  sendIfChanged();
}
