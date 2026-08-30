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

  const operationIsCurrent = (operationGeneration: number): boolean =>
    active && operationGeneration === generation;

  const publishBlockedInstall = (logMessage: string, statusMessage = logMessage): void => {
    console.error(`[auto-updater] ${logMessage}`);
    status.publish({ state: "error", message: `Update installation blocked: ${statusMessage}` });
  };

  const runBeforeInstallHook = async (
    operationGeneration: number,
    failureContext: string,
  ): Promise<boolean> => {
    if (!beforeInstallHook) return true;
    try {
      await beforeInstallHook();
      return true;
    } catch (error) {
      if (!operationIsCurrent(operationGeneration)) return false;
      const message = error instanceof Error ? error.message : String(error);
      publishBlockedInstall(`${failureContext}: ${message}`, message);
      return false;
    }
  };

  const awaitQuitAndInstall = async (): Promise<void> => {
    const initiation = updater.quitAndInstall();
    if (initiation === false) throw new Error("Update installer did not begin application shutdown");
    if (isPromiseLike(initiation)) await initiation;
  };

  const finishInstallerQuit = (operationGeneration: number): boolean => {
    if (!operationIsCurrent(operationGeneration)) return false;
    if (installerQuitObserved) {
      isCompletingStoppedServerQuit = false;
      return true;
    }
    isCompletingStoppedServerQuit = false;
    publishBlockedInstall("Update installer did not begin application shutdown");
    return false;
  };

  /** Stop the server and start the installer after Electron observes the quit. */
  const quitAndInstallSafely = async (): Promise<boolean> => {
    const operationGeneration = generation;
    if (!(await runBeforeInstallHook(operationGeneration, "beforeInstallHook failed, cancelling install"))) return false;
    if (!operationIsCurrent(operationGeneration)) return false;
    installerQuitObserved = false;
    isCompletingStoppedServerQuit = true;
    try {
      await awaitQuitAndInstall();
    } catch (error) {
      if (operationGeneration !== generation) return false;
      isCompletingStoppedServerQuit = false;
      const message = error instanceof Error ? error.message : String(error);
      publishBlockedInstall(`quitAndInstall failed: ${message}`, message);
      return false;
    }
    await new Promise<void>((resolve) => timer.setImmediate(resolve));
    return finishInstallerQuit(operationGeneration);
  };

  /** Handle Electron's pending-install quit path with deferred server teardown. */
  const onBeforeQuitForPendingInstall = (rawEvent: unknown): void => {
    const event = rawEvent as BeforeQuitEvent;
    if (isCompletingStoppedServerQuit) {
      installerQuitObserved = true;
      return;
    }
    if (!shouldDeferInstallOnQuit()) return;

    event.preventDefault();
    installerQuitObserved = false;
    isCompletingStoppedServerQuit = true;
    void completePendingInstall(generation);
  };

  const shouldDeferInstallOnQuit = (): boolean =>
    active && application.isPackaged && settings().autoInstallOnQuit && status.get().state === "downloaded";

  const completePendingInstall = async (operationGeneration: number): Promise<void> => {
    if (!(await runBeforeInstallHook(operationGeneration, "server stop failed before silent install on quit"))) return;
    if (!operationIsCurrent(operationGeneration)) return;
    try {
      application.quit();
    } catch (error) {
      if (operationGeneration !== generation) return;
      isCompletingStoppedServerQuit = false;
      const message = error instanceof Error ? error.message : String(error);
      publishBlockedInstall(`deferred app quit failed: ${message}`, message);
      return;
    }
    finishInstallerQuit(operationGeneration);
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function";
}
