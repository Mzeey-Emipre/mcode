import { existsSync } from "fs";
import { isAbsolute } from "path";
import type { IpcMain } from "electron";

import type { OpenInRegistry } from "../registry/registry.js";

/** Electron IPC surface required by the Open In handlers. */
export type OpenInIpc = Pick<IpcMain, "handle">;

/** Dependencies used to register Open In handlers. */
export interface OpenInHandlerDependencies {
  /** Electron IPC registry supplied by the desktop composition root. */
  ipcMain: OpenInIpc;
  /** Configured Open In registry that owns application identifiers. */
  registry: OpenInRegistry;
}

/** Register Open In listing and launch handlers. */
export function registerOpenInHandlers({
  ipcMain,
  registry,
}: OpenInHandlerDependencies): void {
  ipcMain.handle("list-open-in-apps", () => registry.list());

  ipcMain.handle(
    "open-in",
    async (_event, appId: string, targetPath: unknown, line?: number) => {
      if (typeof targetPath !== "string" || !isAbsolute(targetPath)) {
        throw new Error("Open-in path must be absolute");
      }
      if (!existsSync(targetPath)) {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      await registry.launch(appId, { path: targetPath, line });
    },
  );
}
