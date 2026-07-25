import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InternalThreadControlMcpAuthority } from "../thread-control-mcp-authority.js";
import { createInternalThreadControlMcpSession } from "../thread-control-mcp-transport.js";
import type { ThreadControlService } from "../thread-control-service.js";

describe("internal thread-control MCP transport", () => {
  it("dispatches workspace_search through an active bearer lease", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "claude",
      permissionMode: "supervised",
    });
    const service = {
      workspaceSearch: vi.fn().mockReturnValue({ workspaces: [] }),
      worktreeList: vi.fn(),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });

    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "call-1",
      toolName: "workspace_search",
      arguments: { query: "mcode" },
    })).resolves.toEqual({ workspaces: [] });
    expect(service.workspaceSearch).toHaveBeenCalledWith(expect.objectContaining({
      sourceThreadId: "source-thread",
      sourceToolCallId: "call-1",
    }), { query: "mcode", limit: 20 });
  });

  it("fails closed for revoked leases and unsupported tools", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });
    const service = {
      workspaceSearch: vi.fn(),
      worktreeList: vi.fn(),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });

    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "call-2",
      toolName: "thread_create" as never,
      arguments: {},
    })).rejects.toThrow("Internal thread-control MCP request denied");

    await expect(session.dispatch({
      bearerCredential: "invalid",
      requestId: "call-2a",
      toolName: "workspace_search",
      arguments: {},
    })).rejects.toThrow("Internal thread-control MCP request denied");

    authority.revoke(lease.sessionId);
    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "call-3",
      toolName: "workspace_search",
      arguments: {},
    })).rejects.toThrow("Internal thread-control MCP request denied");
    expect(service.workspaceSearch).not.toHaveBeenCalled();
  });

  it("registers only discovery tools and rejects forged tool authority", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "claude",
      permissionMode: "supervised",
    });
    const service = {
      workspaceSearch: vi.fn().mockReturnValue({ workspaces: [] }),
      worktreeList: vi.fn(),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = session.createServer(lease.credential);
    const client = new Client({ name: "thread-control-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: "workspace_search" }, { name: "worktree_list" }],
    });
    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "call-4",
      toolName: "workspace_search",
      arguments: { sourceThreadId: "forged" },
    })).rejects.toBeDefined();
    await client.close();
    await server.close();
  });
});
