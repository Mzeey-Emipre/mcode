/**
 * Unit-style tests for the /health HTTP endpoint in createWsServer.
 * Spins up the real HTTP server with a minimal mock of RouterDeps so we
 * don't need the full DI container.
 */

import "reflect-metadata";
import { describe, it, expect, afterEach, vi } from "vitest";
import * as NodeHTTP from "node:http";
import { WebSocket } from "ws";
import { createWsServer } from "../ws-server.js";
import type { RouterDeps } from "../ws-router.js";

/** Minimal RouterDeps stub — only agentService is called by the health handler. */
function makeMinimalDeps(
  overrides: Partial<RouterDeps & {
    authToken: string;
    singleInstance: boolean;
    instanceToken: string | null;
    worktreeIdentity: string | null;
    shutdown: () => void;
  }> = {},
): RouterDeps & {
  authToken: string;
  singleInstance: boolean;
  instanceToken: string | null;
  worktreeIdentity: string | null;
  shutdown: () => void;
} {
  return {
    authToken: "test-token-abc",
    singleInstance: false,
    instanceToken: null,
    worktreeIdentity: null,
    shutdown: vi.fn(),
    agentService: {
      runtimeAccess: () => ({ activeCount: () => 2 }),
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
    threadDeletionTeardownService: undefined as unknown as RouterDeps["threadDeletionTeardownService"],
    ...overrides,
  } as unknown as RouterDeps & {
    authToken: string;
    singleInstance: boolean;
    instanceToken: string | null;
    worktreeIdentity: string | null;
    shutdown: () => void;
  };
}

/** Issue a GET /health request to the given server and return status + parsed body. */
function getHealth(server: NodeHTTP.Server): Promise<{ status: number; body: unknown; headers: NodeHTTP.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      return reject(new Error("Server not listening on a TCP port"));
    }
    const req = NodeHTTP.get(
      { host: "127.0.0.1", port: addr.port, path: "/health" },
      (res) => {
        let raw = "";
        res.on("data", (chunk: string) => { raw += chunk; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers });
          }
        });
      },
    );
    req.on("error", reject);
  });
}

/** Issue a POST /shutdown request to the given server. */
function postShutdown(
  server: NodeHTTP.Server,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      return reject(new Error("Server not listening on a TCP port"));
    }
    const req = NodeHTTP.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path: "/shutdown",
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: string) => { raw += chunk; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function providerCatalogRpc(
  server: NodeHTTP.Server,
  token: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening on a TCP port"));
      return;
    }
    const url = new URL(`ws://127.0.0.1:${addr.port}`);
    url.searchParams.set("token", token);
    const ws = new WebSocket(url);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        id: "provider-catalog-auth",
        method: "provider.catalog",
        params: { providerId: "claude" },
      }));
    });
    ws.on("message", (data) => {
      const response = JSON.parse(data.toString()) as Record<string, unknown>;
      if (response.id !== "provider-catalog-auth") return;
      ws.close();
      resolve(response);
    });
    ws.on("error", reject);
  });
}

describe("/health endpoint", () => {
  let server: NodeHTTP.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("responds with status 200", async () => {
    const deps = makeMinimalDeps();
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { status } = await getHealth(server);
    expect(status).toBe(200);
  });

  it("includes authToken in the response body", async () => {
    const deps = makeMinimalDeps();
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { body } = await getHealth(server);
    expect((body as Record<string, unknown>).authToken).toBe("test-token-abc");
  });

  it("always sets the Set-Cookie header (no auth required)", async () => {
    const deps = makeMinimalDeps();
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { headers } = await getHealth(server);
    expect(headers["set-cookie"]).toBeDefined();
    const cookieHeader = Array.isArray(headers["set-cookie"])
      ? headers["set-cookie"][0]
      : headers["set-cookie"];
    expect(cookieHeader).toContain("mcode-auth=test-token-abc");
  });

  it("does not expose authToken or Set-Cookie in single-instance mode", async () => {
    const deps = makeMinimalDeps({
      singleInstance: true,
      instanceToken: "instance-token-abc1234567890abc1234567890",
      worktreeIdentity: "C:\\repo\\worktree",
    });
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { body, headers } = await getHealth(server);
    expect((body as Record<string, unknown>).authToken).toBeUndefined();
    expect(headers["set-cookie"]).toBeUndefined();
  });

  it("includes status and activeAgents in the response body", async () => {
    const deps = makeMinimalDeps();
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { body } = await getHealth(server);
    expect((body as Record<string, unknown>).status).toBe("ok");
    expect((body as Record<string, unknown>).activeAgents).toBe(2);
  });

  it("exposes content-free browser automation reliability diagnostics", async () => {
    const deps = makeMinimalDeps({
      browserAutomationBroker: {
        status: () => ({ hosts: 1, pending: 2, assignments: 3 }),
        reliabilityStatus: () => ({
          dispatched: 4,
          succeeded: 2,
          failed: 2,
          timedOut: 1,
          interrupted: 0,
          truncated: 1,
          hostLosses: 1,
          capacityRejected: 0,
          latencyTotalMs: 40,
          latencyMaxMs: 25,
          roundTripLatency: { samples: 2, p50Ms: 20, p95Ms: 25, p99Ms: 25 },
        }),
        nightlyEvidenceStatus: () => ({
          observedRequests: 4,
          successfulRequests: 2,
          expectedFailures: 1,
          unexpectedFailures: 1,
          unexpectedFailureRate: 0.25,
          classifiedFailures: { "lost-transport": 1 },
          zeroTolerance: {
            falseSuccess: 0,
            postTakeoverEffect: 0,
            ambiguousOwnership: 0,
            staleMutation: 0,
            unknownOutcome: 0,
            sensitiveDataViolation: 0,
          },
          retainedEvents: 12,
          recentFailures: [],
        }),
      } as never,
    });
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { body } = await getHealth(server);
    const browserAutomation = (body as { browserAutomation?: unknown }).browserAutomation;
    expect(browserAutomation).toEqual({
      hosts: 1,
      pending: 2,
      assignments: 3,
      reliability: expect.objectContaining({ dispatched: 4, timedOut: 1, hostLosses: 1 }),
      nightlyEvidence: expect.objectContaining({
        unexpectedFailureRate: 0.25,
      }),
    });
    expect(JSON.stringify(browserAutomation)).not.toMatch(/url|thread|credential/i);
  });

});

describe("single-instance WebSocket attachment", () => {
  let server: NodeHTTP.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns structured WRONG_INSTANCE refusal without token values", async () => {
    const deps = makeMinimalDeps({
      singleInstance: true,
      authToken: "expected-auth-token",
      instanceToken: "expected-instance-token-abc1234567890abc1234567890",
      worktreeIdentity: "C:\\repo\\expected",
    });
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Server did not bind");

    const refusal = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const url = new URL(`ws://127.0.0.1:${addr.port}`);
      url.searchParams.set("token", "wrong-auth-token");
      url.searchParams.set("instanceToken", "wrong-instance-token");
      url.searchParams.set("worktree", "C:\\repo\\presented");
      const ws = new WebSocket(url);
      ws.on("message", (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      ws.on("error", reject);
    });

    expect(refusal).toEqual({
      type: "refusal",
      error: {
        code: "WRONG_INSTANCE",
        expectedWorktree: "C:\\repo\\expected",
        presentedWorktree: "C:\\repo\\presented",
      },
    });
    expect(JSON.stringify(refusal)).not.toContain("expected-auth-token");
    expect(JSON.stringify(refusal)).not.toContain("expected-instance-token");
    expect(JSON.stringify(refusal)).not.toContain("wrong-auth-token");
    expect(JSON.stringify(refusal)).not.toContain("wrong-instance-token");
  });
});

describe("authenticated WebSocket provider catalog", () => {
  let server: NodeHTTP.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns the provider catalog through the authenticated transport", async () => {
    const request = vi.fn(async (
      input: { refresh: () => Promise<unknown> },
    ) => input.refresh());
    const deps = makeMinimalDeps({
      skillService: {
        list: vi.fn(() => [{
          name: "review",
          description: "Review changes",
          kind: "skill",
          source: "user",
          providers: ["claude"],
          path: "C:/skills/review/SKILL.md",
        }]),
      } as unknown as RouterDeps["skillService"],
      providerCatalogService: { request } as unknown as RouterDeps["providerCatalogService"],
    });
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const response = await providerCatalogRpc(server, "test-token-abc");

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      providerId: "claude",
      context: { scope: "user" },
      freshness: { status: "fresh" },
      entries: [expect.objectContaining({
        kind: "skill",
        name: "review",
      })],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([undefined, "wrong-token"])(
    "rejects provider catalog dispatch when the token is %s",
    async (token) => {
      const request = vi.fn();
      const deps = makeMinimalDeps({
        providerCatalogService: { request } as unknown as RouterDeps["providerCatalogService"],
      });
      ({ httpServer: server } = createWsServer(deps));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Server did not bind");
      const url = new URL(`ws://127.0.0.1:${addr.port}`);
      if (token) url.searchParams.set("token", token);

      const refusal = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on("open", () => {
          ws.send(JSON.stringify({
            id: "provider-catalog-unauthorized",
            method: "provider.catalog",
            params: { providerId: "claude" },
          }));
        });
        ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on("error", reject);
      });

      expect(refusal).toEqual({ code: 4001, reason: "Unauthorized" });
      expect(request).not.toHaveBeenCalled();
    },
  );
});

describe("/shutdown endpoint", () => {
  let server: NodeHTTP.Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("runs the injected shutdown callback after an authorized request", async () => {
    const shutdown = vi.fn();
    const deps = makeMinimalDeps({ shutdown });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const { status, body } = await postShutdown(server, "test-token-abc");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(status).toBe(200);
      expect(body).toEqual({ status: "shutting_down" });
      expect(shutdown).toHaveBeenCalledOnce();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("rejects unauthenticated shutdown requests", async () => {
    const shutdown = vi.fn();
    const deps = makeMinimalDeps({ shutdown });
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { status, body } = await postShutdown(server);

    expect(status).toBe(401);
    expect(body).toBe("Unauthorized");
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("rejects shutdown requests with the wrong token", async () => {
    const shutdown = vi.fn();
    const deps = makeMinimalDeps({ shutdown });
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { status, body } = await postShutdown(server, "wrong-token");

    expect(status).toBe(401);
    expect(body).toBe("Unauthorized");
    expect(shutdown).not.toHaveBeenCalled();
  });
});
