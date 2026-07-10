import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport";

vi.mock("@/transport", () => ({
  getTransport: vi.fn(),
}));

import { pushEmitter } from "./ws-transport";
import { startPushListeners, stopPushListeners } from "./ws-events";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useSkillsStore } from "@/stores/skillsStore";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Thread",
    status: "active",
    mode: "worktree",
    worktree_path: "/repo-wt",
    branch: "feat/old",
    checkout_state: "named",
    base_branch: null,
    worktree_managed: true,
    issue_number: null,
    pr_number: 10,
    pr_status: "OPEN",
    sdk_session_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    model: null,
    provider: "claude",
    deleted_at: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    default_open_in_app: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    has_file_changes: false,
    ...overrides,
  };
}

describe("ws-events thread.checkoutChanged", () => {
  beforeEach(() => {
    stopPushListeners();
    useWorkspaceStore.setState({
      threads: [makeThread()],
      prUrlsByThreadId: { "thread-1": "https://example.test/pr/10", other: "keep" },
      checksById: {
        "thread-1": { aggregate: "passing", runs: [], fetchedAt: 1 },
        other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
      },
    });
  });

  it("patches thread checkout fields and clears stale PR/check caches", () => {
    startPushListeners();

    pushEmitter.emit("thread.checkoutChanged", {
      threadId: "thread-1",
      workspaceId: "ws-1",
      branch: "HEAD",
      checkoutState: "branchless",
      baseBranch: "feat/old",
      prNumber: null,
      prStatus: null,
    });

    const state = useWorkspaceStore.getState();
    expect(state.threads[0]).toMatchObject({
      branch: "HEAD",
      checkout_state: "branchless",
      base_branch: "feat/old",
      pr_number: null,
      pr_status: null,
    });
    expect(state.prUrlsByThreadId).toEqual({ other: "keep" });
    expect(state.checksById).toEqual({
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    });
  });
});

describe("ws-events skills.changed", () => {
  afterEach(() => {
    stopPushListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces a burst of provider invalidations into one cache refresh", () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(useSkillsStore.getState(), "invalidate");
    startPushListeners();

    pushEmitter.emit("skills.changed", {});
    pushEmitter.emit("skills.changed", {});
    pushEmitter.emit("skills.changed", {});
    vi.advanceTimersByTime(100);

    expect(invalidate).toHaveBeenCalledOnce();
  });
});
