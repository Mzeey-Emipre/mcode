/**
 * Configures electron-updater to check GitHub Releases for new versions.
 * Checks once on launch, then on a configurable interval while running.
 *
 * Surfaces update lifecycle events to the renderer over IPC so the UI can
 * render an in-app banner and an "About" panel showing current state.
 * Also fires a native OS Notification when an update finishes downloading.
 *
 * Update behavior (release line, auto-download, auto-install, check interval)
 * is read from settings.json. Release line changes apply on the next check;
 * check interval still applies after restart (timer started at launch).
 */

import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, Notification } from "electron";
import type { Event } from "electron";
import { applyChannelConfig } from "../features/application-updates/policy/release-line.js";
import { isTransientNetworkError } from "../features/application-updates/policy/network-errors.js";
import {
  intervalToMs,
  loadUpdaterSettings,
  type UpdaterSettings,
} from "../features/application-updates/configuration/settings.js";

/** Shared promise so concurrent callers of applyReleaseLineSwitch await the same switch. */
let inFlightReleaseLineSwitch: Promise<UpdateStatus> | null = null;

/**
 * Switch the running updater to a new release line and trigger an immediate
 * check. When `allowDowngrade` is true, the underlying autoUpdater is
 * temporarily allowed to install an older build (used when the user has
 * confirmed a nightly → stable rollback). The flag is reset after the check
 * resolves so subsequent in-channel checks behave normally.
 *
 * **Precondition:** the caller MUST persist `updates.channel` to settings.json
 * BEFORE invoking this. `checkForUpdatesNow` internally re-reads settings and
 * re-applies the channel, so an unpersisted switch would be silently reverted
 * by the next periodic check.
 *
 * Concurrent calls share the same in-flight switch via `inFlightReleaseLineSwitch`.
 */
export async function applyReleaseLineSwitch(
  releaseLine: "stable" | "nightly",
  options: { allowDowngrade?: boolean } = {},
): Promise<UpdateStatus> {
  if (inFlightReleaseLineSwitch) {
    return inFlightReleaseLineSwitch;
  }
  inFlightReleaseLineSwitch = (async () => {
    applyChannelConfig(autoUpdater, releaseLine);
    const previousAllowDowngrade = autoUpdater.allowDowngrade;
    if (options.allowDowngrade) {
      autoUpdater.allowDowngrade = true;
    }
    try {
      return await checkForUpdatesNow();
    } finally {
      autoUpdater.allowDowngrade = previousAllowDowngrade;
    }
  })();
  try {
    return await inFlightReleaseLineSwitch;
  } finally {
    inFlightReleaseLineSwitch = null;
  }
}

/**
 * Applies the updater channel configuration (`channel` and `allowPrerelease`)
 * from user settings via `applyChannelConfig`, so checks target the stable or
 * nightly feed correctly.
 */
function applyUpdaterChannelFromSettings(settings: UpdaterSettings): void {
  applyChannelConfig(autoUpdater, settings.releaseLine);
}

/** IPC push channel used to broadcast update status to the renderer. */
export const UPDATE_STATUS_CHANNEL = "app:update-status";

/** Discriminated union describing the current state of the update workflow. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; bytesPerSecond?: number }
  | { state: "downloaded"; version: string; releaseNotes?: string }
  | { state: "error"; message: string };

let lastStatus: UpdateStatus = { state: "idle" };
let initialized = false;
let checkIntervalId: NodeJS.Timeout | null = null;
let initialCheckTimeoutId: NodeJS.Timeout | null = null;

/** Hook called before quitAndInstall to allow cleanup (e.g., stopping the server). */
let beforeInstallHook: (() => Promise<void>) | null = null;

/**
 * Skips redundant server-stop work once we have deferred quit to wait for teardown.
 * Matches our own before-quit handler on the synthetic second quit().
 */
let isCompletingStoppedServerQuit = false;
let installerQuitObserved = false;

/** Build the updater teardown hook from the server replacement dependency. */
export function createBeforeInstallHook(
  forceReplace: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    await forceReplace();
  };
}

/**
 * Register a callback that runs before every quitAndInstall.
 * Used by main.ts to inject server shutdown so the installer
 * does not hit locked files from the detached server process.
 */
export function setBeforeInstallHook(hook: () => Promise<void>): void {
  beforeInstallHook = hook;
}

/**
 * Stop the server (if hook registered), then run the installer.
 * All code paths that previously called autoUpdater.quitAndInstall()
 * must use this instead.
 */
async function quitAndInstallSafely(): Promise<boolean> {
  if (beforeInstallHook) {
    try {
      await beforeInstallHook();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[auto-updater] beforeInstallHook failed, cancelling install:",
        message,
      );
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return false;
    }
  }
  installerQuitObserved = false;
  isCompletingStoppedServerQuit = true;
  try {
    const initiation = (
      autoUpdater.quitAndInstall as unknown as () => unknown
    )();
    if (initiation === false) {
      throw new Error("Update installer did not begin application shutdown");
    }
    if (
      initiation &&
      typeof (initiation as PromiseLike<unknown>).then === "function"
    ) {
      await initiation;
    }
  } catch (err) {
    isCompletingStoppedServerQuit = false;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auto-updater] quitAndInstall failed:", message);
    broadcastStatus({
      state: "error",
      message: `Update installation blocked: ${message}`,
    });
    return false;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!installerQuitObserved) {
    isCompletingStoppedServerQuit = false;
    const message = "Update installer did not begin application shutdown";
    console.error(`[auto-updater] ${message}`);
    broadcastStatus({
      state: "error",
      message: `Update installation blocked: ${message}`,
    });
    return false;
  }
  isCompletingStoppedServerQuit = false;
  return true;
}

/** Returns the most recently observed update status (for renderer hydration). */
export function getUpdateStatus(): UpdateStatus {
  return lastStatus;
}

/** Returns true once initAutoUpdater has run (and therefore in a packaged build). */
export function isUpdaterEnabled(): boolean {
  return initialized;
}

/** Broadcast a status change to all open windows. */
function broadcastStatus(status: UpdateStatus): void {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(UPDATE_STATUS_CHANNEL, status);
    }
  }
}

/** Shared promise so concurrent callers wait for the active check to finish. */
let inFlightCheck: Promise<UpdateStatus> | null = null;

/**
 * Manually trigger a check for updates.
 * Safe to call from the renderer; resolves once the check completes.
 * Concurrent callers share the same in-flight check.
 */
export function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (!initialized) {
    return Promise.resolve({
      state: "not-available",
      version: app.getVersion(),
    });
  }
  if (inFlightCheck) {
    return inFlightCheck;
  }
  inFlightCheck = (async () => {
    try {
      // Re-read settings so toggles and release line in the UI take effect
      // without an app restart.
      const settings = loadUpdaterSettings();
      applyUpdaterChannelFromSettings(settings);
      autoUpdater.autoDownload = settings.autoDownload;
      autoUpdater.autoInstallOnAppQuit = settings.autoInstallOnQuit;

      broadcastStatus({ state: "checking" });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcastStatus({ state: "error", message });
    } finally {
      inFlightCheck = null;
    }
    return lastStatus;
  })();
  return inFlightCheck;
}

/** Quit and install a downloaded update. Returns false in dev or if nothing is downloaded. */
export async function installUpdate(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (lastStatus.state !== "downloaded") return false;
  return quitAndInstallSafely();
}

/**
 * Trigger a manual download of a discovered update.
 * Used when autoDownload is off and the user clicks "Download" in the banner.
 */
export async function downloadUpdate(): Promise<void> {
  if (!initialized) return;
  if (lastStatus.state !== "available") return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcastStatus({ state: "error", message });
  }
}

/**
 * When `electron-updater` will install on quit, Electron may exit while the detached server
 * still holds DLLs inside the install prefix. Deferred quit frees those handles first.
 */
function onBeforeQuitForPendingInstall(event: Event): void {
  if (isCompletingStoppedServerQuit) {
    installerQuitObserved = true;
    return;
  }
  if (!app.isPackaged) return;
  if (!initialized) return;
  const { autoInstallOnQuit } = loadUpdaterSettings();
  if (!autoInstallOnQuit || lastStatus.state !== "downloaded") return;

  event.preventDefault();
  installerQuitObserved = false;
  isCompletingStoppedServerQuit = true;
  void (async () => {
    try {
      if (beforeInstallHook) await beforeInstallHook();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[auto-updater] server stop failed before silent install on quit:",
        message,
      );
      isCompletingStoppedServerQuit = false;
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return;
    }
    try {
      app.quit();
    } catch (err) {
      isCompletingStoppedServerQuit = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[auto-updater] deferred app quit failed:", message);
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return;
    }
    if (!installerQuitObserved) {
      isCompletingStoppedServerQuit = false;
      const message = "Update installer did not begin application shutdown";
      console.error(`[auto-updater] ${message}`);
      broadcastStatus({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return;
    }
    isCompletingStoppedServerQuit = false;
  })();
}

/**
 * Initializes auto-update checks. Call once after app "ready" fires.
 * No-op in dev (no packaged app to update).
 */
export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;
  app.on("before-quit", onBeforeQuitForPendingInstall);

  // In dev, force electron-updater to read dev-app-update.yml so we can
  // test the check/download flow without a packaged build.
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.allowDowngrade = false;

  const updaterSettings = loadUpdaterSettings();
  applyUpdaterChannelFromSettings(updaterSettings);
  autoUpdater.autoDownload = updaterSettings.autoDownload;
  autoUpdater.autoInstallOnAppQuit = updaterSettings.autoInstallOnQuit;
  const { checkInterval } = updaterSettings;

  autoUpdater.on("checking-for-update", () => {
    broadcastStatus({ state: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    broadcastStatus({
      state: "available",
      version: info.version,
      releaseNotes: stringifyReleaseNotes(info.releaseNotes),
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    broadcastStatus({
      state: "not-available",
      version: info?.version ?? app.getVersion(),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    broadcastStatus({
      state: "downloading",
      percent: Math.round(progress.percent ?? 0),
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const releaseNotes = stringifyReleaseNotes(info.releaseNotes);
    broadcastStatus({
      state: "downloaded",
      version: info.version,
      releaseNotes,
    });

    // Fire a passive OS notification so the user is aware even when Mcode is
    // backgrounded. Clicking it focuses the window, where the in-app update
    // indicator offers the restart affordance. We deliberately do NOT open a
    // native restart dialog — the restart choice lives in the app chrome.
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: "Mcode update ready",
        body: `Version ${info.version} has been downloaded. Restart to install.`,
      });
      notification.on("click", () => focusMainWindow());
      notification.show();
    }
  });

  autoUpdater.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (isTransientNetworkError(err)) {
      // Connectivity blips (DNS failure, captive portal, offline-at-launch)
      // resolve themselves on the next periodic check. Log for diagnostics but
      // do not flip the renderer to an error toast — see UpdateIndicator.tsx.
      console.warn(
        "[auto-updater] Transient network failure, will retry:",
        message,
      );
      broadcastStatus({ state: "idle" });
      return;
    }
    console.error("[auto-updater] Error checking for updates:", message);
    broadcastStatus({ state: "error", message });
  });

  // Initial check shortly after launch (give the window time to load)
  initialCheckTimeoutId = setTimeout(() => {
    void checkForUpdatesNow();
  }, 10_000);

  // Periodic checks using the configured interval
  const intervalMs = intervalToMs(checkInterval);
  if (isFinite(intervalMs)) {
    checkIntervalId = setInterval(() => {
      void checkForUpdatesNow();
    }, intervalMs);
  }
}

/**
 * Clean up timers and listeners when the app is shutting down.
 * Call from app "quit" or "will-quit" event.
 */
export function cleanupAutoUpdater(): void {
  app.removeListener("before-quit", onBeforeQuitForPendingInstall);
  isCompletingStoppedServerQuit = false;
  installerQuitObserved = false;
  if (initialCheckTimeoutId) {
    clearTimeout(initialCheckTimeoutId);
    initialCheckTimeoutId = null;
  }
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  autoUpdater.removeAllListeners();
}

/** Bring the main window to the foreground (restoring it if minimized). */
function focusMainWindow(): void {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Normalize release notes into a plain string. electron-updater can return
 * either a string, an array of {version, note} entries, or null.
 */
function stringifyReleaseNotes(
  notes:
    string | Array<{ version: string; note: string | null }> | null | undefined,
): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === "string") return notes;
  return notes
    .map((entry) => entry.note?.trim())
    .filter((note): note is string => Boolean(note))
    .join("\n\n");
}
