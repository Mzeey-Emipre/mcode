import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, PermissionRequest, ThreadStartup } from "@mcode/contracts";
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
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useThreadStartupStore } from "@/features/thread-startup";
import { buildVolatileItems } from "@/features/conversation/messages/virtual-items";

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

describe("ws-events thread.startup.updated", () => {
  afterEach(() => {
    stopPushListeners();
    useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {} });
  });

  it("ignores an out-of-order startup revision", () => {
    const current: ThreadStartup = {
      startupId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "ws-1",
      kind: "direct",
      state: "running",
      phase: "agent",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "agent", state: "running" },
      ],
      transcript: [],
      cancellation: "none",
      revision: 2,
      threadId: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:01.000Z",
    };
    startPushListeners();

    pushEmitter.emit("thread.startup.updated", current);
    pushEmitter.emit("thread.startup.updated", {
      ...current,
      revision: 1,
      state: "failed",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "agent", state: "failed" },
      ],
      error: { code: "STALE", message: "stale", retryable: true },
    });

    expect(useThreadStartupStore.getState().recordsByStartupId[current.startupId]).toMatchObject({
      revision: 2,
      state: "running",
    });
  });
});

describe("ws-events Project Actions", () => {
  afterEach(() => stopPushListeners());

  it("applies retained Action output outside Thread Overview and clears it on Thread deletion", () => {
    const run = {
      threadId: "thread-1",
      workspaceId: "ws-1",
      actionId: "build",
      runId: "run-1",
      revision: 1,
      terminalSessionId: "terminal-1",
      actionName: "Build",
      status: "completed" as const,
      snapshot: { platform: "windows" as const, script: "bun run build", checkoutPath: "C:\\repo", terminal: null, environmentNames: [] },
      createdAt: "2026-08-22T12:00:00.000Z",
      startedAt: "2026-08-22T12:00:00.000Z",
      finishedAt: "2026-08-22T12:00:01.000Z",
      exitCode: 0,
      transcript: "done",
      transcriptTruncated: false,
    };
    useProjectActionStore.setState({ runsByThread: {} });
    startPushListeners();

    pushEmitter.emit("workspace.environment.action.updated", {
      threadId: run.threadId,
      actionId: run.actionId,
      runId: run.runId,
      run,
    });
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.transcript).toBe("done");

    pushEmitter.emit("thread.deleted", { threadId: "thread-1" });
    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toBeUndefined();
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

describe("ws-events permission.request", () => {
  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("creates permission controls only from an actual provider permission request", () => {
    const request = {
      requestId: "permission-1",
      threadId: "thread-1",
      toolName: "Shell",
      input: { command: "git status" },
    } satisfies PermissionRequest;
    startPushListeners();

    pushEmitter.emit("agent.event", {
      type: "system",
      threadId: request.threadId,
      subtype: "approval.review.manual-required",
      message: "Manual approval is required before Codex can continue.",
      systemNotice: {
        kind: "diagnostic",
        presentation: "timeline",
        scope: "turn",
        sessionId: "notice-session",
        noticeKey: "approval-review-manual-required",
      },
    } satisfies AgentEvent);
    expect(buildVolatileItems([], undefined, undefined, undefined, useThreadStore.getState().records.get(request.threadId)?.permissions))
      .not.toContainEqual(expect.objectContaining({ type: "permission-request" }));
    pushEmitter.emit("permission.request", request);

    expect(buildVolatileItems([], undefined, undefined, undefined, useThreadStore.getState().records.get(request.threadId)?.permissions))
      .toMatchObject([{ type: "permission-request", requestId: request.requestId, toolName: "Shell" }]);
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
