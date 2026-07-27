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
      threadCreateBatch: vi.fn(),
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
      threadCreateBatch: vi.fn(),
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

  it("registers the internal thread-control tools and rejects forged tool authority", async () => {
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
      threadCreateBatch: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = session.createServer(lease.credential);
    const client = new Client({ name: "thread-control-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: "workspace_search" },
        { name: "worktree_list" },
        { name: "thread_create_batch" },
      ],
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

  it("serves worktree_list through the MCP protocol and fails closed after revocation", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });
    const service = {
      workspaceSearch: vi.fn().mockReturnValue({ workspaces: [] }),
      worktreeList: vi.fn().mockResolvedValue({
        status: "found",
        workspaceId: "workspace-1",
        worktrees: [{ worktreeId: "worktree-1", label: "main", branch: "main" }],
      }),
      threadCreateBatch: vi.fn(),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = session.createServer(lease.credential);
    const client = new Client({ name: "thread-control-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: "workspace_search" },
        { name: "worktree_list" },
        { name: "thread_create_batch" },
      ],
    });
    await expect(client.callTool({ name: "worktree_list", arguments: { workspaceId: "workspace-1" } }))
      .resolves.toMatchObject({
        structuredContent: { status: "found", workspaceId: "workspace-1" },
      });

    authority.revoke(lease.sessionId);
    await expect(client.callTool({ name: "worktree_list", arguments: { workspaceId: "workspace-1" } }))
      .resolves.toMatchObject({ isError: true });
    await client.close();
    await server.close();
  });

  it("dispatches thread_create_batch through the authenticated MCP protocol", async () => {
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
      threadCreateBatch: vi.fn().mockResolvedValue({
        results: [{
          index: 0,
          status: "created",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          turnId: "turn-1",
          execution: {
            providerId: "codex",
            modelId: "gpt-5.6-sol",
            permissionMode: "full",
            interactionMode: "build",
          },
          placement: { type: "direct" },
          state: { status: "starting" },
        }],
      }),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });

    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "create-call",
      toolName: "thread_create_batch",
      arguments: {
        items: [{
          workspaceId: "workspace-1",
          title: "Delegated thread",
          prompt: "Implement the task.",
          placement: { type: "direct" },
        }],
      },
    })).resolves.toMatchObject({
      results: [{ status: "created", threadId: "thread-1" }],
    });
    expect(service.threadCreateBatch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceToolCallId: "create-call" }),
      expect.objectContaining({ items: [expect.objectContaining({ title: "Delegated thread" })] }),
    );
  });
});
