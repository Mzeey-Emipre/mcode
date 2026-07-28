import { describe, expect, it } from "vitest";
import {
  THREAD_CREATE_BATCH_MAX_ITEMS,
  THREAD_CREATE_PROMPT_MAX_LENGTH,
  ThreadCreateBatchInputSchema,
  ThreadCreateBatchResultSchema,
  ThreadSearchInputSchema,
  ThreadWaitInputSchema,
  WORKSPACE_SEARCH_LIMIT_DEFAULT,
  WorkspaceSearchInputSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
} from "../thread-control.js";

describe("thread control discovery schemas", () => {
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

describe("thread_create_batch schemas", () => {
  const item = {
    workspaceId: "workspace",
    title: "Implement issue #960",
    prompt: "Implement the issue.",
    placement: { type: "direct" as const },
  };

  it("accepts one to twenty ordered creation items and rejects authority fields", () => {
    expect(ThreadCreateBatchInputSchema().parse({ items: [item] })).toEqual({ items: [item] });
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
