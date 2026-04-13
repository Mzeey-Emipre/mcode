import type { McodeTransport } from "./types";
import { createWsTransport } from "./ws-transport";
import { ipcPushClient } from "./ipc-push-client";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";

/** Re-exported transport and domain types for use across the web app. */
export type { McodeTransport, Workspace, Thread, Message, ToolCall, GitBranch, WorktreeInfo, PermissionMode, InteractionMode, AttachmentMeta, StoredAttachment, SkillInfo, PrInfo, PrDetail, ToolCallRecord, Settings, PartialSettings, PlanAnswer } from "./types";
export { PERMISSION_MODES, INTERACTION_MODES } from "./types";
export { pushEmitter } from "./ws-transport";

/** Default server URL when running standalone (no Electron shell). */
const DEFAULT_SERVER_URL = "ws://localhost:19400";

/** How long to wait for the WebSocket to connect before giving up. */
const CONNECT_TIMEOUT_MS = 5000;

let transport: (McodeTransport & { close(): void; waitForConnection(timeoutMs: number): Promise<void> }) | null = null;

/**
 * Scan a port range to find the mcode server.
 * Probes /health with the stored auth token.
 */
async function scanPortRange(
  portMin: number,
  portMax: number,
  token: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const probes = Array.from({ length: portMax - portMin }, (_, i) => {
      const port = portMin + i;
      return fetch(`http://localhost:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
        .then((r) => (r.ok ? port : null))
        .catch(() => null);
    });

    const results = await Promise.all(probes);
    const foundPort = results.find((p) => p !== null);
    return foundPort ? `ws://localhost:${foundPort}?token=${token}` : null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve the WebSocket server URL and IPC path.
 *
 * In Electron, `window.desktopBridge.getServerUrl()` returns the URL and IPC
 * path of the server spawned by the main process. In standalone / dev mode we
 * fall back to an environment variable or the default localhost URL.
 */
async function resolveServerUrl(): Promise<{ url: string; ipcPath: string }> {
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

  return { url: envUrl || DEFAULT_SERVER_URL, ipcPath: "" };
}

let initPromise: Promise<McodeTransport> | null = null;

/**
 * Initialize the WebSocket transport. Resolves the server URL once and
 * creates a persistent connection. Subsequent calls return the same instance.
 */
export async function initTransport(): Promise<McodeTransport> {
  if (transport) return transport;
  if (initPromise) return initPromise;

  initPromise = resolveServerUrl().then(async ({ url, ipcPath }) => {
    transport = createWsTransport(url, {
      onStatusChange: (status) => {
        useConnectionStore.getState().setStatus(status);
        // Re-fetch settings on reconnect so stale state from a server restart
        // is replaced with the latest values.
        if (status === "connected") {
          void useSettingsStore.getState().fetch();
        }
      },
      discoverServerUrl: async () => {
        // In Electron, ask the desktop bridge for the current server URL
        if (window.desktopBridge?.getServerUrl) {
          const info = await window.desktopBridge.getServerUrl();
          return info.url;
        }
        // In browser, scan the port range with the stored token
        const token = localStorage.getItem("mcode-auth-token") ?? "";
        const found = await scanPortRange(19400, 19800, token);
        if (found) return found;
        throw new Error("Server not found");
      },
    });

    // Connect IPC fast path if available
    if (ipcPath) {
      ipcPushClient.connect(ipcPath);
    }

    try {
      await transport.waitForConnection(CONNECT_TIMEOUT_MS);
    } catch (err) {
      transport.close();
      transport = null;
      initPromise = null;
      throw err;
    }
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
