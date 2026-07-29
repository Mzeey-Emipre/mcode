import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../transport/push.js", () => ({ broadcast: vi.fn() }));

import { InternalThreadControlMcpAuthority } from "../thread-control-mcp-authority.js";
import { createInternalThreadControlMcpSession } from "../thread-control-mcp-transport.js";
import { ThreadControlMutationReservationService } from "../thread-control-mutation-reservation-service.js";
import { ThreadControlService, type InternalThreadControlAuthority } from "../thread-control-service.js";

describe("internal thread-control MCP workflow", () => {
  it("searches Projects, creates across a partial batch, and controls the usable worktree thread", async () => {
    const sourceWorkspace = {
      id: "workspace-source",
      name: "Coordinator Project",
      path: "C:/private/coordinator",
      is_git_repo: true,
    };
    const destinationWorkspace = {
      id: "workspace-destination",
      name: "Child Project",
      path: "C:/private/child",
      is_git_repo: true,
    };
    const sourceThread = {
      id: "source-thread",
      workspace_id: sourceWorkspace.id,
      title: "Coordinator",
      status: "active",
      mode: "direct",
      branch: "main",
      permission_mode: "full",
      interaction_mode: "build",
      model: "gpt-default",
      provider: "codex",
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
      deleted_at: null,
    };
    const threadsById = new Map<string, Record<string, unknown>>([[sourceThread.id, sourceThread]]);
    const messagesByThread = new Map<string, Array<Record<string, unknown>>>();
    let createdCount = 0;

    const workspaces = {
      search: vi.fn().mockReturnValue([sourceWorkspace, destinationWorkspace]),
      findById: vi.fn((id: string) => id === sourceWorkspace.id ? sourceWorkspace : id === destinationWorkspace.id ? destinationWorkspace : null),
      findByIdIncludeDeleted: vi.fn((id: string) => id === sourceWorkspace.id ? sourceWorkspace : id === destinationWorkspace.id ? destinationWorkspace : null),
    };
    const worktrees = {
      reconcile: vi.fn().mockReturnValue([{ worktreeId: "worktree-main", label: "main", branch: "main" }]),
      findCurrentById: vi.fn(),
      register: vi.fn().mockReturnValue({ worktreeId: "worktree-created", label: "feature/workflow-proof" }),
    };
    const git = {
      listWorktrees: vi.fn().mockResolvedValue([{ path: "C:/private/child", name: "main", branch: "main", managed: false }]),
      getCurrentBranch: vi.fn().mockResolvedValue("main"),
    };
    const threads = {
      create: vi.fn((workspaceId: string, title: string, mode: string, branch: string, _managed: boolean, provider: string) => {
        createdCount += 1;
        const thread = {
          id: `destination-thread-${createdCount}`,
          workspace_id: workspaceId,
          title,
          status: "active",
          mode,
          branch,
          permission_mode: null,
          interaction_mode: null,
          model: null,
          provider,
          created_at: `2026-07-29T00:00:0${createdCount}.000Z`,
          updated_at: `2026-07-29T00:00:0${createdCount}.000Z`,
          deleted_at: null,
        };
        threadsById.set(thread.id, thread);
        return thread;
      }),
      findById: vi.fn((id: string) => threadsById.get(id) ?? null),
      search: vi.fn(() => ({ threads: [...threadsById.values()], workspaces: [] })),
      updateModel: vi.fn((id: string, model: string) => { const thread = threadsById.get(id); if (thread) thread.model = model; return true; }),
      updateSettings: vi.fn((id: string, settings: { permission_mode: string; interaction_mode: string }) => { const thread = threadsById.get(id); if (thread) Object.assign(thread, settings); return true; }),
      updateDelegationLineage: vi.fn().mockReturnValue(true),
      updateStatus: vi.fn((id: string, status: string) => { const thread = threadsById.get(id); if (thread) thread.status = status; return true; }),
      updateWorktreePath: vi.fn().mockReturnValue(true),
      clearWorktreePath: vi.fn().mockReturnValue(true),
      updateExternalCreator: vi.fn().mockReturnValue(true),
      countActiveByIntegration: vi.fn().mockReturnValue(0),
      findDelegationLineage: vi.fn().mockReturnValue(null),
      listDelegationChildren: vi.fn().mockReturnValue([]),
    };
    const threadService = {
      provisionWorktree: vi.fn().mockImplementation(async (threadId: string) => ({
        ...(threadsById.get(threadId) ?? {}),
        mode: "worktree",
        worktree_path: "C:/private/child/.worktrees/feature-workflow-proof",
      })),
      cleanupInterruptedProvisioning: vi.fn().mockResolvedValue(true),
    };
    const agentService = {
      activeThreadIds: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockImplementation(async (input: { threadId: string; content: string; sourceThreadId?: string; originSourceTurnId?: string; sourceProviderId?: string }) => {
        const thread = threadsById.get(input.threadId);
        if (thread) thread.status = "paused";
        const messages = messagesByThread.get(input.threadId) ?? [];
        messages.push({
          id: `message-${messages.length + 1}`,
          role: "user",
          content: input.content,
          timestamp: `2026-07-29T00:01:0${messages.length}.000Z`,
          provider: null,
          model: null,
          originType: input.sourceThreadId ? "thread" : "composer",
          sourceThreadId: input.sourceThreadId ?? null,
          sourceTurnId: input.originSourceTurnId ?? null,
          sourceProviderId: input.sourceProviderId ?? null,
        });
        messagesByThread.set(input.threadId, messages);
      }),
      stopSession: vi.fn().mockResolvedValue(undefined),
    };
    const approvals = {
      create: vi.fn(), createSend: vi.fn(), createStop: vi.fn(), claim: vi.fn(), settle: vi.fn(),
      setOperationPhase: vi.fn().mockReturnValue(true), listPending: vi.fn().mockReturnValue([]),
      listProcessing: vi.fn().mockReturnValue([]), requeue: vi.fn(), requeueDispatch: vi.fn(),
      requeueRecoveredProvisioning: vi.fn(), listPendingByThread: vi.fn().mockReturnValue([]),
      listPendingBySourceThread: vi.fn().mockReturnValue([]),
    };
    const messages = {
      listByThreadForThreadControl: vi.fn((threadId: string) => ({ messages: messagesByThread.get(threadId) ?? [], hasMore: false })),
    };
    const service = new ThreadControlService(
      workspaces as never,
      worktrees as never,
      git as never,
      threads as never,
      threadService as never,
      agentService as never,
      { get: () => ({ model: { defaults: { provider: "codex", id: "gpt-default" } }, agent: { defaults: { permission: "full" } } }) } as never,
      { resolve: vi.fn(() => ({ id: "codex" })) } as never,
      { listModels: vi.fn().mockResolvedValue([{ id: "gpt-default" }]) } as never,
      approvals as never,
      { write: vi.fn() } as never,
      messages as never,
      new ThreadControlMutationReservationService(),
    );

    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "workflow-session",
      sourceThreadId: sourceThread.id,
      sourceTurnId: "source-turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });
    const session = createInternalThreadControlMcpSession({ authority, service });
    const call = (requestId: string, toolName: string, args: unknown) => session.dispatch({
      bearerCredential: lease.credential,
      requestId,
      toolName,
      arguments: args,
    });

    await expect(call("search-projects", "workspace_search", { query: "Project" })).resolves.toMatchObject({
      workspaces: [{ workspaceId: sourceWorkspace.id }, { workspaceId: destinationWorkspace.id }],
    });
    await expect(call("list-destination-worktrees", "worktree_list", { workspaceId: destinationWorkspace.id })).resolves.toMatchObject({
      status: "found",
      worktrees: [{ worktreeId: "worktree-main" }],
    });
    const batch = await call("create-batch", "thread_create_batch", {
      items: [
        {
          workspaceId: destinationWorkspace.id,
          title: "Issue 965 child",
          prompt: "Implement the workflow proof.",
          placement: { type: "new_worktree", baseRef: "main", branchName: "feature/workflow-proof" },
        },
        {
          workspaceId: "unknown-workspace",
          title: "Rejected child",
          prompt: "Must not persist.",
          placement: { type: "direct" },
        },
      ],
    });
    expect(batch.results).toMatchObject([
      { index: 0, status: "created", workspaceId: destinationWorkspace.id, placement: { type: "new_worktree", worktreeId: "worktree-created" } },
      { index: 1, status: "rejected", error: { code: "not_found" } },
    ]);
    const destinationThreadId = (batch.results[0] as { threadId: string }).threadId;

    await expect(call("search-created", "thread_search", { workspaceIds: [destinationWorkspace.id] })).resolves.toMatchObject({
      threads: [{ threadId: destinationThreadId, workspaceId: destinationWorkspace.id }],
    });
    await expect(call("read-created", "thread_get", { threadId: destinationThreadId })).resolves.toMatchObject({
      status: "found",
      workspaceId: destinationWorkspace.id,
      messages: [{ content: "Implement the workflow proof." }],
    });
    await expect(call("follow-up", "thread_send", { threadId: destinationThreadId, message: "Continue with the regression." })).resolves.toMatchObject({
      status: "accepted",
      threadId: destinationThreadId,
    });
    await expect(call("wait-for-attention", "thread_wait", { threadIds: [destinationThreadId], timeoutSeconds: 1 })).resolves.toMatchObject({
      status: "success",
      timedOut: false,
      results: [{ threadId: destinationThreadId, state: { status: "waiting_for_user" } }],
    });
    await expect(call("stop-created", "thread_stop", { threadId: destinationThreadId })).resolves.toMatchObject({
      status: "accepted",
      threadId: destinationThreadId,
      state: { status: "stopped" },
    });
    await expect(call("read-after-stop", "thread_get", { threadId: destinationThreadId })).resolves.toMatchObject({
      status: "found",
      thread: { state: { status: "stopped" } },
      messages: [
        { content: "Implement the workflow proof." },
        { content: "Continue with the regression.", origin: { type: "thread", sourceThreadId: sourceThread.id } },
      ],
    });
    expect(threads.create).toHaveBeenCalledTimes(1);
    expect(threadService.provisionWorktree).toHaveBeenCalledWith(destinationThreadId, destinationWorkspace.id, {
      type: "new_worktree",
      baseRef: "main",
      branchName: "feature/workflow-proof",
    });
    expect(agentService.stopSession).toHaveBeenCalledWith(destinationThreadId);
  });
});
