import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

  it("registers exactly the eight public tools", async () => {
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
});
