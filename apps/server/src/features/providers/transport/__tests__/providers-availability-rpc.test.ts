/**
 * Integration tests for the providers.listAvailability and provider.listModels RPC methods.
 *
 * Boots an in-process HTTP + WebSocket server using the same approach as
 * ws-server-health.test.ts: minimal RouterDeps stubs, no DI container, no SQLite.
 */

import "reflect-metadata";
import { describe, it, expect, afterEach } from "vitest";
import * as NodeHTTP from "node:http";
import WebSocket from "ws";
import { createWsServer } from "../../../../application/transport/ws-server.js";
import type { RouterDeps } from "../../../../application/transport/ws-router.js";
import type { ProviderAvailability } from "@mcode/contracts";
import { ProviderDisabledError } from "../../availability/provider-availability-errors.js";

const AUTH_TOKEN = "test-token-providers";

/**
 * Minimal RouterDeps stub.
 * Only providerAvailability is exercised by the routes under test.
 */
function makeMinimalDeps(
  overrides: Partial<RouterDeps> = {},
): RouterDeps & { authToken: string; shutdown: () => void } {
  return {
    authToken: AUTH_TOKEN,
    shutdown: () => {},
    agentService: {
      runtimeAccess: () => ({ activeCount: () => 0 }),
    } as unknown as RouterDeps["agentService"],
    workspaceService: undefined as unknown as RouterDeps["workspaceService"],
    threadService: undefined as unknown as RouterDeps["threadService"],
    gitService: undefined as unknown as RouterDeps["gitService"],
    githubService: undefined as unknown as RouterDeps["githubService"],
    fileService: undefined as unknown as RouterDeps["fileService"],
    workspaceInvalidations: { unwatchClient: () => undefined } as unknown as RouterDeps["workspaceInvalidations"],
    configService: undefined as unknown as RouterDeps["configService"],
    skillService: undefined as unknown as RouterDeps["skillService"],
    terminalService: { disconnectClient: () => undefined } as unknown as RouterDeps["terminalService"],
    messageRepo: undefined as unknown as RouterDeps["messageRepo"],
    toolCallRecordRepo: undefined as unknown as RouterDeps["toolCallRecordRepo"],
    turnSnapshotRepo: undefined as unknown as RouterDeps["turnSnapshotRepo"],
    snapshotService: undefined as unknown as RouterDeps["snapshotService"],
    settingsService: undefined as unknown as RouterDeps["settingsService"],
    gitWatcherService: undefined as unknown as RouterDeps["gitWatcherService"],
    memoryPressureService: undefined as unknown as RouterDeps["memoryPressureService"],
    taskRepo: undefined as unknown as RouterDeps["taskRepo"],
    providerRegistry: undefined as unknown as RouterDeps["providerRegistry"],
    prDraftService: undefined as unknown as RouterDeps["prDraftService"],
    threadRepo: undefined as unknown as RouterDeps["threadRepo"],
    workspaceRepo: undefined as unknown as RouterDeps["workspaceRepo"],
    ciWatcherService: undefined as unknown as RouterDeps["ciWatcherService"],
    providerAvailability: undefined as unknown as RouterDeps["providerAvailability"],
    threadDeletionTeardownService: undefined as unknown as RouterDeps["threadDeletionTeardownService"],
    ...overrides,
  } as unknown as RouterDeps & { authToken: string; shutdown: () => void };
}

/** Build a WebSocket URL with the auth token as a query param. */
function wsUrl(server: NodeHTTP.Server): string {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Not bound to TCP");
  return `ws://127.0.0.1:${addr.port}/?token=${AUTH_TOKEN}`;
}

/**
 * Send one RPC call over WebSocket and resolve with the parsed response.
 * Rejects if the socket emits an error before a message arrives.
 */
function rpcCall(
  server: NodeHTTP.Server,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ id: string; result?: unknown; error?: { code: string; message: string; data?: unknown } }> {
  return new Promise((resolve, reject) => {
    const requestId = "req-1";
    const client = new WebSocket(wsUrl(server));
    client.on("open", () => {
      client.send(JSON.stringify({ id: requestId, method, params }));
    });
    client.on("message", (raw) => {
      // Filter by id: server-initiated pushes have no id / a different id and
      // must not be mistaken for the RPC response we're awaiting.
      try {
        const msg = JSON.parse(raw.toString()) as { id?: string };
        if (msg.id !== requestId) return;
        client.close();
        resolve(msg as ReturnType<typeof rpcCall> extends Promise<infer T> ? T : never);
      } catch (err) {
        client.close();
        reject(err);
      }
    });
    client.on("error", reject);
  });
}

describe("providers.listAvailability RPC", () => {
  let server: NodeHTTP.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns six entries in catalog order", async () => {
    /** Canned response that mirrors PROVIDER_CATALOG order. */
    const fakeAvailability: ProviderAvailability[] = [
      { id: "claude",   enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "codex",    enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "copilot",  enabled: false, hasAdapter: true,  beta: true,  comingSoon: false, cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "gemini",   enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "cursor",   enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
      { id: "opencode", enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } },
    ];

    const deps = makeMinimalDeps({
      providerAvailability: {
        listAvailability: () => fakeAvailability,
      } as unknown as RouterDeps["providerAvailability"],
    });

    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const response = await rpcCall(server, "providers.listAvailability");

    expect(response.error).toBeUndefined();
    const result = response.result as ProviderAvailability[];
    expect(result.map((e) => e.id)).toEqual([
      "claude",
      "codex",
      "copilot",
      "gemini",
      "cursor",
      "opencode",
    ]);
  });

  it("returns PROVIDER_DISABLED when calling listModels on a disabled provider", async () => {
    // Stub assertEnabled to throw ProviderDisabledError for "codex".
    // listModels uses assertEnabled (not assertUsable) so it works for SDK-based
    // providers that don't require a CLI binary. This simulates
    // settings.provider.enabled.codex = false without needing a real SettingsService.
    const deps = makeMinimalDeps({
      providerAvailability: {
        assertEnabled: (id: string) => {
          if (id === "codex") throw new ProviderDisabledError("codex");
        },
        assertUsable: () => {},
        listAvailability: () => [],
      } as unknown as RouterDeps["providerAvailability"],
    });

    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const response = await rpcCall(server, "provider.listModels", { providerId: "codex" });

    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe("PROVIDER_DISABLED");
  });
});
