import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ExternalThreadControlMcpRuntime } from "../external-thread-control-mcp-runtime.js";
import { createExternalThreadControlMcpSession } from "../external-thread-control-mcp-transport.js";

const pairing = {
  pairingId: "pairing-1",
  integrationId: "integration-1",
  workspaceIds: ["workspace-1"],
  scopes: ["threads:read-project"],
  callsPerMinute: 10,
  maxActiveThreads: 2,
  status: "active",
  authorityEpoch: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

function createHarness() {
  const service = {
    workspaceSearch: vi.fn(),
    worktreeList: vi.fn(),
    threadCreateBatch: vi.fn(),
    threadSearch: vi.fn().mockReturnValue({ threads: [] }),
    threadGet: vi.fn(),
    threadSend: vi.fn(),
    threadStop: vi.fn(),
    threadWait: vi.fn(),
  };
  const pairingService = {
    authenticate: vi.fn().mockReturnValue({
      pairing,
      authority: {
        type: "external",
        pairingId: pairing.pairingId,
        authorityEpoch: pairing.authorityEpoch,
        integrationId: pairing.integrationId,
        allowedWorkspaceIds: pairing.workspaceIds,
        scopes: pairing.scopes,
        limits: { callsPerMinute: pairing.callsPerMinute, maxActiveThreads: pairing.maxActiveThreads },
      },
    }),
    beginDelivery: vi.fn()
      .mockReturnValueOnce({ status: "reserved", key: "pairing-1:1:delivery-1" })
      .mockReturnValueOnce({ status: "joined", key: "pairing-1:1:delivery-1" })
      .mockReturnValueOnce({ status: "reserved", key: "pairing-1:1:delivery-2" }),
    finalizeDelivery: vi.fn(),
  };
  return { service, pairingService };
}

function initializeBody(id: number) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: `client-${id}`, version: "1.0.0" },
    },
  });
}

async function withRuntimeServer(runtime: ExternalThreadControlMcpRuntime, callback: (port: number) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    void runtime.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a port");
    await callback(address.port);
  } finally {
    await runtime.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("external thread-control MCP transport", () => {
  it("derives authority, deduplicates concurrent delivery, and preserves separate deliveries", async () => {
    const { service, pairingService } = createHarness();
    const session = createExternalThreadControlMcpSession({ pairingService: pairingService as never, service: service as never });
    const first = session.dispatch({ bearerCredential: "credential", requestId: "request-1", deliveryId: "delivery-1", toolName: "thread_search", arguments: {} });
    const second = session.dispatch({ bearerCredential: "credential", requestId: "request-2", deliveryId: "delivery-1", toolName: "thread_search", arguments: {} });
    await expect(Promise.all([first, second])).resolves.toEqual([{ threads: [] }, { threads: [] }]);
    await session.dispatch({ bearerCredential: "credential", requestId: "request-3", deliveryId: "delivery-2", toolName: "thread_search", arguments: {} });
    expect(service.threadSearch).toHaveBeenCalledTimes(2);
    expect(service.threadSearch).toHaveBeenCalledWith(expect.objectContaining({ pairingId: "pairing-1", authorityEpoch: 1 }), { limit: 20 });
    expect(pairingService.finalizeDelivery).toHaveBeenCalledTimes(2);
  });

  it("rejects forged authority fields in tool arguments before service dispatch", async () => {
    const { service, pairingService } = createHarness();
    const session = createExternalThreadControlMcpSession({ pairingService: pairingService as never, service: service as never });
    await expect(session.dispatch({
      bearerCredential: "credential",
      requestId: "request-1",
      deliveryId: "delivery-1",
      toolName: "thread_search",
      arguments: { authority: { integrationId: "forged" } },
    })).rejects.toThrow();
    expect(service.threadSearch).not.toHaveBeenCalled();
  });

  it("uses the normal MCP request id as the delivery key when no delivery header exists", async () => {
    const { service, pairingService } = createHarness();
    const session = createExternalThreadControlMcpSession({ pairingService: pairingService as never, service: service as never });
    const first = session.dispatch({
      bearerCredential: "credential",
      requestId: "normal-request-id",
      toolName: "thread_search",
      arguments: {},
    });
    const duplicate = session.dispatch({
      bearerCredential: "credential",
      requestId: "normal-request-id",
      toolName: "thread_search",
      arguments: {},
    });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([{ threads: [] }, { threads: [] }]);
    expect(service.threadSearch).toHaveBeenCalledTimes(1);
    expect(pairingService.beginDelivery).toHaveBeenCalledWith(expect.anything(), "normal-request-id", expect.any(String));
  });

  it("registers exactly the nine public tools", async () => {
    const { service, pairingService } = createHarness();
    const session = createExternalThreadControlMcpSession({ pairingService: pairingService as never, service: service as never });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = session.createServer("credential");
    const client = new Client({ name: "external-thread-control-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: "workspace_search" },
        { name: "worktree_list" },
        { name: "thread_create_batch" },
        { name: "thread_target_list" },
        { name: "thread_search" },
        { name: "thread_get" },
        { name: "thread_send" },
        { name: "thread_stop" },
        { name: "thread_wait" },
      ],
    });
    await client.close();
    await server.close();
  });

  it("isolates independent initialize requests on one runtime", async () => {
    const { pairingService } = createHarness();
    const runtime = new ExternalThreadControlMcpRuntime({} as never, pairingService as never);
    await withRuntimeServer(runtime, async (port) => {
      const headers = {
        Authorization: "Bearer credential",
        "x-mcode-pairing-id": pairing.pairingId,
        "x-mcode-authority-epoch": String(pairing.authorityEpoch),
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      const responses = [];
      for (const id of [1, 2]) {
        const response = await fetch(`http://127.0.0.1:${port}/mcp/external-thread-control`, {
          method: "POST",
          headers,
          body: initializeBody(id),
        });
        responses.push(response.status);
        await response.text();
        expect((runtime as unknown as { activeRequests: Set<unknown> }).activeRequests.size).toBe(0);
      }
      expect(responses).toEqual([200, 200]);
    });
  });

  it("enforces loopback and bounded body checks before authentication", async () => {
    const pairings = { authenticate: vi.fn() };
    const runtime = new ExternalThreadControlMcpRuntime({} as never, pairings as never);
    const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as unknown as ServerResponse;
    const makeRequest = (address: string, body: string, headers: Record<string, string> = {}) => {
      const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
      Object.assign(request, {
        method: "POST",
        headers: { authorization: "Bearer credential", ...headers },
        socket: { remoteAddress: address },
      });
      return request;
    };

    const external = response();
    await runtime.handleRequest(makeRequest("192.0.2.1", "{}"), external);
    expect(external.writeHead).toHaveBeenCalledWith(403);
    expect(pairings.authenticate).not.toHaveBeenCalled();

    const oversized = response();
    await runtime.handleRequest(makeRequest("127.0.0.1", "{}", { "content-length": String(256 * 1_024 + 1) }), oversized);
    expect(oversized.writeHead).toHaveBeenCalledWith(413);
    expect(pairings.authenticate).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("rejects chunked body overflow without invoking the MCP transport", async () => {
    const pairings = { authenticate: vi.fn() };
    const runtime = new ExternalThreadControlMcpRuntime({} as never, pairings as never);
    const request = Readable.from([Buffer.alloc(256 * 1_024), Buffer.from("x")]) as unknown as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      headers: { authorization: "Bearer credential", "transfer-encoding": "chunked" },
      socket: { remoteAddress: "::1" },
    });
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false } as unknown as ServerResponse;
    await runtime.handleRequest(request, response);
    expect(response.writeHead).toHaveBeenCalledWith(413);
    await runtime.close();
  });
});
