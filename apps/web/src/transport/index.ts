import type { McodeTransport } from "./types";
import { createWsTransport } from "./ws-transport";

export type { McodeTransport, Workspace, Thread, Message, ToolCall, GitBranch, WorktreeInfo, PermissionMode, InteractionMode, AttachmentMeta, StoredAttachment, SkillInfo, PrInfo, PrDetail } from "./types";
export { PERMISSION_MODES, INTERACTION_MODES } from "./types";
export { pushEmitter } from "./ws-transport";

/** Default server URL when running standalone (no Electron shell). */
const DEFAULT_SERVER_URL = "ws://localhost:3100";

let transport: (McodeTransport & { close(): void }) | null = null;

/**
 * Resolve the WebSocket server URL.
 *
 * In Electron, `window.desktopBridge.getServerUrl()` returns the URL of the
 * server spawned by the main process. In standalone / dev mode we fall back
 * to an environment variable or the default localhost URL.
 */
async function resolveServerUrl(): Promise<string> {
  if (window.desktopBridge?.getServerUrl) {
    try {
      return await window.desktopBridge.getServerUrl();
    } catch {
      // fall through
    }
  }

  // Vite injects env vars prefixed with VITE_
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envUrl = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;

  return envUrl || DEFAULT_SERVER_URL;
}

let initPromise: Promise<McodeTransport> | null = null;

/**
 * Initialize the WebSocket transport. Resolves the server URL once and
 * creates a persistent connection. Subsequent calls return the same instance.
 */
export async function initTransport(): Promise<McodeTransport> {
  if (transport) return transport;
  if (initPromise) return initPromise;

  initPromise = resolveServerUrl().then((url) => {
    transport = createWsTransport(url);
    return transport;
  });

  return initPromise;
}

/**
 * Return the transport instance synchronously.
 *
 * Throws if `initTransport()` has not been called and resolved yet.
 * This preserves the existing call-site contract where stores and
 * components call `getTransport()` without awaiting.
 */
export function getTransport(): McodeTransport {
  if (!transport) {
    throw new Error(
      "Transport not initialized. Call initTransport() at app startup before accessing getTransport().",
    );
  }
  return transport;
}
