import type { UpdaterSettingsReader } from "./configuration/settings.js";
import {
  createInstallationLifecycle,
} from "./lifecycle/installation.js";
import {
  createUpdaterLifecycle,
  type ApplicationLifecycle,
  type UpdateTimer,
  type UpdaterClient,
} from "./lifecycle/updater.js";
import {
  createUpdateStatusState,
  type ApplicationWindowProvider,
  type UpdateStatus,
} from "./state/update-status.js";

/** Dependencies supplied by desktop composition for Application Updates. */
export interface ApplicationUpdatesDependencies {
  /** electron-updater instance owned by the desktop process. */
  updater: UpdaterClient;
  /** Electron application lifecycle owned by the desktop process. */
  application: ApplicationLifecycle;
  /** Provider for live windows used by status delivery and focus. */
  windows: ApplicationWindowProvider;
  /** Timer implementation whose handles belong to this feature instance. */
  timer: UpdateTimer;
  /** Settings reader used by initialization and every manual check. */
  settings: UpdaterSettingsReader;
  /** Stop and replace the Server Runtime before installation. */
  forceReplace: () => Promise<void>;
}

/** Public feature API for update initialization, controls, status, and cleanup. */
export interface ApplicationUpdates {
  initialize(): void;
  cleanup(): void;
  getUpdateStatus(): UpdateStatus;
  checkForUpdatesNow(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<boolean>;
  applyReleaseLineSwitch(
    releaseLine: "stable" | "nightly",
    options?: { allowDowngrade?: boolean },
  ): Promise<UpdateStatus>;
}

/** Create an isolated Application Updates feature instance for one process lifetime. */
export function createApplicationUpdates(
  dependencies: ApplicationUpdatesDependencies,
): ApplicationUpdates {
  const status = createUpdateStatusState(dependencies.windows);
  const installation = createInstallationLifecycle({
    updater: dependencies.updater,
    application: dependencies.application,
    timer: dependencies.timer,
    settings: dependencies.settings,
    status,
  });
  const updater = createUpdaterLifecycle({
    updater: dependencies.updater,
    application: dependencies.application,
    windows: dependencies.windows,
    timer: dependencies.timer,
    settings: dependencies.settings,
    status,
    installation,
  });
  let initialized = false;

  return {
    initialize: () => {
      if (initialized) return;
      initialized = true;
      installation.setBeforeInstallHook(
        installation.createBeforeInstallHook(dependencies.forceReplace),
      );
      updater.initialize();
    },
    cleanup: () => {
      if (!initialized) return;
      initialized = false;
      updater.cleanup();
    },
    getUpdateStatus: () => status.get(),
    checkForUpdatesNow: () => updater.checkForUpdatesNow(),
    downloadUpdate: () => updater.downloadUpdate(),
    installUpdate: () => installation.installUpdate(),
    applyReleaseLineSwitch: (releaseLine, options) =>
      updater.applyReleaseLineSwitch(releaseLine, options),
  };
}

let activeApplicationUpdates: ApplicationUpdates | null = null;

/** Initialize the process-level feature after desktop dependencies exist. */
export function initializeApplicationUpdates(
  dependencies: ApplicationUpdatesDependencies,
): ApplicationUpdates {
  activeApplicationUpdates?.cleanup();
  const feature = createApplicationUpdates(dependencies);
  feature.initialize();
  activeApplicationUpdates = feature;
  return feature;
}

/** Clean up the process-level feature and release all owned resources. */
export function cleanupApplicationUpdates(): void {
  activeApplicationUpdates?.cleanup();
  activeApplicationUpdates = null;
}

/** Public update status channel and state type. */
export {
  UPDATE_STATUS_CHANNEL,
  type UpdateStatus,
} from "./state/update-status.js";

/** Public configuration and policy types used by composition and tests. */
export type { UpdaterSettingsReader } from "./configuration/settings.js";
export type {
  ApplicationLifecycle,
  UpdateTimer,
  UpdaterClient,
} from "./lifecycle/updater.js";
