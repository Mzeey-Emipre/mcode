/**
 * Public surface of the Codex browser-use bridge subsystem.
 *
 * Boot a single {@link BrowserUsePipeServer} during app startup, bound to the
 * resolved pipe path. The server lifetime is the app's lifetime; tear down
 * via {@link disposeBrowserUseBridge} on `before-quit`.
 */

import { app } from "electron";
import { logger } from "@mcode/shared";
import {
  createPreviewSessionBackedHostBridge,
  type BrowserHostBridge,
} from "./host-bridge.js";
import { BrowserUsePipeServer, resolveConfiguredPipePath } from "./pipe-server.js";

export { BrowserUsePipeServer, resolveConfiguredPipePath, resolveDefaultPipePath } from "./pipe-server.js";
export type { BrowserHostBridge } from "./host-bridge.js";

export { LEGACY_BROWSER_USE_PIPE_ENV, shouldStartLegacyBrowserUseBridge } from "./rollout.js";

let server: BrowserUsePipeServer | null = null;
let hostBridge: BrowserHostBridge | null = null;

/**
 * Start the pipe server. Safe to call multiple times - only the first call
 * binds. Returns the resolved pipe path so the main process can broadcast it
 * (e.g. into `MCODE_BROWSER_USE_PIPE_PATH` for spawned children).
 */
export async function startBrowserUseBridge(): Promise<string | null> {
  if (server) return server.path;
  try {
    hostBridge = createPreviewSessionBackedHostBridge();
    server = new BrowserUsePipeServer({
      appVersion: app.getVersion(),
      host: hostBridge,
      pipePath: resolveConfiguredPipePath(),
    });
    await server.start();
    return server.path;
  } catch (err) {
    logger.error("browser-use: failed to start pipe server", { err: String(err) });
    server = null;
    hostBridge = null;
    return null;
  }
}

/** Tear down the pipe server during app shutdown. */
export async function disposeBrowserUseBridge(): Promise<void> {
  if (!server) return;
  try {
    await server.dispose();
  } catch (err) {
    logger.warn("browser-use: dispose threw", { err: String(err) });
  }
  server = null;
  hostBridge = null;
}
