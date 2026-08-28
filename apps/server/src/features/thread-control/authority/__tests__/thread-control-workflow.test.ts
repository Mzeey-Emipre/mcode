import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadCreateBatchResultSchema } from "@mcode/contracts";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import { ThreadControlApprovalRepo } from "../persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../persistence/thread-control-audit-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { InternalThreadControlMcpAuthority } from "../thread-control-mcp-authority.js";
import { createInternalThreadControlMcpSession } from "../thread-control-mcp-transport.js";
import { ThreadControlMutationReservationService } from "../thread-control-mutation-reservation-service.js";
import { ThreadControlService } from "../thread-control-service.js";
import type { GitRepositoryService, GitWorktreeService } from "../../../projects/index.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

describe("internal thread-control MCP workflow", () => {
  let db: ReturnType<typeof openMemoryDatabase> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("persists a cross-Project worktree workflow and keeps the child usable after partial failure", async () => {
    db = openMemoryDatabase();
    const workspaces = new WorkspaceRepo(db);
    const threads = new ThreadRepo(db);
    const messages = new MessageRepo(db);
    const approvals = new ThreadControlApprovalRepo(db);
    const audit = new ThreadControlAuditRepo(db);
    const sourceWorkspace = workspaces.create("Coordinator Project", "C:/private/coordinator");
    const destinationWorkspace = workspaces.create("Child Project", "C:/private/child");
    const sourceThread = threads.create(sourceWorkspace.id, "Coordinator", "direct", "main", true, "codex");
    threads.updateModel(sourceThread.id, "gpt-default");
    threads.updateSettings(sourceThread.id, { permission_mode: "full", interaction_mode: "build" });
    const sequenceByThread = new Map<string, number>();

    const worktrees = {
      reconcile: vi.fn().mockReturnValue([{ worktreeId: "worktree-main", label: "main", branch: "main" }]),
      findCurrentById: vi.fn(),
      register: vi.fn().mockReturnValue({ worktreeId: "worktree-created", label: "feature/workflow-proof" }),
    };
    const gitWorktrees = {
      listWorktrees: vi.fn().mockResolvedValue([{ path: "C:/private/child", name: "main", branch: "main", managed: false }]),
    } as unknown as GitWorktreeService;
    const gitRepository = {
      getCurrentBranch: vi.fn().mockResolvedValue("main"),
    } as unknown as GitRepositoryService;
    const projectWorktreeService = {
      provisionWorktree: vi.fn().mockImplementation(async (threadId: string) => ({
        ...threads.findById(threadId),
        mode: "worktree",
        worktree_path: "C:/private/child/.worktrees/feature-workflow-proof",
      })),
      cleanupInterruptedProvisioning: vi.fn().mockResolvedValue(true),
    };
    const activeThreadIds = vi.fn().mockReturnValue([]);
    const agentService = {
      runtimeAccess: () => ({ activeThreadIds }),
      sendMessage: vi.fn().mockImplementation(async (input: {
        threadId: string;
        content: string;
        sourceThreadId?: string;
        originSourceTurnId?: string;
        sourceProviderId?: string;
      }) => {
        const sequence = (sequenceByThread.get(input.threadId) ?? 0) + 1;
        sequenceByThread.set(input.threadId, sequence);
        messages.create(
          input.threadId,
          "user",
          input.content,
          sequence,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          input.sourceThreadId && input.originSourceTurnId && input.sourceProviderId
            ? {
                type: "thread",
                sourceThreadId: input.sourceThreadId,
                sourceTurnId: input.originSourceTurnId,
                sourceProviderId: input.sourceProviderId,
              }
            : { type: "composer" },
        );
        threads.updateStatus(input.threadId, "paused");
      }),
      stopSession: vi.fn().mockResolvedValue(undefined),
    };
    const settings = {
      get: () => ({
        model: { defaults: { provider: "codex", id: "gpt-default" } },
        agent: { defaults: { permission: "full" } },
      }),
    };
    const providers = { resolve: vi.fn(() => ({ id: "codex" })) };
    const models = { listModels: vi.fn().mockResolvedValue([{ id: "gpt-default" }]) };
    const service = new ThreadControlService(
      workspaces,
      worktrees as never,
      gitWorktrees,
      gitRepository,
      threads,
      projectWorktreeService as never,
      agentService as never,
      settings as never,
      providers as never,
      models as never,
      approvals,
      audit,
      messages,
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

    const projectSearch = await call("search-projects", "workspace_search", { query: "Project" }) as { workspaces: Array<{ workspaceId: string }> };
    expect(projectSearch.workspaces.map((workspace) => workspace.workspaceId)).toEqual(
      expect.arrayContaining([sourceWorkspace.id, destinationWorkspace.id]),
    );
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
    const batchResult = ThreadCreateBatchResultSchema().parse(batch);
    expect(batchResult.results).toMatchObject([
      { index: 0, status: "created", workspaceId: destinationWorkspace.id, placement: { type: "new_worktree", worktreeId: "worktree-created" } },
      { index: 1, status: "rejected", error: { code: "not_found" } },
    ]);
    const destinationResult = batchResult.results.find((result) => result.index === 0);
    if (!destinationResult || destinationResult.status !== "created") {
      throw new Error("Expected first batch result to be created");
    }
    const destinationThreadId = destinationResult.threadId;
    expect(threads.findById(destinationThreadId)).toMatchObject({ workspace_id: destinationWorkspace.id, title: "Issue 965 child" });
    expect(threads.findDelegationLineage(destinationThreadId)).toEqual({
      coordinatorThreadId: sourceThread.id,
      creatorTurnId: "source-turn",
      creatorToolCallId: "create-batch",
      creationKind: "thread_delegation",
    });

    await expect(call("search-created", "thread_search", { workspaceIds: [destinationWorkspace.id] })).resolves.toMatchObject({
      threads: [{ threadId: destinationThreadId, workspaceId: destinationWorkspace.id }],
    });
    await expect(call("read-created", "thread_get", { threadId: destinationThreadId })).resolves.toMatchObject({
      status: "found",
      workspaceId: destinationWorkspace.id,
      messages: [{ content: "Implement the workflow proof.", origin: { type: "composer" } }],
    });
    await expect(call("follow-up", "thread_send", { threadId: destinationThreadId, message: "Continue with the regression." })).resolves.toMatchObject({
      status: "accepted",
      threadId: destinationThreadId,
    });
    const waitAbort = new AbortController();
    waitAbort.abort();
    await expect(session.dispatch({
      bearerCredential: lease.credential,
      requestId: "wait-for-attention",
      toolName: "thread_wait",
      arguments: { threadIds: [destinationThreadId], timeoutSeconds: 1 },
      signal: waitAbort.signal,
    })).resolves.toMatchObject({
      status: "success",
      timedOut: true,
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
        { content: "Continue with the regression.", origin: { type: "thread", sourceThreadId: sourceThread.id, sourceProviderId: "codex" } },
      ],
    });

    const restartedThreads = new ThreadRepo(db);
    const restartedMessages = new MessageRepo(db);
    expect(restartedThreads.findDelegationLineage(destinationThreadId)).toEqual({
      coordinatorThreadId: sourceThread.id,
      creatorTurnId: "source-turn",
      creatorToolCallId: "create-batch",
      creationKind: "thread_delegation",
    });
    expect(restartedMessages.listByThreadForThreadControl(destinationThreadId, 10, 100_000).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Continue with the regression.", sourceThreadId: sourceThread.id, sourceProviderId: "codex" }),
      ]),
    );
    expect(threads.listDelegationChildren(sourceThread.id).map(({ thread }) => thread.id)).toContain(destinationThreadId);
    expect(agentService.stopSession).toHaveBeenCalledWith(destinationThreadId);
  });
});
