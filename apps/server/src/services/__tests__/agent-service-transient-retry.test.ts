import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { Thread, IProviderRegistry, TurnRequest } from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
import { ThreadControlMutationReservationService } from "../thread-control-mutation-reservation-service.js";
import { NarrativeStore } from "../narrative-store.js";
import { PlanQuestionService } from "../plan-question-service.js";
import type { ThreadRepo } from "../../repositories/thread-repo.js";
import type { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import type { MessageRepo } from "../../repositories/message-repo.js";
import type { GitService } from "../git-service.js";
import type { AttachmentService } from "../attachment-service.js";
import type { ToolCallRecordRepo } from "../../repositories/tool-call-record-repo.js";
import type { TurnSnapshotRepo } from "../../repositories/turn-snapshot-repo.js";
import type { SnapshotService } from "../snapshot-service.js";
import type { MemoryPressureService } from "../memory-pressure-service.js";
import type { TaskRepo } from "../../repositories/task-repo.js";
import type { SettingsService } from "../settings-service.js";
import type { ThreadService } from "../thread-service.js";
import type { ProviderAvailabilityService } from "../provider-availability-service.js";
import type { PlanQuestionAnswersRepo } from "../../repositories/plan-question-answers-repo.js";

vi.mock("../../transport/push.js", () => ({ broadcast: vi.fn() }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

const THREAD_ID = "thread-retry-test";

/** Thread fixture that resumes a live SDK session, so the first attempt sends `resumeFrom`. */
function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    workspace_id: "ws-1",
    title: "Test thread",
    status: "idle",
    mode: "direct",
    branch: "main",
    worktree_path: null,
    model: "claude-sonnet-4-6",
    provider: "claude",
    sdk_session_id: "sess-abc",
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    permission_mode: null,
    copilot_agent: null,
    last_compact_summary: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Thread;
}

/** Build an AgentService over a fake provider whose `sendTurn` the test scripts per attempt. */
function buildService(): {
  service: AgentService;
  sendTurn: ReturnType<typeof vi.fn>;
  discardSession: ReturnType<typeof vi.fn>;
  waitForSessionExit: ReturnType<typeof vi.fn>;
  threadControlMcp: { activate: ReturnType<typeof vi.fn> };
  providerEmitter: EventEmitter;
  mutationReservations: ThreadControlMutationReservationService;
  threadRepo: ThreadRepo & { clearSdkSessionId: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };
} {
  const thread = makeThread();
  const providerEmitter = new EventEmitter();
  const sendTurn = vi.fn(() => Promise.resolve());
  (providerEmitter as unknown as { sendTurn: typeof sendTurn }).sendTurn = sendTurn;
  const stopSession = vi.fn().mockResolvedValue(undefined);
  (providerEmitter as unknown as { stopSession: typeof stopSession }).stopSession = stopSession;
  // Implementing discardSession makes the fake provider ISessionEvictable, so
  // the retry path force-evicts the pooled session before re-dispatch.
  const discardSession = vi.fn();
  const waitForSessionExit = vi.fn().mockResolvedValue(undefined);
  (providerEmitter as unknown as { discardSession: typeof discardSession }).discardSession = discardSession;
  (providerEmitter as unknown as { waitForSessionExit: typeof waitForSessionExit }).waitForSessionExit =
    waitForSessionExit;

  const threadRepo = {
    findById: vi.fn(() => thread),
    updateStatus: vi.fn(),
    updateModel: vi.fn(),
    updateProvider: vi.fn(),
    updateSettings: vi.fn(),
    create: vi.fn(),
    softDelete: vi.fn(),
    updateWorktreePath: vi.fn(),
    updateContextUsage: vi.fn(),
    updateSdkSessionId: vi.fn(),
    clearSdkSessionId: vi.fn(),
    updateCompactSummary: vi.fn(),
    updateLineage: vi.fn(),
  } as unknown as ThreadRepo & { clearSdkSessionId: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

  const workspaceRepo = {
    findById: vi.fn(() => ({ id: "ws-1", path: "/workspace" })),
  } as unknown as WorkspaceRepo;

  // A prior message means nextSeq > 1, so the first attempt is a resume.
  const messageRepo = {
    listByThread: vi.fn(() => ({ messages: [{ id: "m0", sequence: 1, role: "user", content: "prev" }] })),
    create: vi.fn(() => ({ id: "msg-1", sequence: 2 })),
    findByIdInThread: vi.fn(),
    listByThreadUpToSequence: vi.fn(() => []),
  } as unknown as MessageRepo;

  const gitService = {
    resolveWorkingDir: vi.fn(() => "/workspace"),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;

  const providerRegistry = {
    resolve: vi.fn(() => providerEmitter),
    resolveAll: vi.fn(() => [providerEmitter]),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;

  const threadService = { create: vi.fn() } as unknown as ThreadService;
  const toolCallRecordRepo = { bulkCreate: vi.fn() } as unknown as ToolCallRecordRepo;
  const turnSnapshotRepo = {
    listByThread: vi.fn(() => []),
    create: vi.fn(),
  } as unknown as TurnSnapshotRepo;
  const snapshotService = {
    captureRef: vi.fn(() => Promise.resolve("abc123")),
    getFilesChanged: vi.fn(() => Promise.resolve([])),
  } as unknown as SnapshotService;
  const memoryPressureService = {
    markActive: vi.fn(),
    markIdle: vi.fn(),
    assertCanStartTurn: vi.fn(),
    onPressureChange: vi.fn(),
  } as unknown as MemoryPressureService;
  const taskRepo = { get: vi.fn(() => []), upsert: vi.fn() } as unknown as TaskRepo;
  const settingsService = {
    get: vi.fn(() => ({
      model: { defaults: { fallbackId: undefined } },
      agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      provider: { enabled: {}, cli: {} },
    })),
    on: vi.fn(),
  } as unknown as SettingsService;
  const availability = { assertUsable: vi.fn() } as unknown as ProviderAvailabilityService;
  const planQuestionAnswersRepo = {
    markAnswered: vi.fn(),
    isAnswered: vi.fn(() => false),
    listAnsweredForThread: vi.fn(() => []),
  } as unknown as PlanQuestionAnswersRepo;
  const threadControlMcp = { activate: vi.fn(), revoke: vi.fn(), close: vi.fn() };
  const mutationReservations = new ThreadControlMutationReservationService();
  const db = {
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
    prepare: vi.fn(() => ({ run: vi.fn() })),
  } as unknown as import("better-sqlite3").Database;

  const service = new AgentService(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService,
    providerRegistry,
    threadService,
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService,
    taskRepo,
    settingsService,
    availability,
    planQuestionAnswersRepo,
    { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../repositories/plan-repo.js").PlanRepo,
    { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as never,
    { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as never,
    new NarrativeStore(
      messageRepo,
      toolCallRecordRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/thought-segment-repo.js").ThoughtSegmentRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/hook-execution-repo.js").HookExecutionRepo,
    ),
    new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
    undefined,
    threadControlMcp as never,
    mutationReservations,
  );

  return {
    service,
    sendTurn,
    discardSession,
    waitForSessionExit,
    providerEmitter,
    threadRepo,
    threadControlMcp,
    mutationReservations,
  };
}

describe("AgentService transient-failure auto-retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a transient send failure once against a fresh session", async () => {
    const { service, sendTurn, discardSession, threadRepo } = buildService();
    service.init();
    sendTurn
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(sendTurn).toHaveBeenCalledTimes(2);
    // First attempt resumes the live session; the retry must drop it for a fresh spawn.
    expect((sendTurn.mock.calls[0][0] as TurnRequest).resumeFrom).toBe("sess-abc");
    expect((sendTurn.mock.calls[1][0] as TurnRequest).resumeFrom).toBeUndefined();
    // Dropping resumeFrom is not enough: the provider pools a warm session by
    // sessionName, so the retry must also force-evict it to truly spawn fresh.
    expect(discardSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
    expect(threadRepo.clearSdkSessionId).toHaveBeenCalledWith(THREAD_ID);
    expect(threadRepo.updateStatus).not.toHaveBeenCalledWith(THREAD_ID, "errored");
  });

  it("reactivates the same turn authority after retry discards its provider session", async () => {
    const { service, sendTurn, threadControlMcp } = buildService();
    service.init();
    sendTurn.mockRejectedValueOnce(new Error("read ECONNRESET")).mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "full",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(threadControlMcp.activate).toHaveBeenCalledTimes(2);
    expect(threadControlMcp.activate.mock.calls[1][0]).toMatchObject({
      sourceThreadId: THREAD_ID,
      sourceTurnId: threadControlMcp.activate.mock.calls[0][0].sourceTurnId,
      sourceProviderId: "claude",
      permissionMode: "full",
    });
  });

  it("does not retry a fatal send failure", async () => {
    const { service, sendTurn, discardSession, threadRepo } = buildService();
    service.init();
    sendTurn.mockRejectedValue(new Error("permission denied"));

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(discardSession).not.toHaveBeenCalled();
    expect(threadRepo.clearSdkSessionId).not.toHaveBeenCalled();
    expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "errored");
  });

  it("hides the failed attempt's transient error from the UI but keeps a fatal error visible", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    service.init();

    // Probe the suppression gate from inside the failing attempt — this is the
    // window during which the provider emits its mid-attempt Error event.
    let transientSuppressedDuringAttempt: boolean | undefined;
    let fatalSuppressedDuringAttempt: boolean | undefined;
    sendTurn
      .mockImplementationOnce(() => {
        transientSuppressedDuringAttempt = service.shouldSuppressTransientTurnError(THREAD_ID, "read ECONNRESET");
        fatalSuppressedDuringAttempt = service.shouldSuppressTransientTurnError(THREAD_ID, "permission denied");
        return Promise.reject(new Error("read ECONNRESET"));
      })
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // During the retried attempt: a transient error is swallowed, a fatal one is not.
    expect(transientSuppressedDuringAttempt).toBe(true);
    expect(fatalSuppressedDuringAttempt).toBe(false);
    // Fire-and-forget providers keep the window armed until TurnComplete.
    expect(service.shouldSuppressTransientTurnError(THREAD_ID, "read ECONNRESET")).toBe(true);
    providerEmitter.emit("event", { type: "turnComplete", threadId: THREAD_ID, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    expect(service.shouldSuppressTransientTurnError(THREAD_ID, "read ECONNRESET")).toBe(false);
  });

  it("swallows the failed attempt's trailing Ended so the UI's running state survives the retry", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    service.init();

    // Model the await-full-turn provider flow: stream, hit a mid-attempt
    // transient error (emitted through the provider), then reject so the loop
    // retries. The trailing `Ended` from that failed attempt must be armed for
    // suppression so it never tears down the spinner before the retry streams.
    let endedSuppressedDuringAttempt: boolean | undefined;
    sendTurn
      .mockImplementationOnce(() => {
        providerEmitter.emit("event", {
          type: "error",
          threadId: THREAD_ID,
          error: "read ECONNRESET",
        });
        endedSuppressedDuringAttempt = service.shouldSuppressTurnEnded(THREAD_ID);
        return Promise.reject(new Error("read ECONNRESET"));
      })
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // The trailing Ended was armed for suppression during the failed attempt...
    expect(endedSuppressedDuringAttempt).toBe(true);
    providerEmitter.emit("event", { type: "turnComplete", threadId: THREAD_ID, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    expect(service.shouldSuppressTurnEnded(THREAD_ID)).toBe(false);
  });

  it("does not arm Ended suppression for a fatal error (the spinner tears down)", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    service.init();

    let endedSuppressedDuringAttempt: boolean | undefined;
    sendTurn.mockImplementationOnce(() => {
      providerEmitter.emit("event", {
        type: "error",
        threadId: THREAD_ID,
        error: "permission denied",
      });
      endedSuppressedDuringAttempt = service.shouldSuppressTurnEnded(THREAD_ID);
      return Promise.reject(new Error("permission denied"));
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // A fatal error is not part of a retry window, so its Ended must reach the UI.
    expect(endedSuppressedDuringAttempt).toBe(false);
    expect(service.shouldSuppressTurnEnded(THREAD_ID)).toBe(false);
  });

  it("disarms suppression before the final give-up so the error still reaches the UI", async () => {
    const { service, sendTurn } = buildService();
    service.init();
    sendTurn.mockRejectedValue(new Error("read ECONNRESET"));

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // Give-up disarms the retry window so the terminal error is visible.
    expect(service.shouldSuppressTransientTurnError(THREAD_ID, "read ECONNRESET")).toBe(false);
  });

  it("swallows discardSession's trailing Ended when sendTurn rejects without emitting Error", async () => {
    const { service, sendTurn, discardSession, waitForSessionExit, providerEmitter } = buildService();
    service.init();

    let endedSuppressedWhenDiscardUnwinds: boolean | undefined;
    // Spawn-style failure: no provider Error, but discardSession unwinds a pooled
    // subprocess and emits Ended on the next tick while the retry catch runs.
    discardSession.mockImplementation(() => {
      queueMicrotask(() => {
        endedSuppressedWhenDiscardUnwinds = service.shouldSuppressTurnEnded(THREAD_ID);
        providerEmitter.emit("event", { type: "ended", threadId: THREAD_ID });
      });
    });
    waitForSessionExit.mockImplementation(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });
    sendTurn
      .mockRejectedValueOnce(new Error("spawn claude EAGAIN"))
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(discardSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
    expect(waitForSessionExit).toHaveBeenCalledWith(`mcode-${THREAD_ID}`, 5000);
    expect(endedSuppressedWhenDiscardUnwinds).toBe(true);
    providerEmitter.emit("event", { type: "turnComplete", threadId: THREAD_ID, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    expect(service.shouldSuppressTurnEnded(THREAD_ID)).toBe(false);
  });

  it("does not suppress a bare Ended for a normal in-flight turn (no transient retry armed)", async () => {
    const { service, sendTurn } = buildService();
    service.init();

    sendTurn.mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
      contextWindow: "1m",
    });

    // A bare `Ended` with no in-flight transient retry means the stream
    // genuinely ended; it must reach the cleanup path even though the
    // fire-and-forget retry window is still armed. The superseded session's
    // `Ended` during an internal recreation is suppressed at the provider
    // layer, not here, so this gate stays narrow.
    expect(service.shouldSuppressTurnEnded(THREAD_ID)).toBe(false);
  });

  it("disarms the retry window on a user stop so it can't re-dispatch or suppress later events", async () => {
    const { service, sendTurn } = buildService();
    service.init();
    sendTurn.mockResolvedValueOnce(undefined);

    // Fire-and-forget send leaves the retry window armed until TurnComplete.
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.shouldSuppressTransientTurnError(THREAD_ID, "read ECONNRESET")).toBe(true);

    // A user stop ends the turn via finalize; it must tear down the armed
    // window so a scheduled stream retry can't re-dispatch after the stop and
    // the suppression flags don't outlive into the next turn.
    await service.stopSession(THREAD_ID);

    expect(service.shouldSuppressTransientTurnError(THREAD_ID, "read ECONNRESET")).toBe(false);
  });

  it("fences a delayed stream retry from stop and a replacement turn", async () => {
    const { service, sendTurn, discardSession, providerEmitter, mutationReservations } = buildService();
    service.init();

    let releaseEviction!: () => void;
    let evictionStarted!: () => void;
    const evictionReady = new Promise<void>((resolve) => { evictionStarted = resolve; });
    const evictionReleased = new Promise<void>((resolve) => { releaseEviction = resolve; });
    discardSession.mockImplementation(async () => {
      evictionStarted();
      await evictionReleased;
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    providerEmitter.emit("event", {
      type: "error",
      threadId: THREAD_ID,
      error: "read ECONNRESET",
    });
    await evictionReady;

    await service.stopSession(THREAD_ID);
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "replacement",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const replacementReservation = mutationReservations.get(THREAD_ID);
    expect(replacementReservation?.state).toBe("activeTurn");

    releaseEviction();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(mutationReservations.get(THREAD_ID)).toEqual(replacementReservation);
  });

  it("retries when sendTurn resolves early then a transient stream Error arrives", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    service.init();

    sendTurn
      .mockImplementationOnce(async () => {
        // Fire-and-forget: resolve before the stream error.
      })
      .mockResolvedValueOnce(undefined);

    const sendPromise = service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await sendPromise;

    providerEmitter.emit("event", {
      type: "error",
      threadId: THREAD_ID,
      error: "read ECONNRESET",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect((sendTurn.mock.calls[1][0] as TurnRequest).resumeFrom).toBeUndefined();
  });

  it("swallows a failed attempt's TurnComplete during the retry window", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    service.init();

    let turnCompleteSuppressedDuringAttempt: boolean | undefined;
    sendTurn
      .mockImplementationOnce(() => {
        providerEmitter.emit("event", {
          type: "error",
          threadId: THREAD_ID,
          error: "read ECONNRESET",
        });
        providerEmitter.emit("event", {
          type: "turnComplete",
          threadId: THREAD_ID,
          reason: "end_turn",
          costUsd: null,
          tokensIn: 0,
          tokensOut: 0,
        });
        turnCompleteSuppressedDuringAttempt = service.shouldSuppressTurnComplete(THREAD_ID);
        return Promise.reject(new Error("read ECONNRESET"));
      })
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(turnCompleteSuppressedDuringAttempt).toBe(true);
    providerEmitter.emit("event", { type: "turnComplete", threadId: THREAD_ID, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    expect(service.shouldSuppressTurnComplete(THREAD_ID)).toBe(false);
  });

  it("stops retrying at the attempt cap when a transient signature keeps failing", async () => {
    const { service, sendTurn, threadRepo } = buildService();
    service.init();
    sendTurn.mockRejectedValue(new Error("read ECONNRESET"));

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // Cap is 2: one original attempt plus one retry, then it gives up.
    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "errored");
  });
});
