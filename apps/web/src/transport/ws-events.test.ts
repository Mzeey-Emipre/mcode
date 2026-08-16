import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@mcode/contracts";
import type { Thread } from "@/transport";

vi.mock("@/transport", () => ({
  getTransport: vi.fn(),
}));

import { pushEmitter } from "./ws-transport";
import { startPushListeners, stopPushListeners } from "./ws-events";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useProviderCatalogStore } from "@/stores/providerCatalogStore";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadControlStore } from "@/stores/threadControlStore";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { onPtyExit } from "@/features/terminal/adapters/pty-data-registry";

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
    has_file_changes: false,
    ...overrides,
  };
}

describe("ws-events thread.lifecycleChanged", () => {
  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("applies a server-authoritative completion push", () => {
    const applyThreadLifecycle = vi.spyOn(
      useWorkspaceStore.getState(),
      "applyThreadLifecycle",
    );
    const completed = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
    });
    startPushListeners();

    pushEmitter.emit("thread.lifecycleChanged", { thread: completed });

    expect(applyThreadLifecycle).toHaveBeenCalledWith(completed);
  });

  it("removes a thread after an automatic deletion push", () => {
    const applyThreadDeleted = vi.spyOn(
      useWorkspaceStore.getState(),
      "applyThreadDeleted",
    );
    startPushListeners();

    pushEmitter.emit("thread.deleted", { threadId: "thread-1" });

    expect(applyThreadDeleted).toHaveBeenCalledWith("thread-1");
  });
});

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
    const invalidate = vi.spyOn(useProviderCatalogStore.getState(), "invalidate");
    startPushListeners();

    const change = { providerIds: ["claude", "copilot", "cursor"] as const };
    pushEmitter.emit("skills.changed", change);
    pushEmitter.emit("skills.changed", change);
    pushEmitter.emit("skills.changed", change);
    vi.advanceTimersByTime(100);

    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(change.providerIds);
  });
});

describe("ws-events thread.controlChanged", () => {
  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("invalidates only the caller-bound Project/Thread identity", () => {
    const refresh = vi.spyOn(useThreadControlStore.getState(), "refreshByThreadId").mockResolvedValue(undefined);
    startPushListeners();

    pushEmitter.emit("thread.controlChanged", {
      workspaceId: "workspace-2",
      threadId: "thread-2",
      state: { status: "running" },
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith("thread-2", "workspace-2");
  });
});

describe("ws-events provider.catalogChanged", () => {
  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("drops malformed catalog changes before store reconciliation", () => {
    const reconcile = vi.spyOn(useProviderCatalogStore.getState(), "reconcile");
    startPushListeners();

    pushEmitter.emit("provider.catalogChanged", { request: { providerId: "codex" } });

    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("ws-events agent.event", () => {
  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("drops malformed data before it reaches the thread store", () => {
    const handleAgentEvent = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    startPushListeners();

    pushEmitter.emit("agent.event", { type: "message", threadId: 42, content: "invalid" });

    expect(handleAgentEvent).not.toHaveBeenCalled();
  });

  it("forwards a valid parsed event exactly once", () => {
    const event = {
      type: "message",
      threadId: "thread-1",
      content: "valid",
      tokens: null,
    } satisfies AgentEvent;
    const handleAgentEvent = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    startPushListeners();

    pushEmitter.emit("agent.event", event);

    expect(handleAgentEvent).toHaveBeenCalledOnce();
    expect(handleAgentEvent).toHaveBeenCalledWith(event);
  });
});

describe("ws-events turn.persisted Review invalidation", () => {
  beforeEach(() => {
    stopPushListeners();
    useWorkspaceStore.setState({ threads: [makeThread()] });
    useDiffStore.setState({ diffRevisionByScope: {} });
    startPushListeners();
  });

  afterEach(() => stopPushListeners());

  it("invalidates Review only when the persisted turn changed files", () => {
    pushEmitter.emit("turn.persisted", {
      threadId: "thread-1",
      messageId: "message-1",
      toolCallCount: 0,
      filesChanged: [],
    });
    expect(useDiffStore.getState().diffRevisionByScope["thread-1"]).toBeUndefined();

    pushEmitter.emit("turn.persisted", {
      threadId: "thread-1",
      messageId: "message-2",
      toolCallCount: 0,
      filesChanged: ["src/changed.ts"],
    });
    expect(useDiffStore.getState().diffRevisionByScope["thread-1"]).toBe(1);
  });
});

describe("ws-events terminal.exit", () => {
  afterEach(() => {
    stopPushListeners();
    vi.useRealTimers();
  });

  it("reports a natural exit before removing its terminal after two seconds", () => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "PowerShell" }],
      },
      ptyToThread: { "pty-1": "thread-1" },
    });
    const onExit = vi.fn();
    const unsubscribe = onPtyExit("pty-1", onExit);
    startPushListeners();

    pushEmitter.emit("terminal.exit", { ptyId: "pty-1", code: 7 });

    expect(onExit).toHaveBeenCalledWith({ ptyId: "pty-1", code: 7 });
    expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
    vi.advanceTimersByTime(1_999);
    expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useTerminalStore.getState().terminals["thread-1"]).toBeUndefined();
    unsubscribe();
  });
});
