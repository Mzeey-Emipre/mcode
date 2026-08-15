import { Notification } from "electron";
import {
  applyChannelConfig,
  type ReleaseLine,
} from "../policy/release-line.js";
import { isTransientNetworkError } from "../policy/network-errors.js";
import {
  type UpdaterSettings,
  type UpdaterSettingsReader,
  intervalToMs,
} from "../configuration/settings.js";
import {
  type ApplicationWindowProvider,
  type UpdateStatus,
  type UpdateStatusState,
} from "../state/update-status.js";
import type { InstallationLifecycle } from "./installation.js";

/** Minimal electron-updater contract owned by one Application Updates instance. */
export interface UpdaterClient {
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  forceDevUpdateConfig: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): unknown;
}

/** Application lifecycle operations needed by update checks and installation. */
export interface ApplicationLifecycle {
  isPackaged: boolean;
  getVersion(): string;
  on(event: "before-quit", listener: (event: unknown) => void): void;
  removeListener(event: "before-quit", listener: (event: unknown) => void): void;
  quit(): void;
}

/** Timer operations injected so feature resources can be fully owned and tested. */
export interface UpdateTimer {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
  setImmediate(callback: () => void): unknown;
}

/** Dependencies for one updater lifecycle instance. */
export interface UpdaterDependencies {
  updater: UpdaterClient;
  application: ApplicationLifecycle;
  windows: ApplicationWindowProvider;
  timer: UpdateTimer;
  settings: UpdaterSettingsReader;
  status: UpdateStatusState;
  installation: InstallationLifecycle;
}

/** Updater operations exposed by the Application Updates feature seam. */
export interface UpdaterLifecycle {
  isEnabled(): boolean;
  initialize(): void;
  cleanup(): void;
  checkForUpdatesNow(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<void>;
  applyReleaseLineSwitch(
    releaseLine: ReleaseLine,
    options?: { allowDowngrade?: boolean },
  ): Promise<UpdateStatus>;
}

/** Normalize electron-updater release notes into a renderer-safe string. */
function stringifyReleaseNotes(
  notes:
    | string
    | Array<{ version: string; note: string | null }>
    | null
    | undefined,
): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === "string") return notes;
  return notes
    .map((entry) => entry.note?.trim())
    .filter((note): note is string => Boolean(note))
    .join("\n\n");
}

/** Build the update lifecycle from explicit process and feature dependencies. */
export function createUpdaterLifecycle(
  dependencies: UpdaterDependencies,
): UpdaterLifecycle {
  const {
    updater,
    application,
    windows,
    timer,
    settings,
    status,
    installation,
  } = dependencies;
  let initialized = false;
  let checkIntervalId: unknown = null;
  let initialCheckTimeoutId: unknown = null;
  let inFlightCheck: Promise<UpdateStatus> | null = null;
  let inFlightReleaseLineSwitch: Promise<UpdateStatus> | null = null;
  let generation = 0;

  const applyUpdaterChannelFromSettings = (
    updaterSettings: UpdaterSettings,
  ): void => {
    applyChannelConfig(updater, updaterSettings.releaseLine);
  };

  const focusMainWindow = (): void => {
    const win = windows.getFocusedWindow() ?? windows.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const checkForUpdatesNow = (): Promise<UpdateStatus> => {
    if (!initialized) {
      return Promise.resolve({
        state: "not-available",
        version: application.getVersion(),
      });
    }
    if (inFlightCheck) return inFlightCheck;
    const operationGeneration = generation;
    inFlightCheck = (async () => {
      try {
        const updaterSettings = settings();
        applyUpdaterChannelFromSettings(updaterSettings);
        updater.autoDownload = updaterSettings.autoDownload;
        updater.autoInstallOnAppQuit = updaterSettings.autoInstallOnQuit;

        status.publish({ state: "checking" });
        await updater.checkForUpdates();
      } catch (err) {
        if (operationGeneration !== generation || !initialized) {
          return status.get();
        }
        const message = err instanceof Error ? err.message : String(err);
        status.publish({ state: "error", message });
      } finally {
        if (operationGeneration === generation) inFlightCheck = null;
      }
      return status.get();
    })();
    return inFlightCheck;
  };

  const applyReleaseLineSwitch = async (
    releaseLine: ReleaseLine,
    options: { allowDowngrade?: boolean } = {},
  ): Promise<UpdateStatus> => {
    if (inFlightReleaseLineSwitch) return inFlightReleaseLineSwitch;
    const operationGeneration = generation;
    inFlightReleaseLineSwitch = (async () => {
      applyChannelConfig(updater, releaseLine);
      const previousAllowDowngrade = updater.allowDowngrade;
      if (options.allowDowngrade) updater.allowDowngrade = true;
      try {
        return await checkForUpdatesNow();
      } finally {
        if (operationGeneration === generation) {
          updater.allowDowngrade = previousAllowDowngrade;
        }
      }
    })();
    try {
      return await inFlightReleaseLineSwitch;
    } finally {
      if (operationGeneration === generation) inFlightReleaseLineSwitch = null;
    }
  };

  const downloadUpdate = async (): Promise<void> => {
    if (!initialized || status.get().state !== "available") return;
    const operationGeneration = generation;
    try {
      await updater.downloadUpdate();
    } catch (err) {
      if (operationGeneration !== generation || !initialized) return;
      const message = err instanceof Error ? err.message : String(err);
      status.publish({ state: "error", message });
    }
  };

  const initialize = (): void => {
    if (initialized) return;
    initialized = true;
    status.initialize();
    installation.register();

    if (!application.isPackaged) updater.forceDevUpdateConfig = true;
    updater.allowDowngrade = false;

    const updaterSettings = settings();
    applyUpdaterChannelFromSettings(updaterSettings);
    updater.autoDownload = updaterSettings.autoDownload;
    updater.autoInstallOnAppQuit = updaterSettings.autoInstallOnQuit;

    updater.on("checking-for-update", () => {
      status.publish({ state: "checking" });
    });
    updater.on("update-available", (info) => {
      const update = info as {
        version: string;
        releaseNotes?:
          | string
          | Array<{ version: string; note: string | null }>
          | null;
      };
      status.publish({
        state: "available",
        version: update.version,
        releaseNotes: stringifyReleaseNotes(update.releaseNotes),
      });
    });
    updater.on("update-not-available", (info) => {
      const update = info as { version?: string } | undefined;
      status.publish({
        state: "not-available",
        version: update?.version ?? application.getVersion(),
      });
    });
    updater.on("download-progress", (progress) => {
      const download = progress as {
        percent?: number;
        bytesPerSecond?: number;
      };
      status.publish({
        state: "downloading",
        percent: Math.round(download.percent ?? 0),
        bytesPerSecond: download.bytesPerSecond,
      });
    });
    updater.on("update-downloaded", (info) => {
      const update = info as {
        version: string;
        releaseNotes?:
          | string
          | Array<{ version: string; note: string | null }>
          | null;
      };
      const releaseNotes = stringifyReleaseNotes(update.releaseNotes);
      status.publish({
        state: "downloaded",
        version: update.version,
        releaseNotes,
      });

      if (Notification.isSupported()) {
        const notification = new Notification({
          title: "Mcode update ready",
          body: `Version ${update.version} has been downloaded. Restart to install.`,
        });
        notification.on("click", () => focusMainWindow());
        notification.show();
      }
    });
    updater.on("error", (error) => {
      const err = error as { message?: string; code?: string; statusCode?: number };
      const message = err instanceof Error ? err.message : String(error);
      if (isTransientNetworkError(error)) {
        console.warn(
          "[auto-updater] Transient network failure, will retry:",
          message,
        );
        status.publish({ state: "idle" });
        return;
      }
      console.error("[auto-updater] Error checking for updates:", message);
      status.publish({ state: "error", message });
    });

    initialCheckTimeoutId = timer.setTimeout(() => {
      void checkForUpdatesNow();
    }, 10_000);

    const intervalMs = intervalToMs(updaterSettings.checkInterval);
    if (isFinite(intervalMs)) {
      checkIntervalId = timer.setInterval(() => {
        void checkForUpdatesNow();
      }, intervalMs);
    }
  };

  const cleanup = (): void => {
    if (!initialized) {
      installation.cleanup();
      status.cleanup();
      return;
    }
    initialized = false;
    generation += 1;
    inFlightCheck = null;
    inFlightReleaseLineSwitch = null;
    if (initialCheckTimeoutId !== null) {
      timer.clearTimeout(initialCheckTimeoutId);
      initialCheckTimeoutId = null;
    }
    if (checkIntervalId !== null) {
      timer.clearInterval(checkIntervalId);
      checkIntervalId = null;
    }
    updater.removeAllListeners();
    installation.cleanup();
    status.cleanup();
  };

  return {
    isEnabled: () => initialized,
    initialize,
    cleanup,
    checkForUpdatesNow,
    downloadUpdate,
    applyReleaseLineSwitch,
  };
}
