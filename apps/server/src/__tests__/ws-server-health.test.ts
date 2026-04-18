/**
 * Unit-style tests for the /health HTTP endpoint in createWsServer.
 * Spins up the real HTTP server with a minimal mock of RouterDeps so we
 * don't need the full DI container.
 */

import "reflect-metadata";
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { createWsServer } from "../transport/ws-server";
import type { RouterDeps } from "../transport/ws-router";

/** Minimal RouterDeps stub — only agentService is called by the health handler. */
function makeMinimalDeps(): RouterDeps & { authToken: string } {
  return {
    authToken: "test-token-abc",
    agentService: { activeCount: () => 2 } as unknown as RouterDeps["agentService"],
    workspaceService: undefined as unknown as RouterDeps["workspaceService"],
    threadService: undefined as unknown as RouterDeps["threadService"],
    gitService: undefined as unknown as RouterDeps["gitService"],
    githubService: undefined as unknown as RouterDeps["githubService"],
    fileService: undefined as unknown as RouterDeps["fileService"],
    configService: undefined as unknown as RouterDeps["configService"],
    skillService: undefined as unknown as RouterDeps["skillService"],
    terminalService: undefined as unknown as RouterDeps["terminalService"],
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
  };
}

/** Issue a GET /health request to the given server and return status + parsed body. */
function getHealth(server: http.Server): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      return reject(new Error("Server not listening on a TCP port"));
    }
    const req = http.get(
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

describe("/health endpoint", () => {
  let server: http.Server;

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

  it("includes status and activeAgents in the response body", async () => {
    const deps = makeMinimalDeps();
    ({ httpServer: server } = createWsServer(deps));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { body } = await getHealth(server);
    expect((body as Record<string, unknown>).status).toBe("ok");
    expect((body as Record<string, unknown>).activeAgents).toBe(2);
  });
});
