import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InternalThreadControlMcpAuthority } from "./thread-control-mcp-authority.js";
import { createInternalThreadControlMcpSession } from "./thread-control-mcp-transport.js";
import type { ThreadControlService } from "./thread-control-service.js";

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
      threadSearch: vi.fn(),
      threadWait: vi.fn(),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = session.createServer(lease.credential);
    const client = new Client({ name: "thread-control-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: "mcode_browser_guide", description: expect.stringContaining("Mcode Browser") },
        { name: "thread_control_guide", description: expect.stringContaining("thread-control") },
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
    await expect(client.callTool({ name: "mcode_browser_guide" })).resolves.toMatchObject({
      structuredContent: { guide: expect.stringContaining("browser_inspect") },
      content: [{ type: "text", text: expect.not.stringContaining("thread_create_batch") }],
    });
    await expect(client.callTool({ name: "thread_control_guide" })).resolves.toMatchObject({
      structuredContent: { guide: expect.stringContaining("thread_create_batch") },
      content: [{ type: "text", text: expect.not.stringContaining("browser_status") }],
    });
    await expect(client.callTool({
      name: "thread_wait",
      arguments: { threadIds: ["duplicate", "duplicate"] },
    })).resolves.toMatchObject({ isError: true });
    expect(service.threadWait).not.toHaveBeenCalled();
    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "call-empty-statuses",
      toolName: "thread_search",
      arguments: { statuses: [] },
    })).rejects.toThrow();
    expect(service.threadSearch).not.toHaveBeenCalled();
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
        { name: "mcode_browser_guide" },
        { name: "thread_control_guide" },
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

  it("validates send and stop result variants at the in-memory caller boundary", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "claude",
      permissionMode: "full",
    });
    const execution = {
      providerId: "claude",
      modelId: "claude-sonnet-4-6",
      permissionMode: "full",
      interactionMode: "build",
    } as const;
    const service = {
      workspaceSearch: vi.fn(),
      worktreeList: vi.fn(),
      threadCreateBatch: vi.fn(),
      threadSend: vi.fn()
        .mockResolvedValueOnce({ status: "accepted", workspaceId: "workspace-1", threadId: "destination-thread", turnId: "turn-1", execution, state: { status: "starting" } })
        .mockResolvedValueOnce({ status: "pending_approval", workspaceId: "workspace-1", threadId: "destination-thread", approvalId: "approval-1", state: { status: "waiting_for_approval", approvalId: "approval-1" } })
        .mockResolvedValueOnce({ status: "rejected", workspaceId: "workspace-1", threadId: "destination-thread", error: { code: "thread_busy", message: "Thread is already running", retryable: true } }),
      threadStop: vi.fn()
        .mockResolvedValueOnce({ status: "accepted", workspaceId: "workspace-1", threadId: "destination-thread", state: { status: "stopped" } })
        .mockResolvedValueOnce({ status: "pending_approval", workspaceId: "workspace-1", threadId: "destination-thread", approvalId: "approval-2", state: { status: "waiting_for_approval", approvalId: "approval-2" } })
        .mockResolvedValueOnce({ status: "rejected", workspaceId: "workspace-1", threadId: "destination-thread", error: { code: "internal_error", message: "Stop failed", retryable: true } }),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });

    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "send-accepted", toolName: "thread_send", arguments: { threadId: "destination-thread", message: "Continue" } })).resolves.toMatchObject({ status: "accepted" });
    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "send-pending", toolName: "thread_send", arguments: { threadId: "destination-thread", message: "Wait" } })).resolves.toMatchObject({ status: "pending_approval" });
    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "send-rejected", toolName: "thread_send", arguments: { threadId: "destination-thread", message: "Retry" } })).resolves.toMatchObject({ status: "rejected" });
    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "stop-accepted", toolName: "thread_stop", arguments: { threadId: "destination-thread" } })).resolves.toMatchObject({ status: "accepted" });
    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "stop-pending", toolName: "thread_stop", arguments: { threadId: "destination-thread" } })).resolves.toMatchObject({ status: "pending_approval" });
    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "stop-rejected", toolName: "thread_stop", arguments: { threadId: "destination-thread" } })).resolves.toMatchObject({ status: "rejected" });

    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "forged-send", toolName: "thread_send", arguments: { threadId: "destination-thread", message: "Forged", sourceThreadId: "source-thread" } })).rejects.toThrow();
    await expect(session.dispatch({ bearerCredential: lease.credential, requestId: "forged-stop", toolName: "thread_stop", arguments: { threadId: "destination-thread", sourceThreadId: "source-thread" } })).rejects.toThrow();
    expect(service.threadSend).toHaveBeenCalledTimes(3);
    expect(service.threadStop).toHaveBeenCalledTimes(3);
  });

  it("dispatches authenticated search, get, and wait calls without destination mutation", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "claude",
      permissionMode: "full",
    });
    const service = {
      workspaceSearch: vi.fn(),
      worktreeList: vi.fn(),
      threadCreateBatch: vi.fn(),
      threadSearch: vi.fn().mockReturnValue({
        threads: [{
          workspaceId: "workspace-1",
          threadId: "destination-thread",
          title: "Destination",
          providerId: "claude",
          modelId: "claude-model",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          state: { status: "running" },
        }],
      }),
      threadGet: vi.fn().mockReturnValue({
        status: "found",
        workspaceId: "workspace-1",
        thread: {
          workspaceId: "workspace-1",
          threadId: "destination-thread",
          title: "Destination",
          providerId: "claude",
          modelId: "claude-model",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          state: { status: "running" },
        },
        messages: [],
        hasMoreMessages: false,
      }),
      threadWait: vi.fn().mockResolvedValue({
        status: "success",
        timedOut: true,
        results: [{ workspaceId: "workspace-1", threadId: "destination-thread", state: { status: "running" } }],
      }),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });

    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "search-call",
      toolName: "thread_search",
      arguments: { query: "Destination" },
    })).resolves.toMatchObject({ threads: [{ threadId: "destination-thread" }] });
    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "get-call",
      toolName: "thread_get",
      arguments: { threadId: "destination-thread" },
    })).resolves.toMatchObject({ status: "found", thread: { threadId: "destination-thread" } });
    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "wait-call",
      toolName: "thread_wait",
      arguments: { threadIds: ["destination-thread"], timeoutSeconds: 1 },
    })).resolves.toMatchObject({ status: "success", timedOut: true, results: [{ state: { status: "running" } }] });
    expect(service.threadSearch).toHaveBeenCalledWith(expect.objectContaining({ sourceToolCallId: "search-call" }), { query: "Destination", limit: 20 });
    expect(service.threadGet).toHaveBeenCalledWith(expect.objectContaining({ sourceToolCallId: "get-call" }), { threadId: "destination-thread", messageLimit: 50 });
    expect(service.threadWait).toHaveBeenCalledWith(expect.objectContaining({ sourceToolCallId: "wait-call" }), { threadIds: ["destination-thread"], until: "attention_or_terminal", timeoutSeconds: 1 }, expect.any(AbortSignal));
    expect(service.threadCreateBatch).not.toHaveBeenCalled();
  });

  it("cancels an authenticated wait when its lease is revoked", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "claude",
      permissionMode: "full",
    });
    const service = {
      workspaceSearch: vi.fn(),
      worktreeList: vi.fn(),
      threadCreateBatch: vi.fn(),
      threadSearch: vi.fn(),
      threadGet: vi.fn(),
      threadWait: vi.fn().mockImplementation(async (_authority, _input, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return {
          status: "success",
          timedOut: true,
          results: [{ workspaceId: "workspace-1", threadId: "destination-thread", state: { status: "running" } }],
        };
      }),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });

    const pending = session.dispatch({
      bearerCredential: lease.credential,
      requestId: "revoke-call",
      toolName: "thread_wait",
      arguments: { threadIds: ["destination-thread"], timeoutSeconds: 10 },
    });
    authority.revoke(lease.sessionId);

    await expect(pending).resolves.toMatchObject({ status: "success", timedOut: true });
    expect(service.threadCreateBatch).not.toHaveBeenCalled();
  });

  it("aborts an authenticated wait when the request disconnects", async () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "pooled-provider-session",
      sourceThreadId: "source-thread",
      sourceTurnId: "source-turn",
      sourceProviderId: "claude",
      permissionMode: "full",
    });
    const service = {
      workspaceSearch: vi.fn(),
      worktreeList: vi.fn(),
      threadCreateBatch: vi.fn(),
      threadSearch: vi.fn(),
      threadGet: vi.fn(),
      threadWait: vi.fn().mockImplementation(async (_authority, _input, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return {
          status: "success",
          timedOut: true,
          results: [{ workspaceId: "workspace-1", threadId: "destination-thread", state: { status: "running" } }],
        };
      }),
    } as unknown as ThreadControlService;
    const session = createInternalThreadControlMcpSession({ authority, service });
    const disconnect = new AbortController();
    const pending = session.dispatch({
      bearerCredential: lease.credential,
      requestId: "disconnect-call",
      toolName: "thread_wait",
      arguments: { threadIds: ["destination-thread"], timeoutSeconds: 10 },
      signal: disconnect.signal,
    });
    disconnect.abort();

    await expect(pending).resolves.toMatchObject({ status: "success", timedOut: true });
    expect(service.threadCreateBatch).not.toHaveBeenCalled();
  });
});
