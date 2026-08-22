import { describe, expect, it } from "vitest";
import { MAX_THREAD_SUBSCRIPTIONS, WS_METHODS } from "../methods.js";

describe("thread switching WebSocket contracts", () => {
  it("requires an authoritative runtime snapshot for the first-turn result", () => {
    const method = WS_METHODS()["agent.createAndSend"];
    const thread = {
      id: "thread-1",
      workspace_id: "workspace-1",
      title: "First turn",
      status: "active",
      mode: "direct",
      worktree_path: null,
      branch: "main",
      checkout_state: "named",
      base_branch: null,
      worktree_managed: false,
      issue_number: null,
      pr_number: null,
      pr_status: null,
      sdk_session_id: null,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      model: "gpt-5.5",
      provider: "codex",
      deleted_at: null,
      user_completed_at: null,
      scheduled_deletion_at: null,
      cleanup_state: null,
      cleanup_reason: null,
      last_context_tokens: null,
      context_window: null,
      reasoning_level: null,
      interaction_mode: null,
      orchestration_mode: null,
      permission_mode: null,
      context_window_mode: null,
      thinking: null,
      codex_fast_mode: null,
      copilot_agent: null,
      default_open_in_app: null,
      parent_thread_id: null,
      forked_from_message_id: null,
      last_compact_summary: null,
    };

    expect(method.result.safeParse(thread).success).toBe(false);
    expect(method.result.safeParse({
      ...thread,
      runtimeSnapshot: {
        threadId: "thread-1",
        turnExecutionId: "00000000-0000-4000-8000-000000000001",
        phase: "running",
      },
    }).success).toBe(true);
  });

  it("registers bounded conversation.tail params and result", () => {
    const method = WS_METHODS()["conversation.tail"];

    expect(method.params.safeParse({ threadId: "thread-1", limit: 2 }).success).toBe(true);
    expect(method.params.safeParse({ threadId: "thread-1", limit: 3 }).success).toBe(false);
    expect(method.result.safeParse({ messages: [], hasMore: false }).success).toBe(true);
  });

  it("replaces the complete desired subscription set atomically", () => {
    const method = WS_METHODS()["push.setThreadSubscriptions"];

    expect(method.params.safeParse({ threadIds: ["thread-1", "thread-2"] }).success).toBe(true);
    expect(method.params.safeParse({ threadIds: ["thread-1", "thread-1"] }).success).toBe(false);
    expect(method.params.safeParse({ threadIds: Array.from({ length: MAX_THREAD_SUBSCRIPTIONS + 1 }, (_, index) => `thread-${index}`) }).success).toBe(false);
    expect(method.params.safeParse({ threadIds: [""] }).success).toBe(false);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": { epoch: "00000000-0000-4000-8000-000000000001", sequence: 4 } },
    }).success).toBe(true);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": 4 },
    }).success).toBe(true);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": -1 },
    }).success).toBe(false);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": 1.5 },
    }).success).toBe(false);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      revisions: {
        "thread-1": { conversationRevision: 4, rosterRevision: 2 },
      },
    }).success).toBe(true);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      revisions: {
        "thread-1": { conversationRevision: -1, rosterRevision: 2 },
      },
    }).success).toBe(false);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: Object.fromEntries(
        Array.from({ length: MAX_THREAD_SUBSCRIPTIONS + 1 }, (_, index) => [`thread-${index}`, index]),
      ),
    }).success).toBe(false);
  });

  it("parses structured hydration and replay results", () => {
    const method = WS_METHODS()["push.setThreadSubscriptions"];
    const result = {
      hydrationRequiredThreadIds: ["thread-1"],
      replayedThrough: { "thread-2": 12 },
      canonicalRecoveries: [],
    };

    const parsed = method.result.safeParse(result);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    expect(parsed.data).toEqual(result);
  });

  it("rejects malformed subscription replay results", () => {
    const method = WS_METHODS()["push.setThreadSubscriptions"];

    expect(method.result.safeParse({
      hydrationRequiredThreadIds: ["thread-1"],
      replayedThrough: { "thread-2": 0 },
      canonicalRecoveries: [],
    }).success).toBe(false);
  });

  it("keeps legacy single-thread subscription methods available", () => {
    expect(WS_METHODS()["push.subscribeThread"]).toBeDefined();
    expect(WS_METHODS()["push.unsubscribeThread"]).toBeDefined();
  });

  it("bounds deletion identifiers before lifecycle barriers retain them", () => {
    for (const methodName of ["workspace.delete", "workspace.forceDelete"] as const) {
      const method = WS_METHODS()[methodName];
      expect(method.params.safeParse({ id: "workspace-1" }).success).toBe(true);
      expect(method.params.safeParse({ id: "" }).success).toBe(false);
      expect(method.params.safeParse({ id: "x".repeat(257) }).success).toBe(false);
    }

    const threadDelete = WS_METHODS()["thread.delete"];
    expect(threadDelete.params.safeParse({ threadId: "thread-1", cleanupWorktree: false }).success).toBe(true);
    expect(threadDelete.params.safeParse({ threadId: "", cleanupWorktree: false }).success).toBe(false);
    expect(threadDelete.params.safeParse({ threadId: "x".repeat(257), cleanupWorktree: false }).success).toBe(false);
  });
});
