import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventType } from "@mcode/contracts";
import type {
  AgentEvent,
  AttachmentMeta,
  IProviderRegistry,
  PreviewAnnotationBundle,
  Thread,
} from "@mcode/contracts";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../store/database.js";
import { ThreadRepo as RealThreadRepo } from "../../../../repositories/thread-repo.js";
import { WorkspaceRepo as RealWorkspaceRepo } from "../../../../repositories/workspace-repo.js";
import { MessageRepo as RealMessageRepo } from "../../../../repositories/message-repo.js";
import { ToolCallRecordRepo as RealToolCallRecordRepo } from "../../../../repositories/tool-call-record-repo.js";
import { ThoughtSegmentRepo as RealThoughtSegmentRepo } from "../../../../repositories/thought-segment-repo.js";
import { HookExecutionRepo as RealHookExecutionRepo } from "../../../../repositories/hook-execution-repo.js";
import { AgentService } from "../agent-service.js";
import { createCanonicalAgentEventSinkStub } from "../../../../test-utils/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../../../../services/narrative-store.js";
import { PlanQuestionService } from "../../../../services/plan-question-service.js";
import { broadcast } from "../../../../transport/push.js";
import type { ThreadRepo } from "../../../../repositories/thread-repo.js";
import type { WorkspaceRepo } from "../../../../repositories/workspace-repo.js";
import type { MessageRepo } from "../../../../repositories/message-repo.js";
import type { GitService } from "../../../../services/git-service.js";
import type { AttachmentService } from "../../../../services/attachment-service.js";
import type { ToolCallRecordRepo } from "../../../../repositories/tool-call-record-repo.js";
import type { TurnSnapshotRepo } from "../../../../repositories/turn-snapshot-repo.js";
import type { SnapshotService } from "../../../../services/snapshot-service.js";
import type { MemoryPressureService } from "../../../../services/memory-pressure-service.js";
import type { TaskRepo } from "../../../../repositories/task-repo.js";
import type { SettingsService } from "../../../../services/settings-service.js";
import type { ThreadService } from "../../../../services/thread-service.js";
import type { ProviderAvailabilityService } from "../../../../services/provider-availability-service.js";
import type { PlanQuestionAnswersRepo } from "../../../../repositories/plan-question-answers-repo.js";
import { ThreadControlMutationReservationService } from "../../../../services/thread-control-mutation-reservation-service.js";

vi.mock("../../../../transport/push.js", () => ({ broadcast: vi.fn() }));

// Mock fs so sendMessage's cwd validation passes without a real directory
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

const THREAD_ID = "thread-cleanup-test";

function activeExecutionId(service: AgentService, threadId = THREAD_ID): string {
  const executionId = service.runtimeSnapshots().find((snapshot) => snapshot.threadId === threadId)?.turnExecutionId;
  if (!executionId) throw new Error("Expected an active turn execution identity");
  return executionId;
}

function startProviderTurn(service: AgentService): string {
  const runtime = (service as unknown as {
    turnRuntime: { start: (threadId: string) => { turnExecutionId: string } };
  }).turnRuntime;
  return runtime.start(THREAD_ID).turnExecutionId;
}

/** Create a minimal Thread fixture with sensible defaults for turn cleanup tests. */
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
    sdk_session_id: null,
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
    user_completed_at: null,
    scheduled_deletion_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Thread;
}

function makePreviewAnnotationBundle(): PreviewAnnotationBundle {
  const capture = {
    schemaVersion: 2 as const,
    pageUrl: "https://www.google.com/",
    pageTitle: "Google",
    capturedAt: "2026-07-02T00:00:00.000Z",
    captureKind: "element" as const,
    selectorHint: "html",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    layoutViewport: { width: 1280, height: 720 },
  };

  return {
    schemaVersion: 1,
    annotations: [
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        displayNumber: 1,
        pageIdentity: "https://www.google.com/",
        pageContext: capture,
        targetContext: {
          label: "html",
          selectorHint: "html",
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
        },
        note: "Move the header down.",
        snapshot: {
          id: "annotation-shot-1",
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          sourcePath: "C:/tmp/annotation-shot-1.png",
          capture,
        },
      },
    ],
  };
}

/**
 * Build a minimal AgentService wired to a fake EventEmitter-based provider.
 * The returned `providerEmitter` lets the test fire events as if the SDK
 * produced them, exercising the handler registered in `init()`.
 */
function buildService(
  cwd = process.cwd(),
  mutationReservations = new ThreadControlMutationReservationService(),
): {
  service: AgentService;
  providerEmitter: EventEmitter;
  attachmentService: AttachmentService;
  messageRepo: MessageRepo;
  memoryPressureService: { markActive: ReturnType<typeof vi.fn>; markIdle: ReturnType<typeof vi.fn> };
  snapshotService: { captureRef: ReturnType<typeof vi.fn> };
  turnSnapshotRepo: { create: ReturnType<typeof vi.fn> };
  toolCallRecordRepo: { bulkCreate: ReturnType<typeof vi.fn> };
} {
  const thread = makeThread();
  const providerEmitter = new EventEmitter();

  // sendTurn() is called on the resolved provider
  (providerEmitter as any).sendTurn = vi.fn(() => Promise.resolve());
  (providerEmitter as any).stopSession = vi.fn(() => Promise.resolve());

  const threadRepo = {
    findById: vi.fn(() => thread),
    updateStatus: vi.fn((_threadId: string, status: Thread["status"]) => {
      thread.status = status;
    }),
    updateModel: vi.fn(),
    updateProvider: vi.fn(),
    updateSettings: vi.fn(),
    create: vi.fn(),
    softDelete: vi.fn(),
    updateWorktreePath: vi.fn(),
    updateContextUsage: vi.fn(),
    updateSdkSessionId: vi.fn(),
    updateCompactSummary: vi.fn(),
    updateLineage: vi.fn(),
  } as unknown as ThreadRepo;

  const workspaceRepo = {
    findById: vi.fn(() => ({ id: "ws-1", path: cwd })),
  } as unknown as WorkspaceRepo;

  let assistantMessageCount = 0;
  let latestSequence = 0;
  const messageRepo = {
    listByThread: vi.fn(() => ({ messages: [] })),
    getLatestSequenceIncludingInternal: vi.fn(() => latestSequence),
    create: vi.fn((_threadId: string, _role: string, _content: string, sequence: number) => {
      latestSequence = Math.max(latestSequence, sequence);
      return { id: "msg-1", sequence };
    }),
    findByIdInThread: vi.fn(),
    listByThreadUpToSequence: vi.fn(() => []),
    createAssistantIdempotent: vi.fn((input: { id: string; content: string; sequence: number }) => {
      latestSequence = Math.max(latestSequence, input.sequence);
      return {
        id: `assistant-${++assistantMessageCount}`,
        sequence: input.sequence,
        content: input.content,
      };
    }),
  } as unknown as MessageRepo;

  const gitService = {
    resolveWorkingDir: vi.fn(() => cwd),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn((_threadId: string, attachments: AttachmentMeta[]) =>
      Promise.resolve({
        stored: attachments.map((att) => ({
          id: att.id,
          name: att.name,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
        })),
        persisted: attachments,
      }),
    ),
  } as unknown as AttachmentService;

  // The provider must be an EventEmitter so init() can subscribe via
  // provider.on("event", ...) and tests can fire events via providerEmitter.emit()
  const providerRegistry = {
    resolve: vi.fn(() => providerEmitter),
    resolveAll: vi.fn(() => [providerEmitter]),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;

  const threadService = {
    create: vi.fn(),
  } as unknown as ThreadService;

  const bulkCreateToolCalls = vi.fn();
  const toolCallRecordRepo = {
    bulkCreate: bulkCreateToolCalls,
    bulkCreateBatched: bulkCreateToolCalls,
  } as unknown as ToolCallRecordRepo;

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

  const taskRepo = {
    get: vi.fn(() => []),
    upsert: vi.fn(),
  } as unknown as TaskRepo;

  const settingsService = {
    get: vi.fn(() => ({
      model: { defaults: { fallbackId: undefined } },
      agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      provider: { enabled: {}, cli: {} },
    })),
    on: vi.fn(),
  } as unknown as SettingsService;

  const availability = {
    assertUsable: vi.fn(),
  } as unknown as ProviderAvailabilityService;

  const planQuestionAnswersRepo = {
    markAnswered: vi.fn(),
    isAnswered: vi.fn(() => false),
    listAnsweredForThread: vi.fn(() => []),
  } as unknown as PlanQuestionAnswersRepo;

  const db = {
    // better-sqlite3's transaction() returns a wrapped function; calling it executes the callback
    transaction: vi.fn((fn: Function) => fn),
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
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../../../repositories/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService as MemoryPressureService,
    taskRepo,
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../../../repositories/plan-repo.js").PlanRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../../../repositories/thought-segment-repo.js").ThoughtSegmentRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../../../repositories/hook-execution-repo.js").HookExecutionRepo,
      ),
      new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
      undefined,
      undefined,
      mutationReservations,
      createCanonicalAgentEventSinkStub(db),
  );

  return {
    service,
    providerEmitter,
    attachmentService,
    messageRepo,
    memoryPressureService: memoryPressureService as MemoryPressureService & { markActive: ReturnType<typeof vi.fn>; markIdle: ReturnType<typeof vi.fn> },
    snapshotService: snapshotService as SnapshotService & { captureRef: ReturnType<typeof vi.fn> },
    turnSnapshotRepo: turnSnapshotRepo as TurnSnapshotRepo & { create: ReturnType<typeof vi.fn> },
    toolCallRecordRepo: toolCallRecordRepo as ToolCallRecordRepo & { bulkCreate: ReturnType<typeof vi.fn> },
  };
}

describe("AgentService turn cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one provider event listener and forwards each normalized event once", () => {
    const { service, providerEmitter } = buildService();
    const publish = vi.fn();
    service.init(publish);

    expect(providerEmitter.listenerCount("event")).toBe(1);

    const event = {
      type: AgentEventType.ProviderUnavailable,
      threadId: THREAD_ID,
      providerId: "claude",
      reason: "disabled",
    } satisfies AgentEvent;
    providerEmitter.emit("event", event);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);
  });

  it("forwards normalized events even when internal continuation validation returns early", async () => {
    const { service, providerEmitter } = buildService();
    const publish = vi.fn();
    service.init(publish);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const executionId = activeExecutionId(service);
    publish.mockClear();
    vi.spyOn(
      service as unknown as { startCodexProviderContinuationFromEvent: () => boolean },
      "startCodexProviderContinuationFromEvent",
    ).mockReturnValue(false);

    const event = {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      codexContinuation: {
        sourceNativeThreadId: "missing-source-thread",
        sourceNativeTurnId: "missing-source-turn",
        sourceNativeItemId: "missing-source-item",
        targetNativeThreadId: "missing-target-thread",
      },
    } satisfies AgentEvent;
    providerEmitter.emit("event", event);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);
  });

  it("publishes once before a provider-event barrier replay", async () => {
    const { service, providerEmitter } = buildService();
    const publish = vi.fn();
    service.init(publish);
    const executionId = startProviderTurn(service);

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const eventState = service as unknown as {
      providerEventBarrierByThread: Map<string, Promise<void>>;
    };
    eventState.providerEventBarrierByThread.set(THREAD_ID, barrier);

    const event = {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    } satisfies AgentEvent;
    providerEmitter.emit("event", event);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);

    releaseBarrier();
    await barrier;
    await Promise.resolve();
    await Promise.resolve();

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not publish when internal event handling throws", async () => {
    const { service, providerEmitter } = buildService();
    const publish = vi.fn();
    service.init(publish);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const executionId = activeExecutionId(service);
    publish.mockClear();
    vi.spyOn(
      service as unknown as { startCodexChildFromProviderEvent: () => void },
      "startCodexChildFromProviderEvent",
    ).mockImplementation(() => {
      throw new Error("internal event failure");
    });

    const event = {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "tool-1",
      toolName: "Agent",
      toolInput: { codexCollabKind: "spawnAgent", prompt: "delegate" },
    } satisfies AgentEvent;

    expect(() => providerEmitter.emit("event", event)).toThrow("internal event failure");
    expect(publish).not.toHaveBeenCalled();
  });

  it("removes thread from activeThreadIds on TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    // sendMessage adds thread to activeSessionIds and emits TurnStarted
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(service.activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    // Fire TurnComplete through the provider
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 100,
      tokensOut: 50,
      contextWindow: 200000,
      totalProcessedTokens: 150,
      providerId: "claude",
    } satisfies AgentEvent);

    // Thread should no longer be active
    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });

  it("ignores a late TurnStarted after stop instead of auto-resuming the thread", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await service.stopSession(THREAD_ID);
    expect(service.activeThreadIds()).not.toContain(THREAD_ID);

    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
    } satisfies AgentEvent);

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markActive).toHaveBeenCalledTimes(1);
  });

  it("keeps exact turn running when provider stop fails, then cancels on retry", async () => {
    const { service, providerEmitter } = buildService();
    service.init();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as EventEmitter & { stopSession: ReturnType<typeof vi.fn> };
    provider.stopSession.mockRejectedValueOnce(new Error("stop unavailable"));

    await expect(service.stopSession(THREAD_ID)).rejects.toThrow("stop unavailable");
    expect(service.activeThreadIds()).toContain(THREAD_ID);

    provider.stopSession.mockResolvedValueOnce(undefined);
    const result = await service.stopSession(THREAD_ID);
    expect(result.status).toBe("cancelled");
    expect(result.dispatchState).toBe("dispatched");
    expect(result.snapshot).toMatchObject({ threadId: THREAD_ID, phase: "cancelled" });
    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
  });

  it("cancels during delayed setup without dispatching after setup resumes", async () => {
    const { service, providerEmitter, attachmentService } = buildService();
    service.init();
    let releaseSetup!: () => void;
    const setupReady = new Promise<void>((resolve) => { releaseSetup = resolve; });
    (attachmentService.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(() => (
      setupReady.then(() => ({ stored: [], persisted: [] }))
    ));

    const send = service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await vi.waitFor(() => expect(service.activeThreadIds()).toContain(THREAD_ID));

    const result = await service.stopSession(THREAD_ID);
    expect(result.status).toBe("cancelled");
    expect(result.dispatchState).toBe("not-dispatched");
    expect((providerEmitter as EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .not.toHaveBeenCalled();

    const replacement = service.sendMessage({
      threadId: THREAD_ID,
      content: "replacement",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await replacement;
    expect(service.activeThreadIds()).toContain(THREAD_ID);

    releaseSetup();
    await send;
    expect((providerEmitter as EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .toHaveBeenCalledTimes(1);
  });

  it("terminalizes setup failure after reserving runtime authority", async () => {
    const { service, providerEmitter, attachmentService } = buildService();
    service.init();
    (attachmentService.persist as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("attachment setup failed"),
    );

    await expect(service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    })).rejects.toThrow("attachment setup failed");
    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(service.runtimeSnapshots()).toEqual([
      expect.objectContaining({ threadId: THREAD_ID, phase: "errored" }),
    ]);
    expect((providerEmitter as EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .not.toHaveBeenCalled();
  });

  it("shares one successful provider stop across concurrent callers", async () => {
    const { service, providerEmitter } = buildService();
    service.init();
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    let releaseStop!: () => void;
    provider.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));

    const first = service.stopSession(THREAD_ID);
    const second = service.stopSession(THREAD_ID);
    releaseStop();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.status).toBe("cancelled");
  });

  it("shares provider stop failure, then retries after single-flight clears", async () => {
    const { service, providerEmitter } = buildService();
    service.init();
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    provider.stopSession.mockRejectedValueOnce(new Error("stop unavailable"));
    const first = service.stopSession(THREAD_ID);
    const second = service.stopSession(THREAD_ID);
    await expect(first).rejects.toThrow("stop unavailable");
    await expect(second).rejects.toThrow("stop unavailable");
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(service.activeThreadIds()).toContain(THREAD_ID);

    provider.stopSession.mockResolvedValueOnce(undefined);
    const retry = await service.stopSession(THREAD_ID);
    expect(retry.status).toBe("cancelled");
    expect(provider.stopSession).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate finalization when completion wins during stop", async () => {
    const { service, providerEmitter } = buildService();
    service.init();
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const runtime = service.runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID);
    const executionId = runtime?.turnExecutionId;
    expect(executionId).toBeTruthy();
    if (!executionId) throw new Error("turn execution identity missing");
    const provider = providerEmitter as EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    let releaseStop!: () => void;
    provider.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));

    const stopping = service.stopSession(THREAD_ID);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      contextWindow: 200000,
      totalProcessedTokens: 2,
      providerId: "claude",
    } satisfies AgentEvent);
    releaseStop();
    const result = await stopping;
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("already-terminal");
    expect(result.snapshot).toMatchObject({ threadId: THREAD_ID, phase: "completed" });
  });

  it("persists preview annotation snapshots as visible provider attachments", async () => {
    const { service, providerEmitter, attachmentService, messageRepo } = buildService();
    const bundle = makePreviewAnnotationBundle();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "fix this",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
      mentions: [],
      previewAnnotations: bundle,
    });

    const expectedAttachment = {
      id: "annotation-shot-1",
      name: "Annotation 1 screenshot.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      sourcePath: "C:/tmp/annotation-shot-1.png",
    };

    expect(attachmentService.persist).toHaveBeenCalledWith(THREAD_ID, [
      expectedAttachment,
    ]);
    expect(messageRepo.create).toHaveBeenCalledWith(
      THREAD_ID,
      "user",
      "fix this",
      1,
      [
        {
          id: "annotation-shot-1",
          name: "Annotation 1 screenshot.png",
          mimeType: "image/png",
          sizeBytes: 2048,
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bundle,
    );
    expect((providerEmitter as any).sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expectedAttachment],
      }),
    );
  });

  it("does NOT remove thread from activeThreadIds on TurnComplete during compaction", async () => {
    const { service, providerEmitter } = buildService();
    service.init();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.activeThreadIds()).toContain(THREAD_ID);

    // Start compaction first
    providerEmitter.emit("event", {
      type: AgentEventType.Compacting,
      threadId: THREAD_ID,
      active: true,
    } satisfies AgentEvent);

    // Fire TurnComplete during compaction
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 100,
      tokensOut: 50,
      contextWindow: 200000,
      totalProcessedTokens: 150,
      providerId: "claude",
    } satisfies AgentEvent);

    // Thread should STILL be active (compaction guard)
    expect(service.activeThreadIds()).toContain(THREAD_ID);
  });

  it("re-adds thread to activeThreadIds on TurnStarted after TurnComplete (auto-resume)", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    // Turn completes, thread removed from active
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 100,
      tokensOut: 50,
      contextWindow: 200000,
      totalProcessedTokens: 150,
      providerId: "claude",
    } satisfies AgentEvent);

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);

    // SDK auto-resumes: TurnStarted fires from stream loop
    memoryPressureService.markActive.mockClear();
    const resumedExecutionId = startProviderTurn(service);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: resumedExecutionId,
    } satisfies AgentEvent);

    // The resumed turn becomes active after prior-turn persistence releases its barrier.
    await vi.waitFor(() => {
      expect(service.activeThreadIds()).toContain(THREAD_ID);
      expect(memoryPressureService.markActive).toHaveBeenCalled();
    });
  });

  it("aborts an auto-resumed turn when a pending mutation reservation owns the thread", async () => {
    const mutationReservations = new ThreadControlMutationReservationService();
    const { service, providerEmitter } = buildService(process.cwd(), mutationReservations);
    const provider = providerEmitter as EventEmitter & { stopSession: ReturnType<typeof vi.fn> };
    service.init();

    expect(mutationReservations.rehydrate(THREAD_ID, "pending-approval")).toBe(true);
    const resumedExecutionId = startProviderTurn(service);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: resumedExecutionId,
    } satisfies AgentEvent);

    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`));
    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
      turnExecutionId: resumedExecutionId,
    } satisfies AgentEvent);
    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(mutationReservations.owns(THREAD_ID, "pending-approval", "pendingApproval")).toBe(true);
  });

  it("initializes file tracking for provider-originated auto-resumed turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-auto-resume-tracker-"));
    try {
      await writeFile(join(root, "tracked.txt"), "before\n");
      const {
        service,
        providerEmitter,
        snapshotService,
        turnSnapshotRepo,
      } = buildService(root);
      service.init();
      const resumedExecutionId = startProviderTurn(service);
      snapshotService.captureRef.mockClear();
      const internals = service as unknown as {
        turnFileTracker: { observeToolUse: (...args: unknown[]) => Promise<void> };
      };
      const observeToolUse = vi.spyOn(internals.turnFileTracker, "observeToolUse");

      providerEmitter.emit("event", {
        type: AgentEventType.TurnStarted,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
        toolCallId: "auto-edit",
        toolName: "Edit",
        toolInput: { file_path: "tracked.txt" },
      } satisfies AgentEvent);
      await vi.waitFor(() => expect(observeToolUse).toHaveBeenCalledOnce());
      await observeToolUse.mock.results[0]!.value;

      await writeFile(join(root, "tracked.txt"), "after\n");
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
        toolCallId: "auto-edit",
        output: "updated",
        isError: false,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
        contextWindow: 200000,
        totalProcessedTokens: 2,
        providerId: "claude",
      } satisfies AgentEvent);

      await vi.waitFor(() => expect(turnSnapshotRepo.create).toHaveBeenCalledOnce());
      expect(snapshotService.captureRef).toHaveBeenCalledWith(root);
      expect(turnSnapshotRepo.create.mock.calls[0]![0]).toMatchObject({
        fileEffects: {
          fileCount: 1,
          effects: [expect.objectContaining({
            path: "tracked.txt",
            kind: "edited",
            scope: "workspace",
          })],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps overlapping auto-resumed generations isolated until prior persistence finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-auto-resume-overlap-"));
    try {
      await writeFile(join(root, "first.txt"), "before first\n");
      await writeFile(join(root, "second.txt"), "before second\n");
      const {
        service,
        providerEmitter,
        turnSnapshotRepo,
        toolCallRecordRepo,
      } = buildService(root);
      service.init();
      const tracker = (service as unknown as {
        turnFileTracker: {
          observeToolUse: (...args: unknown[]) => Promise<void>;
          observeToolResult: (...args: unknown[]) => Promise<void>;
        };
      }).turnFileTracker;
      const observeToolUse = vi.spyOn(tracker, "observeToolUse");
      const firstExecutionId = startProviderTurn(service);
      const originalObserveToolResult = tracker.observeToolResult.bind(tracker);
      let releaseFirstResult!: () => void;
      const firstResultGate = new Promise<void>((resolve) => {
        releaseFirstResult = resolve;
      });
      let resultCount = 0;
      vi.spyOn(tracker, "observeToolResult").mockImplementation(async (...args) => {
        resultCount += 1;
        if (resultCount === 1) await firstResultGate;
        await originalObserveToolResult(...args);
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TurnStarted,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
        toolCallId: "first-edit",
        toolName: "Edit",
        toolInput: { file_path: "first.txt" },
      } satisfies AgentEvent);
      await vi.waitFor(() => expect(observeToolUse).toHaveBeenCalledTimes(1));
      await observeToolUse.mock.results[0]!.value;
      await writeFile(join(root, "first.txt"), "after first\n");
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
        toolCallId: "first-edit",
        output: "updated",
        isError: false,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
        contextWindow: 200000,
        totalProcessedTokens: 2,
        providerId: "claude",
      } satisfies AgentEvent);

      const secondExecutionId = startProviderTurn(service);
      providerEmitter.emit("event", {
        type: AgentEventType.TurnStarted,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        toolCallId: "second-edit",
        toolName: "Edit",
        toolInput: { file_path: "second.txt" },
      } satisfies AgentEvent);
      await writeFile(join(root, "second.txt"), "after second\n");
      providerEmitter.emit("event", {
        type: AgentEventType.Message,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        content: "second turn complete",
        tokens: null,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        toolCallId: "second-edit",
        output: "updated",
        isError: false,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
        contextWindow: 200000,
        totalProcessedTokens: 2,
        providerId: "claude",
      } satisfies AgentEvent);
      await vi.waitFor(() => expect(observeToolUse).toHaveBeenCalledTimes(2));
      expect(turnSnapshotRepo.create).not.toHaveBeenCalled();

      releaseFirstResult();
      await vi.waitFor(() => expect(turnSnapshotRepo.create).toHaveBeenCalledTimes(2));
      const firstSnapshot = turnSnapshotRepo.create.mock.calls[0]![0];
      const secondSnapshot = turnSnapshotRepo.create.mock.calls[1]![0];
      expect(firstSnapshot.fileEffects.effects.map((effect: { path: string }) => effect.path)).toEqual(["first.txt"]);
      expect(secondSnapshot.fileEffects.effects.map((effect: { path: string }) => effect.path)).toEqual(["second.txt"]);
      expect(toolCallRecordRepo.bulkCreate).toHaveBeenCalledTimes(2);
      expect(toolCallRecordRepo.bulkCreate.mock.calls[0]![0]).toEqual([
        expect.objectContaining({
          toolCallId: "first-edit",
          messageId: firstSnapshot.messageId,
        }),
      ]);
      expect(toolCallRecordRepo.bulkCreate.mock.calls[1]![0]).toEqual([
        expect.objectContaining({
          toolCallId: "second-edit",
          messageId: secondSnapshot.messageId,
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-add thread after an Error event following TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    // Turn completes, thread removed
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 100,
      tokensOut: 50,
      contextWindow: 200000,
      totalProcessedTokens: 150,
      providerId: "claude",
    } satisfies AgentEvent);

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);

    // Error event should not re-add the thread
    memoryPressureService.markActive.mockClear();
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      error: "Something went wrong",
    } satisfies AgentEvent);

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markActive).not.toHaveBeenCalled();
  });

  it("removes thread from activeThreadIds on Ended event", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    } satisfies AgentEvent);

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });
});

describe("AgentService Ended finalization", () => {
  let db: Database.Database;
  let threadRepo: RealThreadRepo;
  let workspaceRepo: RealWorkspaceRepo;
  let messageRepo: RealMessageRepo;
  let providerEmitter: EventEmitter & { sendTurn: ReturnType<typeof vi.fn>; stopSession: ReturnType<typeof vi.fn> };
  let service: AgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openMemoryDatabase();
    threadRepo = new RealThreadRepo(db);
    workspaceRepo = new RealWorkspaceRepo(db);
    messageRepo = new RealMessageRepo(db);
    const toolCallRecordRepo = new RealToolCallRecordRepo(db);
    const thoughtSegmentRepo = new RealThoughtSegmentRepo(db);
    const hookExecutionRepo = new RealHookExecutionRepo(db);
    providerEmitter = Object.assign(new EventEmitter(), {
      sendTurn: vi.fn(() => Promise.resolve()),
      stopSession: vi.fn(),
      shutdown: vi.fn(),
    });

    const providerRegistry = {
      resolve: vi.fn(() => providerEmitter),
      resolveAll: vi.fn(() => [providerEmitter]),
      shutdown: vi.fn(),
    } as unknown as IProviderRegistry;
    const gitService = {
      resolveWorkingDir: vi.fn(() => process.cwd()),
      listWorktrees: vi.fn(() => []),
    } as unknown as GitService;
    const attachmentService = {
      persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
    } as unknown as AttachmentService;
    const snapshotService = {
      captureRef: vi.fn(() => Promise.resolve("ref-before")),
      getFilesChanged: vi.fn(() => Promise.resolve([])),
    } as unknown as SnapshotService;
    const memoryPressureService = {
      markActive: vi.fn(),
      markIdle: vi.fn(),
      assertCanStartTurn: vi.fn(),
      onPressureChange: vi.fn(),
    } as unknown as MemoryPressureService;
    const settingsService = {
      get: vi.fn(() => ({
        model: { defaults: { fallbackId: undefined } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
        provider: { enabled: {}, cli: {} },
      })),
      on: vi.fn(),
    } as unknown as SettingsService;
    const planQuestionAnswersRepo = {
      markAnswered: vi.fn(),
      isAnswered: vi.fn(() => false),
      listAnsweredForThread: vi.fn(() => []),
    } as unknown as PlanQuestionAnswersRepo;

    service = new AgentService(
      threadRepo,
      workspaceRepo,
      messageRepo,
      gitService,
      attachmentService,
      providerRegistry,
      { create: vi.fn() } as unknown as ThreadService,
      hookExecutionRepo,
      { listByThread: vi.fn(() => []), create: vi.fn() } as unknown as TurnSnapshotRepo,
      snapshotService,
      db,
      memoryPressureService,
      { get: vi.fn(() => []), upsert: vi.fn() } as unknown as TaskRepo,
      settingsService,
      { assertUsable: vi.fn() } as unknown as ProviderAvailabilityService,
      planQuestionAnswersRepo,
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../../../repositories/plan-repo.js").PlanRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(messageRepo, toolCallRecordRepo, thoughtSegmentRepo, hookExecutionRepo),
      new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
      undefined,
      undefined,
      undefined,
      createCanonicalAgentEventSinkStub(db),
    );
    service.init();
  });

  it("persists partial assistant text when a running turn ends with only Ended", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Test thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "please investigate",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.Message,
      threadId: thread.id,
      turnExecutionId: executionId,
      content: "partial answer before the provider stopped",
      tokens: null,
    } satisfies AgentEvent);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
    } satisfies AgentEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { messages } = messageRepo.listByThread(thread.id, 10);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("partial answer before the provider stopped");
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      messageId: assistant?.id,
    }));
  });

  it("does not infer cancellation from a bare Ended event for non-Codex providers", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Test thread", "direct", "main", true, "cursor");

    await service.sendMessage({
      threadId: thread.id,
      content: "please investigate",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "cursor",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: thread.id,
      delta: "partial cursor text",
      isFinalResponse: false,
    } satisfies AgentEvent);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
    } satisfies AgentEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { messages } = messageRepo.listByThread(thread.id, 10);
    expect(messages.some((message) =>
      message.role === "assistant" && message.content === "partial cursor text",
    )).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.anything());
  });
});
