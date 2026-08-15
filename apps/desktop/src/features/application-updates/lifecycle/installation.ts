import type { UpdaterClient, ApplicationLifecycle, UpdateTimer } from "./updater.js";
import type { UpdaterSettingsReader } from "../configuration/settings.js";
import type { UpdateStatusState } from "../state/update-status.js";

/** Event shape needed to defer Electron's pending-install quit. */
export interface BeforeQuitEvent {
  preventDefault(): void;
}

/** Hook called before an update installer or pending install quits. */
export type BeforeInstallHook = () => Promise<void>;

/** Dependencies owned by the installation lifecycle. */
export interface InstallationDependencies {
  updater: UpdaterClient;
  application: ApplicationLifecycle;
  timer: UpdateTimer;
  settings: UpdaterSettingsReader;
  status: UpdateStatusState;
}

/** Installation operations owned by one Application Updates instance. */
export interface InstallationLifecycle {
  createBeforeInstallHook(forceReplace: () => Promise<void>): BeforeInstallHook;
  setBeforeInstallHook(hook: BeforeInstallHook): void;
  installUpdate(): Promise<boolean>;
  register(): void;
  cleanup(): void;
}

/** Build the updater installation lifecycle with explicit process dependencies. */
export function createInstallationLifecycle(
  dependencies: InstallationDependencies,
): InstallationLifecycle {
  const { updater, application, timer, settings, status } = dependencies;
  let beforeInstallHook: BeforeInstallHook | null = null;
  let isCompletingStoppedServerQuit = false;
  let installerQuitObserved = false;
  let active = false;
  let generation = 0;

  const createBeforeInstallHook = (
    forceReplace: () => Promise<void>,
  ): BeforeInstallHook => {
    return async () => {
      await forceReplace();
    };
  };

  const setBeforeInstallHook = (hook: BeforeInstallHook): void => {
    beforeInstallHook = hook;
  };

  /** Stop the server and start the installer after Electron observes the quit. */
  const quitAndInstallSafely = async (): Promise<boolean> => {
    const operationGeneration = generation;
    if (beforeInstallHook) {
      try {
        await beforeInstallHook();
      } catch (err) {
        if (!active || operationGeneration !== generation) return false;
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          "[auto-updater] beforeInstallHook failed, cancelling install:",
          message,
        );
        status.publish({
          state: "error",
          message: `Update installation blocked: ${message}`,
        });
        return false;
      }
    }
    if (!active || operationGeneration !== generation) return false;
    installerQuitObserved = false;
    isCompletingStoppedServerQuit = true;
    try {
      const initiation = updater.quitAndInstall();
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
      if (operationGeneration !== generation) return false;
      isCompletingStoppedServerQuit = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[auto-updater] quitAndInstall failed:", message);
      status.publish({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return false;
    }
    await new Promise<void>((resolve) => timer.setImmediate(resolve));
    if (!active || operationGeneration !== generation) return false;
    if (!installerQuitObserved) {
      isCompletingStoppedServerQuit = false;
      const message = "Update installer did not begin application shutdown";
      console.error(`[auto-updater] ${message}`);
      status.publish({
        state: "error",
        message: `Update installation blocked: ${message}`,
      });
      return false;
    }
    isCompletingStoppedServerQuit = false;
    return true;
  };

  /** Handle Electron's pending-install quit path with deferred server teardown. */
  const onBeforeQuitForPendingInstall = (rawEvent: unknown): void => {
    const event = rawEvent as BeforeQuitEvent;
    if (isCompletingStoppedServerQuit) {
      installerQuitObserved = true;
      return;
    }
    if (!active || !application.isPackaged) return;
    const { autoInstallOnQuit } = settings();
    if (!autoInstallOnQuit || status.get().state !== "downloaded") return;

    event.preventDefault();
    installerQuitObserved = false;
    isCompletingStoppedServerQuit = true;
    const operationGeneration = generation;
    void (async () => {
      try {
        if (beforeInstallHook) await beforeInstallHook();
      } catch (err) {
        if (!active || operationGeneration !== generation) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          "[auto-updater] server stop failed before silent install on quit:",
          message,
        );
        isCompletingStoppedServerQuit = false;
        status.publish({
          state: "error",
          message: `Update installation blocked: ${message}`,
        });
        return;
      }
      if (!active || operationGeneration !== generation) return;
      try {
        application.quit();
      } catch (err) {
        if (operationGeneration !== generation) return;
        isCompletingStoppedServerQuit = false;
        const message = err instanceof Error ? err.message : String(err);
        console.error("[auto-updater] deferred app quit failed:", message);
        status.publish({
          state: "error",
          message: `Update installation blocked: ${message}`,
        });
        return;
      }
      if (!active || operationGeneration !== generation) return;
      if (!installerQuitObserved) {
        isCompletingStoppedServerQuit = false;
        const message = "Update installer did not begin application shutdown";
        console.error(`[auto-updater] ${message}`);
        status.publish({
          state: "error",
          message: `Update installation blocked: ${message}`,
        });
        return;
      }
      isCompletingStoppedServerQuit = false;
    })();
  };

  return {
    createBeforeInstallHook,
    setBeforeInstallHook,
    installUpdate: async () => {
      if (!active || !application.isPackaged) return false;
      if (status.get().state !== "downloaded") return false;
      return quitAndInstallSafely();
    },
    register: () => {
      if (active) return;
      active = true;
      application.on("before-quit", onBeforeQuitForPendingInstall);
    },
    cleanup: () => {
      if (!active) {
        beforeInstallHook = null;
        return;
      }
      active = false;
      generation += 1;
      application.removeListener("before-quit", onBeforeQuitForPendingInstall);
      beforeInstallHook = null;
      isCompletingStoppedServerQuit = false;
      installerQuitObserved = false;
    },
  };
}
