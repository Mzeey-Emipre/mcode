import { describe, expect, it } from "vitest";
import {
  THREAD_CREATE_BATCH_MAX_ITEMS,
  THREAD_CREATE_PROMPT_MAX_LENGTH,
  ThreadCreateBatchInputSchema,
  ThreadCreateBatchResultSchema,
  ThreadSearchInputSchema,
  ThreadSendInputSchema,
  ThreadSendResultSchema,
  ThreadStopInputSchema,
  ThreadStopResultSchema,
  ThreadControlIdentitySchema,
  ThreadControlProjectionSchema,
  ThreadControlUserSendInputSchema,
  ThreadControlUserStopInputSchema,
  ThreadWaitInputSchema,
  MessageOriginSchema,
  WORKSPACE_SEARCH_LIMIT_DEFAULT,
  WorkspaceSearchInputSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
  ThreadTargetListInputSchema,
  ThreadTargetListResultSchema,
} from "../thread-control.js";

describe("thread control discovery schemas", () => {
  it("accepts secret-free provider target discovery and validates defaults", () => {
    expect(ThreadTargetListInputSchema().parse({})).toEqual({});
    const result = ThreadTargetListResultSchema().parse({
      providers: [{
        providerId: "codex",
        name: "Codex",
        models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        defaultModelId: "gpt-5.6-sol",
      }],
    });
    expect(result.providers[0].models[0]).toEqual({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" });
    expect(ThreadTargetListResultSchema().safeParse({
      providers: [{ providerId: "codex", name: "Codex", models: [{ id: "gpt", name: "GPT" }], defaultModelId: "missing" }],
    }).success).toBe(false);
  });
  it("bounds and defaults workspace search without accepting authority fields", () => {
    expect(WorkspaceSearchInputSchema().parse({})).toEqual({ limit: WORKSPACE_SEARCH_LIMIT_DEFAULT });
    expect(WorkspaceSearchInputSchema().safeParse({ limit: 51 }).success).toBe(false);
    expect(WorkspaceSearchInputSchema().safeParse({ sourceThreadId: "forged" }).success).toBe(false);
  });

  it("rejects forged fields and raw paths in worktree discovery payloads", () => {
    expect(WorktreeListInputSchema().safeParse({ workspaceId: "workspace", path: "C:/secret" }).success).toBe(false);
    expect(WorktreeListResultSchema().safeParse({
      status: "found", workspaceId: "workspace", worktrees: [{ worktreeId: "worktree", label: "main", path: "C:/secret" }],
    }).success).toBe(false);
  });
});

describe("thread search and wait schemas", () => {
  it("rejects empty status filters and duplicate wait targets", () => {
    expect(ThreadSearchInputSchema().safeParse({ statuses: [] }).success).toBe(false);
    expect(ThreadWaitInputSchema().safeParse({ threadIds: ["thread-1", "thread-1"] }).success).toBe(false);
  });
});

describe("thread mutation schemas", () => {
  it("accepts bounded send and stop inputs without authority fields", () => {
    expect(ThreadSendInputSchema().parse({ threadId: "target", message: "Follow up" })).toEqual({
      threadId: "target",
      message: "Follow up",
    });
    expect(ThreadSendInputSchema().safeParse({ threadId: "target", message: "x", sourceThreadId: "forged" }).success).toBe(false);
    expect(ThreadStopInputSchema().safeParse({ threadId: "target", sourceThreadId: "forged" }).success).toBe(false);
  });

  it("validates accepted, pending, and rejected mutation results", () => {
    const accepted = {
      status: "accepted" as const,
      workspaceId: "workspace",
      threadId: "target",
      turnId: "turn",
      execution: { providerId: "codex", modelId: "gpt", permissionMode: "full" as const, interactionMode: "build" as const },
      state: { status: "starting" as const },
    };
    expect(ThreadSendResultSchema().parse(accepted)).toEqual(accepted);
    expect(ThreadSendResultSchema().parse({ status: "pending_approval", workspaceId: "workspace", threadId: "target", approvalId: "approval", state: { status: "waiting_for_approval", approvalId: "approval" } })).toBeTruthy();
    expect(ThreadSendResultSchema().parse({
      status: "rejected",
      workspaceId: "workspace",
      threadId: "target",
      error: { code: "thread_busy", message: "Thread is already running", retryable: true },
    })).toBeTruthy();
    expect(ThreadStopResultSchema().parse({ status: "accepted", workspaceId: "workspace", threadId: "target", state: { status: "stopped" } })).toBeTruthy();
    expect(ThreadStopResultSchema().parse({
      status: "rejected",
      threadId: "target",
      error: { code: "conflict", message: "Thread is terminal", retryable: false },
    })).toBeTruthy();
    expect(ThreadStopResultSchema().safeParse({ status: "accepted", workspaceId: "workspace", threadId: "target", state: { status: "stopped" }, turnId: "forged" }).success).toBe(false);
  });
});

describe("user-facing coordination schemas", () => {
  const identity = { workspaceId: "workspace-1", threadId: "thread-1" };
  const thread = {
    ...identity,
    title: "Coordinator",
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    state: { status: "running" as const },
  };

  it("requires explicit Project/Thread identities for reads and mutations", () => {
    expect(ThreadControlIdentitySchema().safeParse({ workspaceId: "workspace-1" }).success).toBe(false);
    expect(ThreadControlUserSendInputSchema().safeParse({
      source: identity,
      target: { workspaceId: "workspace-2", threadId: "thread-2" },
      message: "Follow up",
      sourceThreadId: "forged",
    }).success).toBe(false);
    expect(ThreadControlUserStopInputSchema().safeParse({
      source: identity,
      target: { workspaceId: "workspace-2", threadId: "thread-2" },
      sourceWorkspaceId: "forged",
    }).success).toBe(false);
  });

  it("accepts persisted relation, provenance, lifecycle, and approval projection data", () => {
    const projection = {
      identity,
      thread: { ...thread, createdAt: "2026-07-29T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z" },
      messages: [{
        messageId: "message-1",
        role: "user" as const,
        content: "Delegate this",
        createdAt: "2026-07-29T00:00:00.000Z",
        origin: {
          type: "thread" as const,
          sourceThreadId: "source-thread",
          sourceTurnId: "turn-1",
          sourceProviderId: "claude",
          sourceWorkspaceId: "workspace-2",
          sourceWorkspaceName: "Source Project",
          sourceUnavailable: false,
          sourceThread: {
            ...thread,
            workspaceId: "workspace-2",
            threadId: "source-thread",
            title: "Source",
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          },
        },
      }],
      hasMoreMessages: false,
      relation: {
        source: { ...thread, workspaceId: "workspace-2", threadId: "source-thread", title: "Source" },
        destination: thread,
        creatorTurnId: "turn-1",
        creatorToolCallId: "tool-1",
        creationKind: "thread_delegation" as const,
      },
      children: [],
      approvals: [{
        requestId: "approval-1",
        threadId: "thread-1",
        toolName: "thread_send",
        title: "Send a message to another thread",
        input: { threadId: "thread-2", message: "Follow up" },
        ownerWorkspaceId: "workspace-1",
        ownerThreadId: "thread-1",
        sourceThreadId: "source-thread",
        operation: "thread_send" as const,
      }],
    };
    expect(ThreadControlProjectionSchema().parse(projection)).toEqual(projection);
    expect(MessageOriginSchema().parse({
      type: "thread",
      sourceThreadId: "source-thread",
      sourceTurnId: "turn-1",
      sourceProviderId: "claude",
      sourceWorkspaceId: null,
      sourceWorkspaceName: "Unavailable Project",
      sourceThread: null,
      sourceUnavailable: true,
    })).toEqual({
      type: "thread",
      sourceThreadId: "source-thread",
      sourceTurnId: "turn-1",
      sourceProviderId: "claude",
      sourceWorkspaceId: null,
      sourceWorkspaceName: "Unavailable Project",
      sourceThread: null,
      sourceUnavailable: true,
    });
  });
});

describe("thread_create_batch schemas", () => {
  const item = {
    workspaceId: "workspace",
    title: "Implement issue #960",
    prompt: "Implement the issue.",
    placement: { type: "direct" as const },
  };

  it("accepts one to twenty ordered creation items and rejects authority fields", () => {
    expect(ThreadCreateBatchInputSchema().parse({ items: [item] })).toEqual({ items: [item] });
    const itemWithoutWorkspace = { title: item.title, prompt: item.prompt, placement: item.placement };
    expect(ThreadCreateBatchInputSchema().parse({ items: [itemWithoutWorkspace] })).toEqual({ items: [itemWithoutWorkspace] });
    expect(ThreadCreateBatchInputSchema().safeParse({ items: [] }).success).toBe(false);
    expect(ThreadCreateBatchInputSchema().safeParse({
      items: Array.from({ length: THREAD_CREATE_BATCH_MAX_ITEMS + 1 }, () => item),
    }).success).toBe(false);
    expect(ThreadCreateBatchInputSchema().safeParse({
      items: [{ ...item, sourceThreadId: "forged" }],
    }).success).toBe(false);
  });

  it("bounds text and accepts every placement and explicit override", () => {
    expect(ThreadCreateBatchInputSchema().safeParse({
      items: [{
        ...item,
        prompt: "x".repeat(THREAD_CREATE_PROMPT_MAX_LENGTH),
        placement: { type: "new_worktree", baseRef: "main", branchName: "codex/issue-960" },
        providerId: "codex",
        modelId: "gpt-5.6-sol",
        permissionMode: "supervised",
        interactionMode: "plan",
      }],
    }).success).toBe(true);
    expect(ThreadCreateBatchInputSchema().safeParse({
      items: [{ ...item, placement: { type: "existing_worktree", worktreeId: "worktree" } }],
    }).success).toBe(true);
    expect(ThreadCreateBatchInputSchema().safeParse({
      items: [{ ...item, prompt: "x".repeat(THREAD_CREATE_PROMPT_MAX_LENGTH + 1) }],
    }).success).toBe(false);
  });

  it("validates all four ordered result variants without exposing paths", () => {
    const execution = {
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      permissionMode: "full" as const,
      interactionMode: "build" as const,
    };
    const result = {
      results: [
        {
          index: 0,
          status: "created" as const,
          workspaceId: "workspace",
          threadId: "thread-created",
          turnId: "turn-created",
          execution,
          placement: { type: "direct" as const },
          state: { status: "starting" as const },
        },
        {
          index: 1,
          status: "pending_approval" as const,
          workspaceId: "workspace",
          threadId: "thread-pending",
          approvalId: "approval",
          execution: { ...execution, permissionMode: "supervised" as const },
          requestedPlacement: { type: "new_worktree" as const, baseRef: "main" },
          state: { status: "waiting_for_approval" as const, approvalId: "approval" },
        },
        {
          index: 2,
          status: "failed" as const,
          workspaceId: "workspace",
          threadId: "thread-failed",
          error: { code: "internal_error" as const, message: "Dispatch failed", retryable: true },
          state: { status: "failed" as const },
        },
        {
          index: 3,
          status: "rejected" as const,
          error: { code: "invalid_model" as const, message: "Model unavailable", retryable: false },
        },
      ],
    };

    expect(ThreadCreateBatchResultSchema().parse(result)).toEqual(result);
    expect(ThreadCreateBatchResultSchema().safeParse({
      results: [{ ...result.results[0], placement: { type: "direct", path: "C:/secret" } }],
    }).success).toBe(false);
  });
});
