import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as NodeEvents from "node:events";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AgentEventType,
  createAgentModelState,
  reduceAgentEventBatch,
  type CanonicalAgentEventEnvelope,
} from "@mcode/contracts";
import type {
  AgentEvent,
  AttachmentMeta,
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
  PreviewAnnotationBundle,
  Thread,
  TurnRequest,
  ProviderTurnDiffUpdate,
} from "@mcode/contracts";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo as RealThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo as RealWorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo as RealMessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo as RealToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo as RealThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo as RealHookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { AgentService } from "../agent-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import {
  createAgentServiceForTest,
  turnDiffsForAgentServiceTest,
  fileTrackerForAgentServiceTest,
  startAgentServiceIngressForTest,
  startProviderTurnForTest,
  wrapProviderEmitterForRuntimeEvents,
} from "./agent-service-test-harness.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import { CanonicalAgentEventSink } from "../../canonical/canonical-agent-event-sink.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import type { MessageRepo } from "../../conversation/persistence/message-repo.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import type { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import type { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { publishParentProviderEvent } from "../../events/provider-event-publication.js";
import { SubagentLifecycleService } from "../../collaboration/subagent-lifecycle-service.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

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
  const executionId = service.runtimeAccess().runtimeSnapshots()
    .find((snapshot) => snapshot.threadId === threadId)?.turnExecutionId;
  if (!executionId) throw new Error("Expected an active turn execution identity");
  return executionId;
}

function startProviderTurn(service: AgentService): string {
  return startProviderTurnForTest(service, THREAD_ID);
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
  providers?: IAgentProvider[],
): {
  service: AgentService;
  providerEmitter: NodeEvents.EventEmitter;
  attachmentService: AttachmentService;
  messageRepo: MessageRepo;
  planQuestionAnswersRepo: { markAnswered: ReturnType<typeof vi.fn> };
  memoryPressureService: { markActive: ReturnType<typeof vi.fn>; markIdle: ReturnType<typeof vi.fn> };
  snapshotService: { captureRef: ReturnType<typeof vi.fn> };
  turnSnapshotRepo: { create: ReturnType<typeof vi.fn> };
  toolCallRecordRepo: { bulkCreate: ReturnType<typeof vi.fn> };
} {
  const thread = makeThread();
  const providerEmitter = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
    id: "claude" as ProviderId,
  }));
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
    setAssistantOutcome: vi.fn(),
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
    removeStoredAttachments: vi.fn(async () => undefined),
  } as unknown as AttachmentService;

  // The provider must be an EventEmitter so init() can subscribe via
  // provider.on("event", ...) and tests can fire events via providerEmitter.emit()
  const registeredProviders = providers ?? [providerEmitter as unknown as IAgentProvider];
  const providerRegistry = {
    resolve: vi.fn((providerId: ProviderId) => (
      registeredProviders.find((provider) => provider.id === providerId) ?? providerEmitter
    )),
    resolveAll: vi.fn(() => registeredProviders),
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
    name: ":memory:",
    // better-sqlite3's transaction() returns a wrapped function; calling it executes the callback
    transaction: vi.fn((fn: Function) => fn),
    prepare: vi.fn(() => ({ run: vi.fn() })),
  } as unknown as import("better-sqlite3").Database;

  const service = createAgentServiceForTest(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService,
    providerRegistry,
    threadService,
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService as MemoryPressureService,
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../conversation/narrative/persistence/thought-segment-repo.js").ThoughtSegmentRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
      ),
      new ParentAssistantTextCheckpointService(db),
      undefined,
      undefined,
      mutationReservations,
      createCanonicalAgentEventSinkStub(db),
      undefined,
      undefined,
  );

  return {
    service,
    providerEmitter,
    attachmentService,
    messageRepo,
    planQuestionAnswersRepo: planQuestionAnswersRepo as { markAnswered: ReturnType<typeof vi.fn> },
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

  it("retains provider subscriptions through the provider ingress", () => {
    const legacyProvider = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
      id: "claude" as ProviderId,
    })) as unknown as IAgentProvider;
    const { service } = buildService(
      process.cwd(),
      new ThreadControlMutationReservationService(),
      [legacyProvider],
    );
    const publish = vi.fn();
    startAgentServiceIngressForTest(service, publish);
    startAgentServiceIngressForTest(service, publish);

    expect((legacyProvider as unknown as NodeEvents.EventEmitter).listenerCount("event")).toBe(1);

    const providerEvent = {
      type: AgentEventType.ProviderUnavailable,
      threadId: THREAD_ID,
      providerId: "claude",
      reason: "disabled",
    } satisfies AgentEvent;
    (legacyProvider as unknown as NodeEvents.EventEmitter).emit("event", providerEvent);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(providerEvent);
  });

  it("forwards a generic runtime event", async () => {
    const { service, providerEmitter } = buildService();
    const publish = vi.fn();
    startAgentServiceIngressForTest(service, publish);

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
    const event = {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    } satisfies AgentEvent;
    providerEmitter.emit("event", event);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);
  });

  it("removes thread from activeThreadIds on TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    startAgentServiceIngressForTest(service, );

    // sendMessage adds thread to activeSessionIds and emits TurnStarted
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
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
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });

  it("keeps an automatic queued dispatch pending after an early provider send until TurnComplete releases the active Turn", async () => {
    const { service, providerEmitter, messageRepo } = buildService();
    startAgentServiceIngressForTest(service, );
    vi.mocked(messageRepo.findByIdInThread).mockReturnValue({ id: "queued-message", sequence: 1 } as never);

    const accepted = await service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-message",
      content: "Queued work",
      displayContent: "Queued work",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    });

    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    let completed = false;
    void accepted.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    const executionId = activeExecutionId(service);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      providerId: "claude",
    } satisfies AgentEvent);

    await expect(accepted.completion).resolves.toBeUndefined();
    expect(completed).toBe(true);
  });

  it("releases a stopped queued dispatch so the next FIFO Turn can reserve the active slot", async () => {
    const { service, messageRepo } = buildService();
    vi.mocked(messageRepo.findByIdInThread).mockImplementation((_threadId, messageId) => ({ id: messageId, sequence: 1 } as never));

    const first = await service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-message-1",
      content: "First queued work",
      displayContent: "First queued work",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    });
    await expect(service.stopSession(THREAD_ID)).resolves.toMatchObject({ status: "cancelled" });
    await expect(first.completion).resolves.toBeUndefined();

    await expect(service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-message-2",
      content: "Second queued work",
      displayContent: "Second queued work",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    })).resolves.toMatchObject({ completion: expect.any(Promise) });
  });

  it("marks a replayed queued plan answer after projecting its persisted user message", async () => {
    const { service, messageRepo, planQuestionAnswersRepo } = buildService();
    vi.mocked(messageRepo.findByIdInThread).mockReturnValue({ id: "queued-plan-answer", sequence: 1 } as never);

    await service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-plan-answer",
      content: "Implement the approved plan",
      displayContent: "Implement the approved plan",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
      markPlanAnswerForMessageId: "00000000-0000-4000-8000-000000000101",
    });

    expect(planQuestionAnswersRepo.markAnswered).toHaveBeenCalledOnce();
    expect(planQuestionAnswersRepo.markAnswered).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000101",
      THREAD_ID,
    );
  });

  it("retains pre-persisted automatic-gate attachments when the command falls through to a normal Turn", async () => {
    const { service, attachmentService, messageRepo } = buildService();
    const stored = { id: "attachment-normal", name: "normal.png", mimeType: "image/png", sizeBytes: 4 };

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "Normal fallback Turn",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      provider: "claude",
      attachments: [],
      persistedAttachmentData: {
        stored: [stored],
        persisted: [{ ...stored, sourcePath: "/tmp/normal.png" }],
      },
      cleanupPersistedAttachmentsOnHandledCommand: true,
    });

    expect((attachmentService.removeStoredAttachments as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(messageRepo.create).toHaveBeenCalledWith(
      THREAD_ID,
      "user",
      "Normal fallback Turn",
      1,
      [stored],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("ignores a late TurnStarted after stop instead of auto-resuming the thread", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    startAgentServiceIngressForTest(service, );

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await service.stopSession(THREAD_ID);
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
    } satisfies AgentEvent);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markActive).toHaveBeenCalledTimes(1);
  });

  it("keeps exact turn running when provider stop fails, then cancels on retry", async () => {
    const { service, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as NodeEvents.EventEmitter & { stopSession: ReturnType<typeof vi.fn> };
    provider.stopSession.mockRejectedValueOnce(new Error("stop unavailable"));

    await expect(service.stopSession(THREAD_ID)).rejects.toThrow("stop unavailable");
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);

    provider.stopSession.mockResolvedValueOnce(undefined);
    const result = await service.stopSession(THREAD_ID);
    expect(result.status).toBe("cancelled");
    expect(result.dispatchState).toBe("dispatched");
    expect(result.snapshot).toMatchObject({ threadId: THREAD_ID, phase: "cancelled" });
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
  });

  it("cancels during delayed setup without dispatching after setup resumes", async () => {
    const { service, providerEmitter, attachmentService } = buildService();
    startAgentServiceIngressForTest(service, );
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
    await vi.waitFor(() => expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID));

    const result = await service.stopSession(THREAD_ID);
    expect(result.status).toBe("cancelled");
    expect(result.dispatchState).toBe("not-dispatched");
    expect((providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
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
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);

    releaseSetup();
    await send;
    expect((providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .toHaveBeenCalledTimes(1);
  });

  it("terminalizes setup failure after reserving runtime authority", async () => {
    const { service, providerEmitter, attachmentService } = buildService();
    startAgentServiceIngressForTest(service, );
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
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(service.runtimeAccess().runtimeSnapshots()).toEqual([
      expect.objectContaining({ threadId: THREAD_ID, phase: "errored" }),
    ]);
    expect((providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .not.toHaveBeenCalled();
  });

  it("shares one successful provider stop across concurrent callers", async () => {
    const { service, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    let releaseStop!: () => void;
    provider.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));

    const first = service.stopSession(THREAD_ID);
    const second = service.stopSession(THREAD_ID);
    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledOnce());
    releaseStop();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.status).toBe("cancelled");
  });

  it("shares provider stop failure, then retries after single-flight clears", async () => {
    const { service, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    provider.stopSession.mockRejectedValueOnce(new Error("stop unavailable"));
    const first = service.stopSession(THREAD_ID);
    const second = service.stopSession(THREAD_ID);
    await expect(first).rejects.toThrow("stop unavailable");
    await expect(second).rejects.toThrow("stop unavailable");
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);

    provider.stopSession.mockResolvedValueOnce(undefined);
    const retry = await service.stopSession(THREAD_ID);
    expect(retry.status).toBe("cancelled");
    expect(provider.stopSession).toHaveBeenCalledTimes(2);
  });

  it("does not let completion race overwrite an explicit stop", async () => {
    const { service, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const runtime = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID);
    const executionId = runtime?.turnExecutionId;
    expect(executionId).toBeTruthy();
    if (!executionId) throw new Error("turn execution identity missing");
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    let releaseStop!: () => void;
    provider.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));

    const stopping = service.stopSession(THREAD_ID);
    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledOnce());
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
    expect(result.status).toBe("cancelled");
    expect(result.snapshot).toMatchObject({ threadId: THREAD_ID, phase: "cancelled" });
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

  it("keeps compaction active while materializing a post-terminal goal receipt", async () => {
    const { service, providerEmitter, messageRepo } = buildService();
    startAgentServiceIngressForTest(service, );

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);
    vi.mocked(messageRepo.create).mockClear();

    providerEmitter.emit("event", {
      type: AgentEventType.Compacting,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      active: true,
    } satisfies AgentEvent);

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

    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    providerEmitter.emit("event", {
      type: AgentEventType.Message,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "Goal achieved in 1s.",
      tokens: null,
    } satisfies AgentEvent);

    expect(messageRepo.create).toHaveBeenCalledWith(
      THREAD_ID,
      "assistant",
      "Goal achieved in 1s.",
      expect.any(Number),
      undefined,
      undefined,
      undefined,
      "claude-sonnet-4-6",
    );
  });

  it("re-adds thread to activeThreadIds on TurnStarted after TurnComplete (auto-resume)", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    startAgentServiceIngressForTest(service, );

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
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

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

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
      expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
      expect(memoryPressureService.markActive).toHaveBeenCalled();
    });
  });

  it("aborts an auto-resumed turn when a pending mutation reservation owns the thread", async () => {
    const mutationReservations = new ThreadControlMutationReservationService();
    const { service, providerEmitter } = buildService(process.cwd(), mutationReservations);
    const provider = providerEmitter as NodeEvents.EventEmitter & { stopSession: ReturnType<typeof vi.fn> };
    startAgentServiceIngressForTest(service, );

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
      outcome: "cancelled",
    } satisfies AgentEvent);
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(mutationReservations.owns(THREAD_ID, "pending-approval", "pendingApproval")).toBe(true);
  });

  it("initializes file tracking for provider-originated auto-resumed turns", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-auto-resume-tracker-"));
    try {
      await NodeFSPromises.writeFile(NodePath.join(root, "tracked.txt"), "before\n");
      const {
        service,
        providerEmitter,
        snapshotService,
        turnSnapshotRepo,
      } = buildService(root);
      startAgentServiceIngressForTest(service, );
      const resumedExecutionId = startProviderTurn(service);
      snapshotService.captureRef.mockClear();
      const observeToolUse = vi.spyOn(fileTrackerForAgentServiceTest(service), "observeToolUse");

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

      await NodeFSPromises.writeFile(NodePath.join(root, "tracked.txt"), "after\n");
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
      await NodeFSPromises.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps overlapping auto-resumed generations isolated until prior persistence finishes", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-auto-resume-overlap-"));
    try {
      await NodeFSPromises.writeFile(NodePath.join(root, "first.txt"), "before first\n");
      await NodeFSPromises.writeFile(NodePath.join(root, "second.txt"), "before second\n");
      const {
        service,
        providerEmitter,
        turnSnapshotRepo,
        toolCallRecordRepo,
      } = buildService(root);
      startAgentServiceIngressForTest(service, );
      const tracker = fileTrackerForAgentServiceTest(service);
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
      await NodeFSPromises.writeFile(NodePath.join(root, "first.txt"), "after first\n");
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
      await NodeFSPromises.writeFile(NodePath.join(root, "second.txt"), "after second\n");
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
      await NodeFSPromises.rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-add thread after an Error event following TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    startAgentServiceIngressForTest(service, );

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
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

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    // Error event should not re-add the thread
    memoryPressureService.markActive.mockClear();
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      error: "Something went wrong",
    } satisfies AgentEvent);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markActive).not.toHaveBeenCalled();
  });

  it("removes thread from activeThreadIds on Ended event", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    startAgentServiceIngressForTest(service, );

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      outcome: "completed",
    } satisfies AgentEvent);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });
});

describe("AgentService Ended finalization", () => {
  let lastTurnRequest: TurnRequest | undefined;
  let db: Database.Database;
  let threadRepo: RealThreadRepo;
  let workspaceRepo: RealWorkspaceRepo;
  let messageRepo: RealMessageRepo;
  let providerEmitter: NodeEvents.EventEmitter & {
    sendTurn: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
    interruptChildTurn: ReturnType<typeof vi.fn>;
  };
  let canonicalSink: CanonicalAgentEventSink;
  let canonicalEvents: CanonicalAgentEventEnvelope[];
  let service: AgentService;
  let pendingPlanOutputs: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    lastTurnRequest = undefined;
    db = openMemoryDatabase();
    canonicalEvents = [];
    threadRepo = new RealThreadRepo(db);
    workspaceRepo = new RealWorkspaceRepo(db);
    messageRepo = new RealMessageRepo(db);
    const toolCallRecordRepo = new RealToolCallRecordRepo(db);
    const thoughtSegmentRepo = new RealThoughtSegmentRepo(db);
    const hookExecutionRepo = new RealHookExecutionRepo(db);
    providerEmitter = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex" as ProviderId,
      descriptor: {
        capabilities: [{ name: "child-cancellation", support: "supported" }],
      },
      sendTurn: vi.fn((request: TurnRequest) => { lastTurnRequest = request; return Promise.resolve(); }),
      onTurnDiff: (listener: (update: ProviderTurnDiffUpdate) => void) => {
        providerEmitter.on("turn-diff", listener);
        return () => { providerEmitter.off("turn-diff", listener); };
      },
      stopSession: vi.fn(),
      interruptChildTurn: vi.fn(() => Promise.resolve()),
      shutdown: vi.fn(),
    }));

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

    canonicalSink = new CanonicalAgentEventSink(db, (events) => {
      canonicalEvents.push(...events);
    });
    pendingPlanOutputs = new Map<string, string>();
    const planTurns = Object.assign(Object.create(PlanTurnService.prototype), {
      beginOutputGeneration: () => undefined,
      beginQuestionGeneration: () => undefined,
      buildQuestionPrompt: (content: string) => content,
      buildPlanOutputInstructions: () => "",
      onTextDelta: () => undefined,
      needsAssistantMaterialization: () => false,
      persistAssistantMessage: () => undefined,
      clearTurn: (threadId: string) => {
        pendingPlanOutputs.delete(threadId);
      },
    }) as PlanTurnService;
    service = createAgentServiceForTest(
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
      settingsService,
      { assertUsable: vi.fn() } as unknown as ProviderAvailabilityService,
      planQuestionAnswersRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(messageRepo, toolCallRecordRepo, thoughtSegmentRepo, hookExecutionRepo),
      new ParentAssistantTextCheckpointService(db),
      undefined,
      undefined,
      undefined,
      canonicalSink,
      undefined,
      undefined,
      planTurns,
      undefined,
      new SubagentLifecycleService(canonicalSink, providerRegistry),
    );
    startAgentServiceIngressForTest(service, (event) => {
      publishParentProviderEvent(event, event, {
        publishAgentEvent: vi.fn(),
        updateThreadStatus: (threadId, status) => threadRepo.updateStatus(threadId, status),
        publishThreadStatus: (payload) => broadcast("thread.status", payload),
      });
    });
  });

  it.each(["error", "turnComplete", "ended"] as const)(
    "keeps an explicit stop authoritative when provider emits %s synchronously",
    async (terminalType) => {
      const workspace = workspaceRepo.create("Test", process.cwd());
      const thread = threadRepo.create(workspace.id, `Stop ${terminalType}`, "direct", "main", true, "codex");

      await service.sendMessage({
        threadId: thread.id,
        content: "stop this turn",
        permissionMode: "default",
        model: "gpt-5",
        attachments: [],
        provider: "codex",
      });
      const executionId = activeExecutionId(service, thread.id);
      providerEmitter.stopSession.mockImplementation(() => {
        if (terminalType === "error") {
          providerEmitter.emit("event", {
            type: AgentEventType.Error,
            threadId: thread.id,
            turnExecutionId: executionId,
            error: "provider stopped",
          } satisfies AgentEvent);
        } else if (terminalType === "turnComplete") {
          providerEmitter.emit("event", {
            type: AgentEventType.TurnComplete,
            threadId: thread.id,
            turnExecutionId: executionId,
            reason: "stopped",
            costUsd: null,
            tokensIn: 0,
            tokensOut: 0,
          } satisfies AgentEvent);
        } else {
          providerEmitter.emit("event", {
            type: AgentEventType.Ended,
            threadId: thread.id,
            turnExecutionId: executionId,
          } satisfies AgentEvent);
        }
      });

      await expect(service.stopSession(thread.id)).resolves.toMatchObject({
        status: "cancelled",
        turnExecutionId: executionId,
      });
      expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
        phase: "cancelled",
        terminalOutcome: "cancelled",
      });
      expect(threadRepo.findById(thread.id)?.status).toBe("paused");
      expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
        threadId: thread.id,
        status: "completed",
      });
      expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
        threadId: thread.id,
        status: "errored",
      });
      expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
        threadId: thread.id,
        status: "interrupted",
      });
    },
  );

  it("does not materialize a queued goal receipt after Error rejects a trailing completion", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Terminal error", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "finish this turn",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    const appendChunk = ParentAssistantTextCheckpointService.prototype.appendChunk;
    let queuedTrailingEvents = false;
    const appendChunkSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "appendChunk")
      .mockImplementation(function(inputs) {
        if (!queuedTrailingEvents) {
          queuedTrailingEvents = true;
          providerEmitter.emit("event", {
            type: AgentEventType.TurnComplete,
            threadId: thread.id,
            turnExecutionId: executionId,
            reason: "end_turn",
            costUsd: null,
            tokensIn: 1,
            tokensOut: 1,
            contextWindow: 200000,
            totalProcessedTokens: 2,
            providerId: "codex",
          } satisfies AgentEvent);
          providerEmitter.emit("event", {
            type: AgentEventType.Message,
            threadId: thread.id,
            turnExecutionId: executionId,
            content: "Goal achieved in 2s.",
            tokens: null,
          } satisfies AgentEvent);
        }
        return appendChunk.call(this, inputs);
      });
    const create = vi.spyOn(messageRepo, "create");

    try {
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: thread.id,
        turnExecutionId: executionId,
        delta: "final text",
        isFinalResponse: true,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.Error,
        threadId: thread.id,
        turnExecutionId: executionId,
        error: "provider failed",
      } satisfies AgentEvent);

      expect(service.runtimeAccess().runtimeSnapshots())
        .toContainEqual(expect.objectContaining({ threadId: thread.id, phase: "errored" }));
      expect(create).not.toHaveBeenCalledWith(
        thread.id,
        "assistant",
        "Goal achieved in 2s.",
        expect.any(Number),
        undefined,
        undefined,
        undefined,
        "gpt-5",
      );
    } finally {
      create.mockRestore();
      appendChunkSpy.mockRestore();
    }
  });

  it("stops every running canonical descendant through the public parent stop seam", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Parent thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "delegate nested work",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    const parentTurn = canonicalSink.loadTurnByExecution(executionId);
    expect(parentTurn).not.toBeNull();

    const direct = canonicalSink.startCodexChildDelegation({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:direct-child",
      receiverThreadIds: ["native-direct-thread"],
      providerIdentities: [],
    });
    const directTurn = canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:direct-child",
      nativeThreadId: "native-direct-thread",
      nativeTurnId: "native-direct-turn",
    });
    const nested = canonicalSink.startCodexChildDelegation({
      parentThreadId: direct.childThread.id,
      parentTurnId: directTurn.id,
      parentExecutionId: canonicalSink.loadExecutionIdForTurn(directTurn.id),
      parentItemId: "toolCall:nested-child",
      receiverThreadIds: ["native-nested-thread"],
      providerIdentities: [],
    });
    canonicalSink.startCodexChildTurn({
      parentThreadId: direct.childThread.id,
      parentTurnId: directTurn.id,
      parentExecutionId: canonicalSink.loadExecutionIdForTurn(directTurn.id),
      parentItemId: "toolCall:nested-child",
      nativeThreadId: "native-nested-thread",
      nativeTurnId: "native-nested-turn",
    });
    const sibling = canonicalSink.startCodexChildDelegation({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:completed-sibling",
      receiverThreadIds: ["native-sibling-thread"],
      providerIdentities: [],
    });
    canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:completed-sibling",
      nativeThreadId: "native-sibling-thread",
      nativeTurnId: "native-sibling-turn",
    });
    canonicalSink.finishCodexChildTurn({
      childThreadId: sibling.childThread.id,
      nativeTurnId: "native-sibling-turn",
      outcome: "completed",
    });

    expect(canonicalSink.loadCanonicalChildStopTargets(thread.id).map((target) => [
      target.childThread.id,
      target.latestTurn?.status,
    ])).toEqual(expect.arrayContaining([
      [direct.childThread.id, "Running"],
      [nested.childThread.id, "Running"],
    ]));
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id))
      .toMatchObject({ phase: "running", turnExecutionId: executionId });

    pendingPlanOutputs.set(thread.id, "# plan\n\n## Stop-safe cleanup");
    expect(pendingPlanOutputs.has(thread.id)).toBe(true);

    providerEmitter.interruptChildTurn.mockRejectedValueOnce(new Error("child interrupt unavailable"));
    providerEmitter.stopSession.mockImplementation(() => {
      providerEmitter.emit("event", {
        type: AgentEventType.Ended,
        threadId: thread.id,
        turnExecutionId: activeExecutionId(service, thread.id),
      } satisfies AgentEvent);
    });
    const result = await service.stopSession(thread.id);

    expect(result.status).toBe("cancelled");
    expect(providerEmitter.interruptChildTurn).toHaveBeenCalledTimes(2);
    expect(providerEmitter.interruptChildTurn).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "native-nested-thread",
      "native-nested-turn",
    );
    expect(providerEmitter.interruptChildTurn).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "native-direct-thread",
      "native-direct-turn",
    );
    expect(providerEmitter.stopSession).toHaveBeenCalledOnce();
    expect(Math.max(...providerEmitter.interruptChildTurn.mock.invocationCallOrder))
      .toBeLessThan(providerEmitter.stopSession.mock.invocationCallOrder[0]!);
    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: direct.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted");
    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: nested.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted");
    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: sibling.childThread.id,
    })?.latestTurn?.status).toBe("Completed");
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(thread.id);
    expect(threadRepo.findById(thread.id)?.status).toBe("paused");
    expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
      threadId: thread.id,
      status: "interrupted",
    });
    expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "cancelled",
      terminalOutcome: "cancelled",
    });
    expect(canonicalSink.loadTurnByExecution(executionId)?.status).toBe("Cancelled");
    expect(pendingPlanOutputs.has(thread.id)).toBe(false);
  });

  it("terminalizes a running canonical child when parent stop has no native identity", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Parent thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "delegate work without provider identity",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    const parentTurn = canonicalSink.loadTurnByExecution(executionId);
    expect(parentTurn).not.toBeNull();
    const child = canonicalSink.startCodexChildDelegation({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:missing-identity",
      receiverThreadIds: ["native-missing-thread"],
      providerIdentities: [],
    });
    const childTurn = canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:missing-identity",
      nativeThreadId: "native-missing-thread",
      nativeTurnId: "native-missing-turn",
    });
    db.prepare("UPDATE canonical_agent_threads SET provider_identities_json = '[]' WHERE id = ?")
      .run(child.childThread.id);
    db.prepare("UPDATE canonical_agent_turns SET provider_identities_json = '[]' WHERE id = ?")
      .run(childTurn.id);

    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: child.childThread.id,
    })).toMatchObject({ latestTurn: { status: "Running" }, nativeThreadId: null, nativeTurnId: null });

    const result = await service.stopSession(thread.id);

    expect(result.status).toBe("cancelled");
    expect(providerEmitter.interruptChildTurn).not.toHaveBeenCalled();
    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: child.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted");
  });

  it("waits for a provider terminal outcome during graceful stopAll", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Parent thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "delegate work before shutdown",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    const parentTurn = canonicalSink.loadTurnByExecution(executionId);
    expect(parentTurn).not.toBeNull();
    const child = canonicalSink.startCodexChildDelegation({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:shutdown-child",
      receiverThreadIds: ["native-shutdown-thread"],
      providerIdentities: [],
    });
    canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:shutdown-child",
      nativeThreadId: "native-shutdown-thread",
      nativeTurnId: "native-shutdown-turn",
    });

    let snapshotAtProviderStop: ReturnType<typeof canonicalSink.loadCheckpoint>;
    let resolveProviderStop: (() => void) | undefined;
    providerEmitter.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      snapshotAtProviderStop = canonicalSink.loadCheckpoint(executionId);
      resolveProviderStop = () => {
        providerEmitter.emit("event", {
          type: AgentEventType.Ended,
          threadId: thread.id,
          turnExecutionId: executionId,
          outcome: "cancelled",
        } satisfies AgentEvent);
        resolve();
      };
    }));
    const stopping = service.stopAll();
    let stopAllCompleted = false;
    void stopping.then(() => {
      stopAllCompleted = true;
    });

    await vi.waitFor(() => expect(snapshotAtProviderStop).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    }));
    expect(stopAllCompleted).toBe(false);
    if (!resolveProviderStop) throw new Error("Expected stopAll to await the provider stop");
    resolveProviderStop();
    await stopping;
    expect(stopAllCompleted).toBe(true);
    await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "interrupted",
      terminalOutcome: "interrupted",
    }));
    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: child.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted");
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(thread.id);
    expect(providerEmitter.stopSession).toHaveBeenCalledWith(`mcode-${thread.id}`);
  });

  it("leaves a stopAll turn unresolved when the provider sends no terminal outcome", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Shutdown without outcome", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "stop without a provider outcome",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    let snapshotAtProviderStop: ReturnType<typeof canonicalSink.loadCheckpoint>;
    let providerStopCompleted = false;
    providerEmitter.stopSession.mockImplementation(async () => {
      snapshotAtProviderStop = canonicalSink.loadCheckpoint(executionId);
      await Promise.resolve();
      providerStopCompleted = true;
    });

    await service.stopAll();

    expect(providerStopCompleted).toBe(true);
    expect(snapshotAtProviderStop).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(threadRepo.findById(thread.id)?.status).toBe("active");
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id))
      .toMatchObject({ phase: "running", turnExecutionId: executionId });
  });

  it("does not persist an interruption when a running turn ends without an outcome", async () => {
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

    await Promise.resolve();
    const assistant = messageRepo.listByThread(thread.id, 10).messages
      .find((message) => message.role === "assistant");
    expect(assistant?.outcome).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      outcome: expect.any(String),
      executionId,
    }));
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id)?.phase).toBe("running");
  });

  it("leaves a matching outcome-less Ended unresolved", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Recovery thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "retry this turn",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
    } satisfies AgentEvent);

    await Promise.resolve();
    expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(threadRepo.findById(thread.id)?.status).toBe("active");
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id))
      .toMatchObject({ phase: "running" });
  });

  it("releases an exact provider_lost Ended without terminalizing its durable turn", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Lost provider thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "release this lost provider runtime",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    if (!lastTurnRequest) throw new Error("Expected dispatched provider request");
    const update: ProviderTurnDiffUpdate = {
      turnId: lastTurnRequest.turnId, turnExecutionId: executionId,
      deliveryAttempt: lastTurnRequest.deliveryAttempt ?? 1, revision: 1, state: "snapshot", nativeFidelity: "agent",
      patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    };
    providerEmitter.emit("turn-diff", update);
    const turnDiffs = turnDiffsForAgentServiceTest(service);
    expect(turnDiffs.liveComparison(thread.id)?.files.map((file) => file.path)).toEqual(["a.txt"]);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
      reason: "provider_lost",
    } satisfies AgentEvent);

    await vi.waitFor(() => expect(service.runtimeAccess().runtimeSnapshots()
      .find((snapshot) => snapshot.threadId === thread.id)).toBeUndefined());
    expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(threadRepo.findById(thread.id)?.status).toBe("active");
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(thread.id);
    expect(turnDiffs.liveComparison(thread.id)).toBeNull();
    expect(turnDiffs.latest(thread.id)).toBeUndefined();
    providerEmitter.emit("turn-diff", { ...update, revision: 2 });
    expect(turnDiffs.liveComparison(thread.id)).toBeNull();
  });

  it("maps provider-cancelled Ended to the recoverable interrupted outcome", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Cancelled provider thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "cancel this turn",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
      outcome: "cancelled",
    } satisfies AgentEvent);

    await vi.waitFor(() => {
      expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
        phase: "interrupted",
        terminalOutcome: "interrupted",
      });
    });
    expect(threadRepo.findById(thread.id)?.status).toBe("interrupted");
    expect(broadcast).toHaveBeenCalledWith("thread.status", {
      threadId: thread.id,
      status: "interrupted",
    });
  });

  it("leaves a full-looking response unresolved without terminal proof", async () => {
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
    const executionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: thread.id,
      turnExecutionId: executionId,
      delta: "This is a complete-looking final response.",
      isFinalResponse: true,
    } satisfies AgentEvent);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
    } satisfies AgentEvent);
    await Promise.resolve();
    const assistant = messageRepo.listByThread(thread.id, 10).messages
      .find((message) => message.role === "assistant");
    expect(assistant?.outcome).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      outcome: expect.any(String),
      executionId,
    }));
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id)?.phase).toBe("running");
  });

  it("keeps a provider Error consistent across canonical, legacy, and renderer state", async () => {
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
      content: "partial answer before failure",
      tokens: null,
    } satisfies AgentEvent);
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: thread.id,
      turnExecutionId: executionId,
      error: "provider failed",
    } satisfies AgentEvent);
    await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)?.terminalOutcome).toBe("errored"));

    const { messages } = messageRepo.listByThread(thread.id, 10);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({
      outcome: "errored",
      outcomeExecutionId: executionId,
    });
    expect(canonicalSink.loadTurnByExecution(executionId)?.status).toBe("Errored");
    expect(canonicalSink.loadConversationProjection(thread.id, 10).messages)
      .toContainEqual(expect.objectContaining({ id: assistant?.id, outcome: "errored" }));
    expect(reduceAgentEventBatch(createAgentModelState(), canonicalEvents)).toMatchObject({
      outcome: "applied",
      state: {
        turns: {
          [canonicalSink.loadTurnByExecution(executionId)!.id]: expect.objectContaining({
            status: "Errored",
          }),
        },
      },
    });
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      messageId: assistant?.id,
      outcome: "errored",
      executionId,
    }));
  });

  it("keeps a completed turn completed when a provider sends a late error", async () => {
    const workspace = workspaceRepo.create("Test", process.cwd());
    const thread = threadRepo.create(workspace.id, "Completed thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "complete this turn",
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
      content: "completed answer",
      tokens: null,
    } satisfies AgentEvent);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: thread.id,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      providerId: "codex",
    } satisfies AgentEvent);

    await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)?.terminalOutcome).toBe("completed"));
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: thread.id,
      turnExecutionId: executionId,
      error: "late provider failure",
    } satisfies AgentEvent);

    const turn = canonicalSink.loadTurnByExecution(executionId);
    const assistant = messageRepo.listByThread(thread.id, 10).messages
      .find((message) => message.role === "assistant");
    expect(turn?.status).toBe("Completed");
    expect(assistant).toMatchObject({ outcome: "completed", outcomeExecutionId: executionId });
    expect(canonicalSink.loadConversationProjection(thread.id, 10).messages)
      .toContainEqual(expect.objectContaining({ id: assistant?.id, outcome: "completed" }));
    expect(reduceAgentEventBatch(createAgentModelState(), canonicalEvents)).toMatchObject({
      outcome: "applied",
      state: {
        turns: {
          [turn!.id]: expect.objectContaining({ status: "Completed" }),
        },
      },
    });
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      messageId: assistant?.id,
      outcome: "completed",
      executionId,
    }));
  });
});
