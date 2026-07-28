import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_GET_TRANSCRIPT_MAX_BYTES } from "@mcode/contracts";

const { mockBroadcast } = vi.hoisted(() => ({ mockBroadcast: vi.fn() }));

vi.mock("../../transport/push.js", () => ({ broadcast: mockBroadcast }));

import { ThreadControlService, type InternalThreadControlAuthority } from "../thread-control-service.js";

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
  };
  let threadService: { provisionWorktree: ReturnType<typeof vi.fn>; cleanupInterruptedProvisioning: ReturnType<typeof vi.fn> };
  let agentService: { sendMessage: ReturnType<typeof vi.fn>; activeThreadIds?: ReturnType<typeof vi.fn> };
  let approvals: {
    create: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
    setOperationPhase: ReturnType<typeof vi.fn>;
    listProcessing: ReturnType<typeof vi.fn>;
    requeue: ReturnType<typeof vi.fn>;
    requeueRecoveredProvisioning: ReturnType<typeof vi.fn>;
    listPendingByThread: ReturnType<typeof vi.fn>;
  };
  let audit: { write: ReturnType<typeof vi.fn> };
  let messages: { listByThreadForThreadControl: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    workspaces = {
      search: vi.fn().mockReturnValue([workspace]),
      findById: vi.fn().mockReturnValue(workspace),
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
    };
    messages = {
      listByThreadForThreadControl: vi.fn().mockReturnValue({ messages: [], hasMore: false }),
    };
    threadService = {
      provisionWorktree: vi.fn().mockResolvedValue({
        ...createdThread,
        mode: "worktree",
        worktree_path: "C:/private/workspace/.worktrees/created",
      }),
      cleanupInterruptedProvisioning: vi.fn().mockResolvedValue(true),
    };
    agentService = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    approvals = {
      create: vi.fn().mockReturnValue("approval-1"),
      claim: vi.fn(),
      settle: vi.fn().mockReturnValue(true),
      setOperationPhase: vi.fn().mockReturnValue(true),
      listProcessing: vi.fn().mockReturnValue([]),
      requeue: vi.fn().mockReturnValue(true),
      requeueRecoveredProvisioning: vi.fn().mockReturnValue(true),
      listPendingByThread: vi.fn().mockReturnValue([]),
    };
    audit = { write: vi.fn() };
  });

  function createService() {
    return new ThreadControlService(
      workspaces as never,
      worktrees as never,
      git as never,
      threads as never,
      threadService as never,
      agentService as never,
      {
        get: () => ({
          model: { defaults: { provider: "codex", id: "gpt-default" } },
          agent: { defaults: { permission: "full" } },
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
    );

    const result = service.workspaceSearch(authority, { limit: 20 });

    expect(JSON.stringify(result)).not.toContain(workspacePath);
    expect(result.workspaces).toEqual([{ workspaceId: "workspace-1", name: "Workspace" }]);
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
    expect(threadService.provisionWorktree).not.toHaveBeenCalled();
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
    expect(threadService.provisionWorktree).toHaveBeenCalledWith(
      createdThread.id,
      workspace.id,
      {
        type: "new_worktree",
        baseRef: "main",
        branchName: "codex/issue-960",
      },
    );
  });

  it("resumes the same pending operation exactly once after human approval", async () => {
    const service = createService();
    approvals.claim.mockReturnValue({
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

    expect(threadService.provisionWorktree).toHaveBeenCalledTimes(1);
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
    expect(threadService.provisionWorktree).toHaveBeenCalledTimes(1);
  });

  it("keeps an approved thread active when its post-settlement audit write fails", async () => {
    const service = createService();
    approvals.claim.mockReturnValue({
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
      { approvalId: "safe", threadId: "thread-safe", operationPhase: "pre_provision" },
      {
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
    expect(threadService.cleanupInterruptedProvisioning).toHaveBeenCalledWith(
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

  it("continues recovery when failure persistence or audit logging throws", async () => {
    const service = createService();
    approvals.settle.mockImplementationOnce(() => { throw new Error("database unavailable"); });
    audit.write.mockImplementationOnce(() => { throw new Error("audit unavailable"); });
    approvals.listProcessing.mockReturnValue([
      {
        invalid: true,
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
    ["returns false", () => threadService.cleanupInterruptedProvisioning.mockResolvedValue(false)],
    ["throws", () => threadService.cleanupInterruptedProvisioning.mockRejectedValue(new Error("locked"))],
  ])("fails recovery when managed worktree cleanup %s", async (_case, arrange) => {
    const service = createService();
    arrange();
    approvals.listProcessing.mockReturnValue([{
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
});
