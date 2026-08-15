import type { UpdateStatus } from "../state/update-status.js";

/** Minimal IPC registry needed to own update handler registration. */
export interface ApplicationUpdateIpc {
  /** Register one invoke handler for an application update channel. */
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void;
  /** Remove the invoke handler previously registered for a channel. */
  removeHandler(channel: string): void;
}

/** Feature operations consumed by update IPC handlers. */
export interface ApplicationUpdatesIpcApi {
  getVersion(): string;
  getUpdateStatus(): UpdateStatus;
  checkForUpdatesNow(): Promise<UpdateStatus>;
  installUpdate(): Promise<boolean>;
  downloadUpdate(): Promise<void>;
  applyReleaseLineSwitch(
    releaseLine: "stable" | "nightly",
    options: { allowDowngrade: boolean },
  ): Promise<UpdateStatus>;
}

const APPLICATION_UPDATE_CHANNELS = [
  "app:get-version",
  "app:get-update-status",
  "app:check-for-updates",
  "app:install-update",
  "app:download-update",
  "app:apply-release-line",
] as const;

/** Register update IPC and return cleanup that removes every owned handler. */
export function registerApplicationUpdateHandlers(
  ipc: ApplicationUpdateIpc,
  api: ApplicationUpdatesIpcApi,
): () => void {
  ipc.handle("app:get-version", () => api.getVersion());
  ipc.handle("app:get-update-status", () => api.getUpdateStatus());
  ipc.handle("app:check-for-updates", () => api.checkForUpdatesNow());
  ipc.handle("app:install-update", () => api.installUpdate());
  ipc.handle("app:download-update", () => api.downloadUpdate());
  ipc.handle("app:apply-release-line", async (_event, payload) => {
    const releaseLine =
      (payload as { releaseLine?: unknown } | null | undefined)?.releaseLine;
    if (releaseLine !== "stable" && releaseLine !== "nightly") {
      throw new Error(`Invalid releaseLine: ${String(releaseLine)}`);
    }
    return api.applyReleaseLineSwitch(releaseLine, {
      allowDowngrade:
        (payload as { allowDowngrade?: unknown } | undefined)
          ?.allowDowngrade === true,
    });
  });

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    for (const channel of APPLICATION_UPDATE_CHANNELS) {
      ipc.removeHandler(channel);
    }
  };
}
