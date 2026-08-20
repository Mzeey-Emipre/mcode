import type { McodeTransport } from "./types";
import { createWsTransport } from "./ws-transport";
import { ipcPushClient } from "./ipc-push-client";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { scanPortRange, AUTH_TOKEN_STORAGE_KEY } from "./scan-port-range";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";

/** Re-exported transport and domain types for use across the web app. */
export type { McodeTransport, Workspace, Thread, Message, ToolCall, HookExecution, GitBranch, GitRemoteUrl, WorktreeInfo, PermissionMode, InteractionMode, AttachmentMeta, StoredAttachment, ProviderCatalogRequest, ProviderCatalogSnapshot, PrInfo, PrDetail, PullRequestCapabilities, PullRequestCapabilityLimitation, PullRequestError, PullRequestIdentity, PullRequestRelationship, PullRequestState, PullRequestSummary, PullRequestFile, PullRequestFileChangeType, PullRequestFilePatchStatus, PullRequestPatchResult, ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord, Settings, PartialSettings, PlanAnswer, TerminalProfileList, TerminalWorkspacePreference, TerminalPreferencesResult } from "./types";
export { PERMISSION_MODES, INTERACTION_MODES } from "./types";
export type { WorkspaceEnvironmentDocument, WorkspaceEnvironmentReadResult } from "./types";
export { pushEmitter } from "./ws-transport";
export { RpcError } from "./ws-transport";

/** Default server URL when running standalone (no Electron shell). */
const DEFAULT_SERVER_URL = "ws://localhost:19400";
const RUNTIME_CONTRACT_ENDPOINT = "/__mcode_runtime/ports.json";

/** Inclusive-min / exclusive-max port window scanned when no backend is pinned. */
const SERVER_SCAN_MIN = 19400;
const SERVER_SCAN_MAX = 19800;

/**
 * Parse an explicit port out of a server URL, or null when the URL is empty,
 * has no explicit port, or is unparseable. Pure (no env access) so it is unit
 * testable; `getPinnedServerPort` supplies the env value.
 */
export function parseServerPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Read the port pinned by `VITE_SERVER_URL`, or null when it is unset.
 *
 * When a backend is pinned (dev / demo / standalone-against-a-known-server),
 * reconnect must target only that port. A full-range scan here once let a dev
 * page whose pinned backend had dropped silently reattach to a different server
 * on the range — including a production app — and mutate its database. Returning
 * the pinned port lets `discoverServerUrl` fail visibly instead of wandering.
 */
export function getPinnedServerPort(): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envUrl = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;
  return parseServerPort(envUrl);
}

/**
 * Decide which `[min, max)` port window a browser-mode reconnect should scan.
 *
 * When a backend is pinned, the window is exactly that one port so reconnect can
 * never latch onto a different server. When nothing is pinned (standalone /
 * production build, where `VITE_SERVER_URL` is unset), it falls back to the full
 * range — preserving the original behavior. Pure so the branch is unit testable.
 */
export function getReconnectScanRange(pinnedPort: number | null): { min: number; max: number } {
  if (pinnedPort !== null) {
    return { min: pinnedPort, max: pinnedPort + 1 };
  }
  return { min: SERVER_SCAN_MIN, max: SERVER_SCAN_MAX };
}

/** Returns whether this browser build must bind only to its paired worktree server. */
export function isSingleInstanceDev(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (import.meta as any).env?.VITE_MCODE_SINGLE_INSTANCE as string | undefined;
  return raw === "true" || raw === "1";
}

/**
 * Builds the single-instance WebSocket URL from the worktree runtime contract.
 *
 * This browser-side validation intentionally mirrors the Node script contract
 * because the JSON is fetched at runtime and must be checked before it can drive
 * a WebSocket URL.
 */
export function buildSingleInstanceServerUrl(contract: unknown): string {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("Runtime contract must be an object");
  }
  const record = contract as Record<string, unknown>;
  const seedLogin = record.seedLogin;
  const serverPort = record.serverPort;
  if (
    typeof serverPort !== "number" ||
    !Number.isInteger(serverPort) ||
    serverPort <= 0 ||
    serverPort > 65_535
  ) {
    throw new Error("Runtime contract has an invalid serverPort");
  }
  if (typeof record.instanceToken !== "string" || record.instanceToken.length === 0) {
    throw new Error("Runtime contract is missing instanceToken");
  }
  if (typeof record.worktreeIdentity !== "string" || record.worktreeIdentity.length === 0) {
    throw new Error("Runtime contract is missing worktreeIdentity");
  }
  if (!seedLogin || typeof seedLogin !== "object" || Array.isArray(seedLogin)) {
    throw new Error("Runtime contract is missing seedLogin");
  }
  const token = (seedLogin as Record<string, unknown>).token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Runtime contract is missing seedLogin.token");
  }

  const url = new URL(`ws://127.0.0.1:${serverPort}`);
  url.searchParams.set("token", token);
  url.searchParams.set("instanceToken", record.instanceToken);
  url.searchParams.set("worktree", record.worktreeIdentity);
  return url.toString();
}

async function readSingleInstanceServerUrl(): Promise<string> {
  const response = await fetch(RUNTIME_CONTRACT_ENDPOINT, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Runtime contract unavailable: ${response.status}`);
  }
  return buildSingleInstanceServerUrl(await response.json());
}

/** How long to wait for the WebSocket to connect before giving up. */
const CONNECT_TIMEOUT_MS = 5000;

let transport: (McodeTransport & { close(): void; waitForConnection(timeoutMs: number): Promise<void> }) | null = null;

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

  if (isSingleInstanceDev()) {
    return { url: await readSingleInstanceServerUrl(), ipcPath: "" };
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
    // Persist the auth token from the initial URL so browser-mode reconnects
    // can re-discover the server with a valid token after a restart.
    try {
      const parsedUrl = new URL(url, "http://localhost");
      const token = parsedUrl.searchParams.get("token");
      if (token) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } catch { /* ignore parse errors */ }

    transport = createWsTransport(url, {
      onStatusChange: (status) => {
        useConnectionStore.getState().setStatus(status);
        // Re-fetch settings on reconnect so stale state from a server restart
        // is replaced with the latest values.
        if (status === "connected") {
          void useSettingsStore.getState().fetch();
          void useProviderModelsStore.getState().initialize();
          void useProviderAvailabilityStore.getState().fetch();
        }
      },
      discoverServerUrl: async () => {
        // In Electron, ask the desktop bridge for the current server URL
        if (window.desktopBridge?.getServerUrl) {
          const info = await window.desktopBridge.getServerUrl();
          return info.url;
        }
        if (isSingleInstanceDev()) {
          return readSingleInstanceServerUrl();
        }
        // In browser, reconnect using the last-known token from localStorage so
        // the URL carries valid auth.
        const savedToken = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? "";
        // When a backend is pinned (dev / demo), only ever reattach to that one
        // port. Never fall back to a range scan that could latch onto a
        // different (production) server and write to the wrong database.
        const pinnedPort = getPinnedServerPort();
        const { min, max } = getReconnectScanRange(pinnedPort);
        const found = await scanPortRange(min, max, savedToken);
        if (found) return found;
        throw new Error(
          pinnedPort !== null ? `Pinned server on port ${pinnedPort} not reachable` : "Server not found",
        );
      },
    });

    // Connect IPC fast path if available
    if (ipcPath) {
      ipcPushClient.connect();
    }

    try {
      await transport.waitForConnection(CONNECT_TIMEOUT_MS);
      await transport.terminalCapabilities();
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
