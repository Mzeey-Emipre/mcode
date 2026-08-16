import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_GET_TRANSCRIPT_MAX_BYTES } from "@mcode/contracts";

const { mockBroadcast } = vi.hoisted(() => ({ mockBroadcast: vi.fn() }));

vi.mock("../../../../transport/push.js", () => ({ broadcast: mockBroadcast }));

import { ThreadControlService, type InternalThreadControlAuthority } from "../thread-control-service.js";
import { ThreadControlMutationReservationService } from "../../../../services/thread-control-mutation-reservation-service.js";

const authority: InternalThreadControlAuthority = {
  type: "internal",
  userId: "local-user",
  sourceThreadId: "thread-1",
  sourceTurnId: "turn-1",
  sourceToolCallId: "call-1",
  sourceProviderId: "claude",
  permissionMode: "supervised",
};

describe("ThreadControlService", () => {
  const workspace = {
    id: "workspace-1",
    name: "Workspace",
    path: "C:/private/workspace",
    is_git_repo: true,
  };
  const createdThread = {
    id: "thread-created",
    workspace_id: workspace.id,
    status: "active",
    mode: "direct",
    branch: "main",
    permission_mode: null,
    interaction_mode: null,
    model: null,
    provider: "claude",
  };
  let workspaces: {
    search: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByIdIncludeDeleted: ReturnType<typeof vi.fn>;
  };
  let worktrees: {
    reconcile: ReturnType<typeof vi.fn>;
    findCurrentById: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
  };
  let git: { listWorktrees: ReturnType<typeof vi.fn>; getCurrentBranch: ReturnType<typeof vi.fn> };
  let threads: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    updateModel: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
    updateDelegationLineage: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    updateWorktreePath: ReturnType<typeof vi.fn>;
    clearWorktreePath: ReturnType<typeof vi.fn>;
    updateExternalCreator: ReturnType<typeof vi.fn>;
    countActiveByIntegration: ReturnType<typeof vi.fn>;
    findDelegationLineage: ReturnType<typeof vi.fn>;
    listDelegationChildren: ReturnType<typeof vi.fn>;
  };
  let projectWorktreeService: { provisionWorktree: ReturnType<typeof vi.fn>; cleanupInterruptedProvisioning: ReturnType<typeof vi.fn> };
  let agentService: { sendMessage: ReturnType<typeof vi.fn>; stopSession: ReturnType<typeof vi.fn>; activeThreadIds?: ReturnType<typeof vi.fn> };
  let approvals: {
    create: ReturnType<typeof vi.fn>;
    createSend: ReturnType<typeof vi.fn>;
    createStop: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
    setOperationPhase: ReturnType<typeof vi.fn>;
    listPending: ReturnType<typeof vi.fn>;
    listProcessing: ReturnType<typeof vi.fn>;
    requeue: ReturnType<typeof vi.fn>;
    requeueDispatch: ReturnType<typeof vi.fn>;
    requeueRecoveredProvisioning: ReturnType<typeof vi.fn>;
    listPendingByThread: ReturnType<typeof vi.fn>;
  };
  let mutationReservations: ThreadControlMutationReservationService;
  let audit: { write: ReturnType<typeof vi.fn> };
  let messages: { listByThreadForThreadControl: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    workspaces = {
      search: vi.fn().mockReturnValue([workspace]),
      findById: vi.fn().mockReturnValue(workspace),
      findByIdIncludeDeleted: vi.fn().mockReturnValue(workspace),
    };
    worktrees = {
      reconcile: vi.fn().mockReturnValue([]),
      findCurrentById: vi.fn(),
      register: vi.fn().mockReturnValue({ worktreeId: "worktree-created", label: "created" }),
    };
    git = {
      listWorktrees: vi.fn().mockResolvedValue([]),
      getCurrentBranch: vi.fn().mockResolvedValue("main"),
    };
    threads = {
      create: vi.fn().mockReturnValue(createdThread),
      findById: vi.fn().mockReturnValue(null),
      search: vi.fn().mockReturnValue({ threads: [], workspaces: [] }),
      updateModel: vi.fn().mockReturnValue(true),
      updateSettings: vi.fn().mockReturnValue(true),
      updateDelegationLineage: vi.fn().mockReturnValue(true),
      updateStatus: vi.fn().mockReturnValue(true),
      updateWorktreePath: vi.fn().mockReturnValue(true),
      clearWorktreePath: vi.fn().mockReturnValue(true),
      updateExternalCreator: vi.fn().mockReturnValue(true),
      countActiveByIntegration: vi.fn().mockReturnValue(0),
      findDelegationLineage: vi.fn().mockReturnValue(null),
      listDelegationChildren: vi.fn().mockReturnValue([]),
    };
    messages = {
      listByThreadForThreadControl: vi.fn().mockReturnValue({ messages: [], hasMore: false }),
    };
    projectWorktreeService = {
      provisionWorktree: vi.fn().mockResolvedValue({
        ...createdThread,
        mode: "worktree",
        worktree_path: "C:/private/workspace/.worktrees/created",
      }),
      cleanupInterruptedProvisioning: vi.fn().mockResolvedValue(true),
    };
    agentService = { sendMessage: vi.fn().mockResolvedValue(undefined), stopSession: vi.fn().mockResolvedValue(undefined) };
    approvals = {
      create: vi.fn().mockReturnValue("approval-1"),
      createSend: vi.fn().mockReturnValue("approval-send"),
      createStop: vi.fn().mockReturnValue("approval-stop"),
      claim: vi.fn(),
      settle: vi.fn().mockReturnValue(true),
      setOperationPhase: vi.fn().mockReturnValue(true),
      listPending: vi.fn().mockReturnValue([]),
      listProcessing: vi.fn().mockReturnValue([]),
      requeue: vi.fn().mockReturnValue(true),
      requeueDispatch: vi.fn().mockReturnValue(true),
      requeueRecoveredProvisioning: vi.fn().mockReturnValue(true),
      listPendingByThread: vi.fn().mockReturnValue([]),
    };
    mutationReservations = new ThreadControlMutationReservationService();
    audit = { write: vi.fn() };
  });

  function createService(defaultPermission: "full" | "supervised" = "full") {
    return new ThreadControlService(
      workspaces as never,
      worktrees as never,
      git as never,
      threads as never,
      projectWorktreeService as never,
      agentService as never,
      {
        get: () => ({
          model: { defaults: { provider: "codex", id: "gpt-default" } },
          agent: { defaults: { permission: defaultPermission } },
        }),
      } as never,
      {
        resolve: (providerId: string) => {
          if (providerId !== "codex" && providerId !== "claude") throw new Error("unknown");
          return { id: providerId };
        },
      } as never,
      {
        listModels: vi.fn().mockImplementation((providerId: string) => Promise.resolve(
          providerId === "codex"
            ? [{ id: "gpt-default" }, { id: "gpt-exact" }]
            : [{ id: "claude-exact" }],
        )),
      } as never,
      approvals as never,
      audit as never,
      messages as never,
      mutationReservations,
    );
  }

  it("never returns a registered workspace filesystem path from workspace_search", () => {
    const workspacePath = "C:/private/workspace";
    const service = new ThreadControlService(
      { search: () => [{ id: "workspace-1", name: "Workspace", path: workspacePath, last_opened_at: null }] } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = service.workspaceSearch(authority, { limit: 20 });

    expect(JSON.stringify(result)).not.toContain(workspacePath);
    expect(result.workspaces).toEqual([{ workspaceId: "workspace-1", name: "Workspace" }]);
  });

  it("reads a canonical Project/Thread coordination projection with persisted identity", () => {
    const service = createService();
    const thread = {
      ...createdThread,
      id: "thread-1",
      title: "Coordinator",
      workspace_id: workspace.id,
      provider: "codex",
      model: "gpt-5.6-sol",
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
      deleted_at: null,
    };
    threads.findById.mockReturnValue(thread);

    expect(service.threadControlRead({
      identity: { workspaceId: workspace.id, threadId: thread.id },
      messageLimit: 10,
    })).toMatchObject({
      status: "found",
      projection: {
        identity: { workspaceId: workspace.id, threadId: thread.id },
        thread: { title: "Coordinator", providerId: "codex" },
        relation: null,
        children: [],
        approvals: [],
      },
    });
    expect(messages.listByThreadForThreadControl).toHaveBeenCalledWith(thread.id, 10, THREAD_GET_TRANSCRIPT_MAX_BYTES);
  });

  it("returns historical source Project and Thread provenance when relation is absent", () => {
    const service = createService();
    const destination = {
      ...createdThread,
      id: "destination-thread",
      title: "Destination",
      workspace_id: workspace.id,
      provider: "codex",
      model: "gpt-5.6-sol",
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
      deleted_at: null,
    };
    const sourceWorkspace = { ...workspace, id: "source-workspace", name: "Source Project" };
    const source = {
      ...destination,
      id: "source-thread",
      title: "Source Thread",
      workspace_id: sourceWorkspace.id,
      provider: "claude",
      model: "claude-sonnet",
    };
    workspaces.findById.mockImplementation((id: string) => id === sourceWorkspace.id ? sourceWorkspace : workspace);
    workspaces.findByIdIncludeDeleted.mockImplementation((id: string) => id === sourceWorkspace.id ? sourceWorkspace : workspace);
    threads.findById.mockImplementation((id: string) => id === source.id ? source : id === destination.id ? destination : null);
    messages.listByThreadForThreadControl.mockReturnValue({
      messages: [{
        id: "message-1",
        role: "user",
        content: "Historical delegation",
        timestamp: "2026-07-29T00:00:00.000Z",
        provider: null,
        model: null,
        originType: "thread",
        sourceThreadId: source.id,
        sourceTurnId: "turn-1",
        sourceProviderId: source.provider,
      }],
      hasMore: false,
    });

    const result = service.threadControlRead({
      identity: { workspaceId: workspace.id, threadId: destination.id },
      messageLimit: 10,
    });

    expect(result).toMatchObject({
      status: "found",
      projection: {
        relation: null,
        messages: [{
          origin: {
            type: "thread",
            sourceWorkspaceId: sourceWorkspace.id,
            sourceWorkspaceName: sourceWorkspace.name,
            sourceUnavailable: false,
            sourceThread: { threadId: source.id, title: source.title, workspaceId: sourceWorkspace.id },
          },
        }],
      },
    });
  });

  it("keeps historical thread origin after source thread and Project soft-delete", () => {
    const service = createService();
    const destination = {
      ...createdThread,
      id: "destination-thread",
      title: "Destination",
      workspace_id: workspace.id,
      provider: "codex",
      model: "gpt-5.6-sol",
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
      deleted_at: null,
    };
    const deletedWorkspace = {
      ...workspace,
      id: "source-workspace",
      name: "Deleted Project",
      deleted_at: "2026-07-29T00:01:00.000Z",
    };
    const deletedSource = {
      ...destination,
      id: "source-thread",
      title: "Deleted Source",
      workspace_id: deletedWorkspace.id,
      provider: "claude",
      model: "claude-sonnet",
      deleted_at: "2026-07-29T00:01:00.000Z",
    };
    workspaces.findById.mockImplementation((id: string) => id === workspace.id ? workspace : null);
    workspaces.findByIdIncludeDeleted.mockImplementation((id: string) => id === deletedWorkspace.id ? deletedWorkspace : null);
    threads.findById.mockImplementation((id: string) => id === deletedSource.id ? deletedSource : id === destination.id ? destination : null);
    messages.listByThreadForThreadControl.mockReturnValue({
      messages: [{
        id: "message-deleted-source",
        role: "user",
        content: "Historical delegation",
        timestamp: "2026-07-29T00:00:00.000Z",
        provider: null,
        model: null,
        originType: "thread",
        sourceThreadId: deletedSource.id,
        sourceTurnId: "turn-1",
        sourceProviderId: deletedSource.provider,
      }],
      hasMore: false,
    });

    const result = service.threadControlRead({
      identity: { workspaceId: workspace.id, threadId: destination.id },
      messageLimit: 10,
    });

    expect(result).toMatchObject({
      status: "found",
      projection: {
        relation: null,
        messages: [{
          origin: {
            type: "thread",
            sourceThreadId: deletedSource.id,
            sourceTurnId: "turn-1",
            sourceProviderId: deletedSource.provider,
            sourceWorkspaceId: deletedWorkspace.id,
            sourceWorkspaceName: deletedWorkspace.name,
            sourceUnavailable: true,
            sourceThread: {
              threadId: deletedSource.id,
              workspaceId: deletedWorkspace.id,
              title: deletedSource.title,
            },
          },
        }],
      },
    });
  });

  it("rejects a user mutation when the explicit target Project does not match the persisted thread", async () => {
    const service = createService();
    const source = { ...createdThread, id: "source-thread", workspace_id: workspace.id, deleted_at: null };
    const target = { ...createdThread, id: "target-thread", workspace_id: workspace.id, deleted_at: null };
    threads.findById.mockImplementation((id: string) => id === source.id ? source : id === target.id ? target : null);

    await expect(service.threadControlSend({
      source: { workspaceId: workspace.id, threadId: source.id },
      target: { workspaceId: "other-workspace", threadId: target.id },
      message: "Follow up",
    })).resolves.toMatchObject({ status: "rejected", error: { code: "not_found" } });
    expect(agentService.sendMessage).not.toHaveBeenCalled();
  });

  it("creates a direct thread with user defaults, exact title, lineage, and Build mode", async () => {
    const service = createService();

    const result = await service.threadCreateBatch(authority, {
      items: [{
        workspaceId: workspace.id,
        title: "Exact delegated title",
        prompt: "Implement the task.",
        placement: { type: "direct" },
      }],
    });

    expect(result.results).toEqual([expect.objectContaining({
      index: 0,
      status: "created",
      workspaceId: workspace.id,
      threadId: createdThread.id,
      execution: {
        providerId: "codex",
        modelId: "gpt-default",
        permissionMode: "full",
        interactionMode: "build",
      },
      placement: { type: "direct" },
      state: { status: "starting" },
    })]);
    expect(threads.create).toHaveBeenCalledWith(
      workspace.id,
      "Exact delegated title",
      "direct",
      "main",
      true,
      "codex",
      undefined,
      "named",
      null,
    );
    expect(threads.updateDelegationLineage).toHaveBeenCalledWith(createdThread.id, {
      coordinatorThreadId: authority.sourceThreadId,
      creatorTurnId: authority.sourceTurnId,
      creatorToolCallId: authority.sourceToolCallId,
      creationKind: "thread_delegation",
    });
    expect(agentService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: createdThread.id,
      content: "Implement the task.",
      provider: "codex",
      model: "gpt-default",
      permissionMode: "full",
      interactionMode: "build",
      sourceTurnId: expect.any(String),
    }));
  });

  it("defaults an internal item without a Project to its source thread Project", async () => {
    const service = createService();
    threads.findById.mockImplementation((id: string) => id === authority.sourceThreadId
      ? { ...createdThread, id: authority.sourceThreadId, deleted_at: null }
      : null);

    const result = await service.threadCreateBatch(authority, {
      items: [{
        title: "Inherited Project",
        prompt: "Create in source Project.",
        placement: { type: "direct" },
      }],
    });

    expect(result.results[0]).toMatchObject({ status: "created", workspaceId: workspace.id });
    expect(threads.create).toHaveBeenCalledWith(workspace.id, expect.any(String), "direct", "main", true, "codex", undefined, "named", null);
  });

  it("rejects an external item without a Project without looking up or creating", async () => {
    const service = createService();
    const externalAuthority = {
      type: "external" as const,
      integrationId: "integration-1",
      allowedWorkspaceIds: [workspace.id],
      scopes: ["threads:create"] as const,
      limits: { callsPerMinute: 10, maxActiveThreads: 1 },
    };

    const result = await service.threadCreateBatch(externalAuthority, {
      items: [{
        title: "Missing Project",
        prompt: "Reject this.",
        placement: { type: "direct" },
      }],
    });

    expect(result.results).toEqual([{
      index: 0,
      status: "rejected",
      error: { code: "not_found", message: "Workspace not found", retryable: false },
    }]);
    expect(workspaces.findById).not.toHaveBeenCalled();
    expect(threads.create).not.toHaveBeenCalled();
  });

  it("fails closed when an internal source thread is unavailable", async () => {
    const service = createService();

    const result = await service.threadCreateBatch(authority, {
      items: [{
        title: "Unavailable source",
        prompt: "Reject this.",
        placement: { type: "direct" },
      }],
    });

    expect(result.results).toEqual([{
      index: 0,
      status: "rejected",
      error: { code: "not_found", message: "Source thread not found", retryable: false },
    }]);
    expect(workspaces.findById).not.toHaveBeenCalled();
    expect(threads.create).not.toHaveBeenCalled();
  });

  it("returns a created result when audit storage fails", async () => {
    const service = createService();
    audit.write.mockImplementationOnce(() => { throw new Error("audit unavailable"); });

    await expect(service.threadCreateBatch(authority, {
      items: [{
        workspaceId: workspace.id,
        title: "Audit failure",
        prompt: "Create once.",
        placement: { type: "direct" },
      }],
    })).resolves.toMatchObject({
      results: [{ status: "created", threadId: createdThread.id }],
    });

    expect(threads.create).toHaveBeenCalledTimes(1);
    expect(agentService.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("honors exact provider and model overrides or rejects them without persistence", async () => {
    const service = createService();

    const result = await service.threadCreateBatch(authority, {
      items: [
        {
          workspaceId: workspace.id,
          title: "Exact overrides",
          prompt: "Use Claude.",
          placement: { type: "direct" },
          providerId: "claude",
          modelId: "claude-exact",
          permissionMode: "supervised",
          interactionMode: "plan",
        },
        {
          workspaceId: workspace.id,
          title: "Invalid model",
          prompt: "Reject this.",
          placement: { type: "direct" },
          providerId: "codex",
          modelId: "missing-model",
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      index: 0,
      status: "created",
      execution: {
        providerId: "claude",
        modelId: "claude-exact",
        permissionMode: "supervised",
        interactionMode: "plan",
      },
    });
    expect(result.results[1]).toEqual({
      index: 1,
      status: "rejected",
      workspaceId: workspace.id,
      error: {
        code: "invalid_model",
        message: "Model is not available for the selected provider",
        retryable: false,
      },
    });
    expect(threads.create).toHaveBeenCalledTimes(1);
  });

  it("preserves partial success and input order", async () => {
    const service = createService();
    workspaces.findById.mockImplementation((workspaceId: string) =>
      workspaceId === workspace.id ? workspace : null,
    );

    const result = await service.threadCreateBatch(authority, {
      items: [
        {
          workspaceId: "missing-workspace",
          title: "Missing",
          prompt: "Reject this.",
          placement: { type: "direct" },
        },
        {
          workspaceId: workspace.id,
          title: "Created",
          prompt: "Create this.",
          placement: { type: "direct" },
        },
      ],
    });

    expect(result.results.map((item) => [item.index, item.status])).toEqual([
      [0, "rejected"],
      [1, "created"],
    ]);
  });

  it("validates existing-worktree ownership without returning its path", async () => {
    const service = createService();
    worktrees.findCurrentById.mockReturnValue(null);

    const result = await service.threadCreateBatch(authority, {
      items: [{
        workspaceId: workspace.id,
        title: "Wrong worktree",
        prompt: "Do not create this.",
        placement: { type: "existing_worktree", worktreeId: "other-worktree" },
      }],
    });

    expect(result.results).toEqual([{
      index: 0,
      status: "rejected",
      workspaceId: workspace.id,
      error: {
        code: "invalid_placement",
        message: "Worktree does not belong to the selected workspace",
        retryable: false,
      },
    }]);
    expect(JSON.stringify(result)).not.toContain("C:/");
  });

  it("persists a visible pending thread before supervised new-worktree approval", async () => {
    const service = createService();
    const supervisedAuthority = { ...authority, permissionMode: "supervised" as const };

    const result = await service.threadCreateBatch(supervisedAuthority, {
      items: [{
        workspaceId: workspace.id,
        title: "Pending worktree",
        prompt: "Wait for approval.",
        placement: { type: "new_worktree", baseRef: "main" },
      }],
    });

    expect(result.results).toEqual([{
      index: 0,
      status: "pending_approval",
      workspaceId: workspace.id,
      threadId: createdThread.id,
      approvalId: "approval-1",
      execution: {
        providerId: "codex",
        modelId: "gpt-default",
        permissionMode: "full",
        interactionMode: "build",
      },
      requestedPlacement: { type: "new_worktree", baseRef: "main" },
      state: { status: "waiting_for_approval", approvalId: "approval-1" },
    }]);
    expect(threads.create).toHaveBeenCalled();
    expect(approvals.create).toHaveBeenCalled();
    expect(projectWorktreeService.provisionWorktree).not.toHaveBeenCalled();
    expect(agentService.sendMessage).not.toHaveBeenCalled();
  });

  it("provisions a full-access new worktree and returns only its opaque identity", async () => {
    const service = createService();
    const fullAuthority = { ...authority, permissionMode: "full" as const };

    const result = await service.threadCreateBatch(fullAuthority, {
      items: [{
        workspaceId: workspace.id,
        title: "Provision worktree",
        prompt: "Start after provisioning.",
        placement: {
          type: "new_worktree",
          baseRef: "main",
          branchName: "codex/issue-960",
        },
      }],
    });

    expect(result.results[0]).toMatchObject({
      status: "created",
      placement: {
        type: "new_worktree",
        baseRef: "main",
        branchName: "codex/issue-960",
        worktreeId: "worktree-created",
      },
    });
    expect(JSON.stringify(result)).not.toContain("C:/private");
    expect(projectWorktreeService.provisionWorktree).toHaveBeenCalledWith(
      createdThread.id,
      workspace.id,
      {
        type: "new_worktree",
        baseRef: "main",
        branchName: "codex/issue-960",
      },
    );
  });

  it("keeps new worktree branchless when branchName is omitted", async () => {
    const service = createService();
    const fullAuthority = { ...authority, permissionMode: "full" as const };

    const result = await service.threadCreateBatch(fullAuthority, {
      items: [{
        workspaceId: workspace.id,
        title: "Branchless worktree",
        prompt: "Start branchless.",
        placement: { type: "new_worktree", baseRef: "main" },
      }],
    });

    expect(result.results[0]).toMatchObject({
      status: "created",
      placement: { type: "new_worktree", baseRef: "main", worktreeId: "worktree-created" },
    });
    expect(result.results[0]).not.toHaveProperty("placement.branchName");
    expect(projectWorktreeService.provisionWorktree).toHaveBeenCalledWith(createdThread.id, workspace.id, {
      type: "new_worktree",
      baseRef: "main",
    });
  });

  it("resumes the same pending operation exactly once after human approval", async () => {
    const service = createService();
    approvals.claim.mockReturnValue({
      operation: "thread_create_batch",
      approvalId: "approval-1",
      threadId: createdThread.id,
      workspaceId: workspace.id,
      prompt: "Resume this prompt.",
      execution: {
        providerId: "codex",
        modelId: "gpt-default",
        permissionMode: "full",
        interactionMode: "build",
      },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-approval-1",
      operationPhase: "pre_provision",
      callerId: "local-user",
      sourceThreadId: "thread-1",
    });

    await expect(service.respondToApproval("approval-1", "allow")).resolves.toBe(true);

    expect(projectWorktreeService.provisionWorktree).toHaveBeenCalledTimes(1);
    expect(agentService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: createdThread.id,
      content: "Resume this prompt.",
    }));
    expect(approvals.settle).toHaveBeenCalledWith("approval-1", "approved");
    expect(mockBroadcast).toHaveBeenCalledWith("thread.status", {
      threadId: createdThread.id,
      status: "active",
    });

    approvals.claim.mockReturnValue(null);
    await expect(service.respondToApproval("approval-1", "allow")).resolves.toBe(false);
    expect(projectWorktreeService.provisionWorktree).toHaveBeenCalledTimes(1);
  });

  it("keeps an approved thread active when its post-settlement audit write fails", async () => {
    const service = createService();
    approvals.claim.mockReturnValue({
      operation: "thread_create_batch",
      approvalId: "approval-audit-failure",
      threadId: createdThread.id,
      workspaceId: workspace.id,
      prompt: "Resume once.",
      execution: { providerId: "codex", modelId: "gpt-default", permissionMode: "full", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: "turn-audit-failure",
      operationPhase: "pre_provision",
      callerId: "local-user",
    });
    audit.write.mockImplementationOnce(() => { throw new Error("audit unavailable"); });

    await expect(service.respondToApproval("approval-audit-failure", "allow")).resolves.toBe(true);

    expect(approvals.settle).toHaveBeenCalledWith("approval-audit-failure", "approved");
    expect(threads.updateStatus).not.toHaveBeenCalledWith(createdThread.id, "errored");
    expect(mockBroadcast).toHaveBeenCalledWith("thread.status", {
      threadId: createdThread.id,
      status: "active",
    });
  });

  it.each(["deny", "failure"])("does not throw when %s auditing fails", async (outcome) => {
    const service = createService();
    approvals.claim.mockReturnValue({
      operation: "thread_create_batch",
      approvalId: `approval-${outcome}`,
      threadId: createdThread.id,
      workspaceId: workspace.id,
      prompt: "Resume once.",
      execution: { providerId: "codex", modelId: "gpt-default", permissionMode: "full", interactionMode: "build" },
      placement: { type: "new_worktree", baseRef: "main" },
      turnId: `turn-${outcome}`,
      operationPhase: "pre_provision",
      callerId: "local-user",
    });
    audit.write.mockImplementationOnce(() => { throw new Error("audit unavailable"); });
    if (outcome === "failure") agentService.sendMessage.mockRejectedValueOnce(new Error("dispatch failed"));

    await expect(service.respondToApproval(`approval-${outcome}`, outcome === "deny" ? "deny" : "allow")).resolves.toBe(true);
  });

  it("requeues a recovered provisioning approval only after cleanup clears its persisted checkout", async () => {
    const service = createService();
    approvals.listProcessing.mockReturnValue([
      { operation: "thread_create_batch", approvalId: "safe", threadId: "thread-safe", operationPhase: "pre_provision" },
      {
        operation: "thread_create_batch",
        approvalId: "provisioning",
        threadId: "thread-provisioning",
        workspaceId: workspace.id,
        placement: { type: "new_worktree", baseRef: "main" },
        callerId: "local-user",
        sourceThreadId: "thread-1",
        operationPhase: "provisioning",
      },
    ]);

    await service.recoverApprovals();

    expect(approvals.requeue).toHaveBeenCalledWith("safe");
    expect(projectWorktreeService.cleanupInterruptedProvisioning).toHaveBeenCalledWith(
      "thread-provisioning",
      workspace.id,
      { type: "new_worktree", baseRef: "main" },
    );
    expect(threads.clearWorktreePath).toHaveBeenCalledWith("thread-provisioning");
    expect(threads.updateStatus).toHaveBeenCalledWith("thread-provisioning", "paused");
    expect(approvals.requeueRecoveredProvisioning).toHaveBeenCalledWith("provisioning");
    expect(agentService.sendMessage).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "recovery-requeued" }));
  });

  it("fails a malformed recovery item and continues with the next valid approval", async () => {
    const service = createService();
    approvals.listProcessing.mockReturnValue([
      {
        invalid: true,
        operation: "thread_create_batch",
        approvalId: "malformed",
        threadId: "thread-malformed",
        workspaceId: workspace.id,
        callerId: "local-user",
      },
      {
        approvalId: "valid",
        threadId: "thread-valid",
        workspaceId: workspace.id,
        callerId: "local-user",
        operationPhase: "pre_provision",
      },
    ]);

    await expect(service.recoverApprovals()).resolves.toBeUndefined();

    expect(approvals.settle).toHaveBeenCalledWith("malformed", "failed");
    expect(threads.updateStatus).toHaveBeenCalledWith("thread-malformed", "errored");
    expect(approvals.requeue).toHaveBeenCalledWith("valid");
  });

  it("fails malformed pending recovery and rehydrates valid mutation reservations", async () => {
    const service = createService();
    approvals.listPending.mockReturnValue([
      {
        invalid: true,
        operation: "thread_create_batch",
        approvalId: "malformed-pending",
        threadId: "thread-malformed-pending",
        workspaceId: workspace.id,
        callerId: "local-user",
      },
      {
        operation: "thread_send",
        approvalId: "valid-pending",
        threadId: "thread-valid-pending",
        workspaceId: workspace.id,
        message: "Continue safely.",
        execution: { providerId: "codex", modelId: "gpt-default", permissionMode: "supervised", interactionMode: "build" },
        turnId: "turn-valid-pending",
        operationPhase: "pre_dispatch",
        callerId: "local-user",
      },
    ]);

    await expect(service.recoverApprovals()).resolves.toBeUndefined();

    expect(approvals.settle).toHaveBeenCalledWith("malformed-pending", "failed");
    expect(threads.updateStatus).toHaveBeenCalledWith("thread-malformed-pending", "errored");
    expect(mutationReservations.owns("thread-valid-pending", "valid-pending", "pendingApproval")).toBe(true);
  });

  it.each([
    ["thread_send", "malformed-send"],
    ["thread_stop", "malformed-stop"],
    [undefined, "malformed-unknown"],
  ])("settles malformed %s recovery without mutating target", async (operation, approvalId) => {
    const service = createService();
    mockBroadcast.mockClear();
    approvals.listPending.mockReturnValue([{
      invalid: true,
      ...(operation ? { operation } : {}),
      approvalId,
      threadId: `thread-${approvalId}`,
      workspaceId: workspace.id,
      callerId: "local-user",
    }]);

    await expect(service.recoverApprovals()).resolves.toBeUndefined();

    expect(approvals.settle).toHaveBeenCalledWith(approvalId, "failed");
    expect(threads.updateStatus).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({
      operation: operation ?? "unknown",
      outcome: "recovery-failed",
    }));
  });

  it("continues recovery when failure persistence or audit logging throws", async () => {
    const service = createService();
    approvals.settle.mockImplementationOnce(() => { throw new Error("database unavailable"); });
    audit.write.mockImplementationOnce(() => { throw new Error("audit unavailable"); });
    approvals.listProcessing.mockReturnValue([
      {
        invalid: true,
        operation: "thread_create_batch",
        approvalId: "broken",
        threadId: "thread-broken",
        workspaceId: workspace.id,
        callerId: "local-user",
      },
      {
        approvalId: "valid",
        threadId: "thread-valid",
        workspaceId: workspace.id,
        callerId: "local-user",
        operationPhase: "pre_provision",
      },
    ]);

    await expect(service.recoverApprovals()).resolves.toBeUndefined();

    expect(threads.updateStatus).toHaveBeenCalledWith("thread-broken", "errored");
    expect(approvals.requeue).toHaveBeenCalledWith("valid");
  });

  it.each([
    ["returns false", () => projectWorktreeService.cleanupInterruptedProvisioning.mockResolvedValue(false)],
    ["throws", () => projectWorktreeService.cleanupInterruptedProvisioning.mockRejectedValue(new Error("locked"))],
  ])("fails recovery when managed worktree cleanup %s", async (_case, arrange) => {
    const service = createService();
    arrange();
    approvals.listProcessing.mockReturnValue([{
      operation: "thread_create_batch",
      approvalId: "provisioning",
      threadId: "thread-provisioning",
      workspaceId: workspace.id,
      placement: { type: "new_worktree", baseRef: "main" },
      callerId: "local-user",
      sourceThreadId: "thread-1",
      operationPhase: "provisioning",
    }]);

    await service.recoverApprovals();

    expect(approvals.settle).toHaveBeenCalledWith("provisioning", "failed");
    expect(threads.updateStatus).toHaveBeenCalledWith("thread-provisioning", "errored");
    expect(threads.clearWorktreePath).not.toHaveBeenCalled();
    expect(approvals.requeueRecoveredProvisioning).not.toHaveBeenCalled();
    expect(agentService.sendMessage).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "recovery-failed" }));
  });

  it("enforces external owned-read ownership for search, get, and wait", async () => {
    const service = createService();
    const ownedThread = {
      ...createdThread,
      id: "owned-thread",
      title: "Owned",
      workspace_id: workspace.id,
      provider: "claude",
      model: "claude-model",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:02.000Z",
      deleted_at: null,
      created_by_integration_id: "integration-a",
    };
    const otherOwnedThread = { ...ownedThread, id: "other-owned", title: "Other", created_by_integration_id: "integration-b" };
    const unownedThread = { ...ownedThread, id: "unowned", title: "Unowned", created_by_integration_id: null };
    const externalAuthority = {
      type: "external" as const,
      integrationId: "integration-a",
      allowedWorkspaceIds: [workspace.id],
      scopes: ["threads:read-owned"] as const,
      limits: { callsPerMinute: 10, maxActiveThreads: 10 },
    };
    const byId = new Map<string, typeof ownedThread | typeof otherOwnedThread | typeof unownedThread>([
      [ownedThread.id, ownedThread],
      [otherOwnedThread.id, otherOwnedThread],
      [unownedThread.id, unownedThread],
    ]);
    threads.search.mockImplementation((options: { createdByIntegrationId?: string }) => ({
      threads: options.createdByIntegrationId === "integration-a" ? [ownedThread] : [...byId.values()],
      workspaces: [],
    }));
    threads.findById.mockImplementation((id: string, options?: { createdByIntegrationId?: string }) => {
      const thread = byId.get(id);
      return thread && (options?.createdByIntegrationId === undefined || thread.created_by_integration_id === options.createdByIntegrationId)
        ? thread
        : null;
    });

    expect(service.threadSearch(externalAuthority, { limit: 20 })).toMatchObject({
      threads: [{ threadId: ownedThread.id }],
    });
    expect(threads.search).toHaveBeenCalledWith(expect.objectContaining({ createdByIntegrationId: "integration-a" }));

    const found = service.threadGet(externalAuthority, { threadId: ownedThread.id, messageLimit: 10 });
    expect(found).toMatchObject({ status: "found", thread: { threadId: ownedThread.id } });
    expect(messages.listByThreadForThreadControl).toHaveBeenCalledWith(
      ownedThread.id,
      10,
      THREAD_GET_TRANSCRIPT_MAX_BYTES,
    );
    expect(service.threadGet(externalAuthority, { threadId: otherOwnedThread.id, messageLimit: 10 })).toMatchObject({
      status: "rejected",
      error: { code: "not_found" },
    });
    expect(service.threadGet(externalAuthority, { threadId: unownedThread.id, messageLimit: 10 })).toMatchObject({
      status: "rejected",
      error: { code: "not_found" },
    });

    await expect(service.threadWait(externalAuthority, { threadIds: [ownedThread.id], until: "attention_or_terminal", timeoutSeconds: 1 })).resolves.toMatchObject({
      status: "success",
      timedOut: true,
      results: [{ threadId: ownedThread.id }],
    });
    await expect(service.threadWait(externalAuthority, { threadIds: [ownedThread.id, otherOwnedThread.id], until: "attention_or_terminal", timeoutSeconds: 1 })).resolves.toMatchObject({
      status: "rejected",
      error: { code: "not_found" },
    });
    expect(threads.updateStatus).not.toHaveBeenCalled();
    expect(agentService.sendMessage).not.toHaveBeenCalled();
  });

  it("restricts external Project discovery and worktree listing to selected scopes", async () => {
    const service = createService();
    const externalAuthority = {
      type: "external" as const,
      integrationId: "integration-a",
      allowedWorkspaceIds: [workspace.id],
      scopes: ["projects:read", "worktrees:read"] as const,
      limits: { callsPerMinute: 10, maxActiveThreads: 10 },
    };
    const discovered = service.workspaceSearch(externalAuthority, { query: "", limit: 20 });
    expect(discovered.workspaces).toEqual([{ workspaceId: workspace.id, name: workspace.name }]);
    await expect(service.worktreeList(externalAuthority, { workspaceId: workspace.id })).resolves.toMatchObject({
      status: "found",
      workspaceId: workspace.id,
    });
    await expect(service.worktreeList({ ...externalAuthority, scopes: ["projects:read"] }, { workspaceId: workspace.id })).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({ code: "not_found" }),
    });
  });

  it("audits denied reads without recording the unreadable target", async () => {
    const service = createService();

    expect(service.threadGet(authority, { threadId: "missing-thread", messageLimit: 10 })).toMatchObject({
      status: "rejected",
      error: { code: "not_found" },
    });
    await expect(service.threadWait(authority, {
      threadIds: ["missing-thread"],
      until: "attention_or_terminal",
      timeoutSeconds: 1,
    })).resolves.toMatchObject({
      status: "rejected",
      error: { code: "not_found" },
    });

    expect(audit.write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: "thread_get",
      outcome: "not_found",
      callerId: authority.userId,
      sourceThreadId: authority.sourceThreadId,
    }));
    expect(audit.write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: "thread_wait",
      outcome: "not_found",
      callerId: authority.userId,
      sourceThreadId: authority.sourceThreadId,
    }));
    for (const [event] of audit.write.mock.calls) {
      expect(event).not.toHaveProperty("workspaceId");
      expect(event).not.toHaveProperty("threadId");
    }
  });

  it("normalizes empty thread titles at the projection boundary", () => {
    const service = createService();
    const emptyTitleThread = {
      ...createdThread,
      id: "empty-title-thread",
      title: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:01.000Z",
      deleted_at: null,
    };
    const namedThread = { ...emptyTitleThread, id: "named-thread", title: "Keep this title" };
    threads.search.mockReturnValue({ threads: [emptyTitleThread, namedThread], workspaces: [] });

    const result = service.threadSearch(authority, { limit: 20 });

    expect(result.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: emptyTitleThread.id, title: "Untitled thread" }),
      expect.objectContaining({ threadId: namedThread.id, title: "Keep this title" }),
    ]));
  });

  it("bounds wait polling to a quarter-second interval", async () => {
    const service = createService();
    const runningThread = {
      ...createdThread,
      id: "running-thread",
      title: "Running",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:02.000Z",
      deleted_at: null,
    };
    threads.findById.mockReturnValue(runningThread);
    agentService.activeThreadIds = vi.fn().mockReturnValue([runningThread.id]);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await expect(service.threadWait(authority, {
        threadIds: [runningThread.id],
        until: "attention_or_terminal",
        timeoutSeconds: 1,
      })).resolves.toMatchObject({ status: "success", timedOut: true });

      const delays = setTimeoutSpy.mock.calls
        .map(([, delay]) => delay)
        .filter((delay): delay is number => typeof delay === "number");
      expect(delays.some((delay) => delay >= 250 && delay <= 500)).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("preserves authoritative state on wait timeout without mutating the target", async () => {
    const service = createService();
    const runningThread = {
      ...createdThread,
      id: "running-thread",
      title: "Running",
      workspace_id: workspace.id,
      provider: "claude",
      model: "claude-model",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:02.000Z",
      deleted_at: null,
    };
    threads.findById.mockReturnValue(runningThread);
    agentService.activeThreadIds = vi.fn().mockReturnValue([runningThread.id]);

    await expect(service.threadWait(authority, { threadIds: [runningThread.id], until: "attention_or_terminal", timeoutSeconds: 1 })).resolves.toEqual({
      status: "success",
      timedOut: true,
      results: [{ workspaceId: workspace.id, threadId: runningThread.id, state: { status: "running" } }],
    });
    expect(threads.updateStatus).not.toHaveBeenCalled();
    expect(agentService.sendMessage).not.toHaveBeenCalled();
  });

  it("reserves external capacity in input order and preserves earlier success", async () => {
    const service = createService();
    const externalAuthority = {
      type: "external" as const,
      integrationId: "integration-1",
      allowedWorkspaceIds: [workspace.id],
      scopes: ["threads:create"] as const,
      limits: { callsPerMinute: 10, maxActiveThreads: 1 },
    };

    const result = await service.threadCreateBatch(externalAuthority, {
      items: [
        {
          workspaceId: workspace.id,
          title: "First",
          prompt: "Create first.",
          placement: { type: "direct" },
        },
        {
          workspaceId: workspace.id,
          title: "Second",
          prompt: "Reject second.",
          placement: { type: "direct" },
        },
      ],
    });

    expect(result.results.map((item) => [item.index, item.status])).toEqual([
      [0, "created"],
      [1, "rejected"],
    ]);
    expect(result.results[1]).toMatchObject({
      error: { code: "limit_exceeded", retryable: true },
    });
    expect(threads.updateExternalCreator).toHaveBeenCalledWith(
      createdThread.id,
      "integration-1",
    );
    expect(agentService.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends a full cross-thread message with authenticated origin", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockReturnValue(target);
    const fullAuthority = { ...authority, permissionMode: "full" as const };

    await expect(service.threadSend(fullAuthority, { threadId: target.id, message: "Continue the task." })).resolves.toMatchObject({
      status: "accepted",
      workspaceId: workspace.id,
      threadId: target.id,
      execution: { providerId: "claude", modelId: "claude-exact", permissionMode: "full", interactionMode: "build" },
    });
    expect(agentService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: target.id,
      content: "Continue the task.",
      sourceThreadId: authority.sourceThreadId,
      originSourceTurnId: authority.sourceTurnId,
      sourceProviderId: authority.sourceProviderId,
    }));
  });

  it("persists supervised send approval and excludes the source thread", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockImplementation((id: string) => id === target.id ? target : id === authority.sourceThreadId ? { ...target, id: authority.sourceThreadId } : null);

    await expect(service.threadSend(authority, { threadId: target.id, message: "Needs approval." })).resolves.toMatchObject({ status: "pending_approval", approvalId: "approval-send" });
    expect(approvals.createSend).toHaveBeenCalledWith(expect.objectContaining({ message: "Needs approval.", sourceThreadId: authority.sourceThreadId }));
    await expect(service.threadSend(authority, { threadId: authority.sourceThreadId, message: "Self-target" })).resolves.toMatchObject({ status: "rejected", error: { code: "not_found" } });
  });

  it("derives internal send permission from authenticated authority", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockReturnValue(target);

    await expect(service.threadSend(authority, {
      threadId: target.id,
      message: "Forged full mode",
      permissionMode: "full",
    })).resolves.toMatchObject({ status: "pending_approval" });
    expect(approvals.createSend).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({ permissionMode: "supervised" }),
    }));
    expect(agentService.sendMessage).not.toHaveBeenCalled();
  });

  it("inherits supervised global permission for null source settings on send and stop", async () => {
    const source = { ...createdThread, id: "source-thread", permission_mode: null, deleted_at: null };
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockImplementation((id: string) => id === source.id ? source : id === target.id ? target : null);

    const sendService = createService("supervised");
    await expect(sendService.threadControlSend({
      source: { workspaceId: workspace.id, threadId: source.id },
      target: { workspaceId: workspace.id, threadId: target.id },
      message: "Needs human approval.",
    })).resolves.toMatchObject({ status: "pending_approval" });
    expect(approvals.createSend).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({ permissionMode: "supervised" }),
    }));
    expect(agentService.sendMessage).not.toHaveBeenCalled();

    mutationReservations = new ThreadControlMutationReservationService();
    const stopService = createService("supervised");
    await expect(stopService.threadControlStop({
      source: { workspaceId: workspace.id, threadId: source.id },
      target: { workspaceId: workspace.id, threadId: target.id },
    })).resolves.toMatchObject({ status: "pending_approval" });
    expect(approvals.createStop).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({ permissionMode: "supervised" }),
    }));
    expect(agentService.stopSession).not.toHaveBeenCalled();
  });

  it("rejects a competing supervised mutation while approval is pending", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockReturnValue(target);

    await expect(service.threadSend(authority, { threadId: target.id, message: "First" })).resolves.toMatchObject({ status: "pending_approval" });
    await expect(service.threadSend(authority, { threadId: target.id, message: "Second" })).resolves.toMatchObject({
      status: "rejected",
      error: { code: "thread_busy" },
    });
    expect(approvals.createSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending send reservation token through approval dispatch", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockReturnValue(target);
    await service.threadSend(authority, { threadId: target.id, message: "Resume once" });
    approvals.claim.mockReturnValue({
      operation: "thread_send",
      approvalId: "approval-send",
      threadId: target.id,
      workspaceId: workspace.id,
      message: "Resume once",
      execution: { providerId: "claude", modelId: "claude-exact", permissionMode: "supervised", interactionMode: "build" },
      turnId: "turn-send",
      operationPhase: "pre_dispatch",
      callerId: authority.userId,
      sourceThreadId: authority.sourceThreadId,
      sourceTurnId: authority.sourceTurnId,
      sourceProviderId: authority.sourceProviderId,
    });

    await expect(service.respondToApproval("approval-send", "allow")).resolves.toBe(true);
    expect(agentService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      mutationReservationToken: "approval-send",
    }));
  });

  it("fails approval recovery when persisted send provenance is incomplete", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockReturnValue(target);
    mutationReservations.rehydrate(target.id, "approval-send");
    approvals.claim.mockReturnValue({
      operation: "thread_send",
      approvalId: "approval-send",
      threadId: target.id,
      workspaceId: workspace.id,
      message: "Resume with bad provenance",
      execution: { providerId: "claude", modelId: "claude-exact", permissionMode: "supervised", interactionMode: "build" },
      turnId: "turn-send",
      operationPhase: "pre_dispatch",
      callerId: authority.userId,
      sourceThreadId: authority.sourceThreadId,
      sourceTurnId: authority.sourceTurnId,
    });

    await expect(service.respondToApproval("approval-send", "allow")).resolves.toBe(true);
    expect(agentService.sendMessage).not.toHaveBeenCalled();
    expect(approvals.settle).toHaveBeenCalledWith("approval-send", "failed");
    expect(mutationReservations.get(target.id)).toBeUndefined();
  });

  it("stops a full target and leaves it in the stopped lifecycle state", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", model: "claude-exact", deleted_at: null };
    threads.findById.mockReturnValue(target);
    const fullAuthority = { ...authority, permissionMode: "full" as const };

    await expect(service.threadStop(fullAuthority, { threadId: target.id })).resolves.toEqual({ status: "accepted", workspaceId: workspace.id, threadId: target.id, state: { status: "stopped" } });
    expect(agentService.stopSession).toHaveBeenCalledWith(target.id);
    expect(threads.updateStatus).toHaveBeenCalledWith(target.id, "interrupted");
  });

  it("audits idempotent and busy stopped outcomes", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", status: "interrupted", deleted_at: null };
    threads.findById.mockReturnValue(target);

    await expect(service.threadStop({ ...authority, permissionMode: "full" }, { threadId: target.id })).resolves.toMatchObject({ status: "accepted" });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ operation: "thread_stop", outcome: "accepted" }));

    audit.write.mockClear();
    approvals.listPendingByThread.mockReturnValue([{ approvalId: "pending-stop", operation: "thread_stop", threadId: target.id }]);
    await expect(service.threadStop({ ...authority, permissionMode: "full" }, { threadId: target.id })).resolves.toMatchObject({ status: "rejected", error: { code: "thread_busy" } });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ operation: "thread_stop", outcome: "thread_busy" }));
  });

  it("audits a full stop internal error", async () => {
    const service = createService();
    const target = { ...createdThread, id: "target-thread", deleted_at: null };
    threads.findById.mockReturnValue(target);
    agentService.stopSession.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(service.threadStop({ ...authority, permissionMode: "full" }, { threadId: target.id })).resolves.toMatchObject({
      status: "rejected",
      error: { code: "internal_error" },
    });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ operation: "thread_stop", outcome: "internal_error" }));
  });
});
