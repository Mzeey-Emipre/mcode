import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent, Thread, IProviderRegistry } from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Thread;
}

/**
 * Build a minimal AgentService wired to a fake EventEmitter-based provider.
 * The returned `providerEmitter` lets the test fire events as if the SDK
 * produced them, exercising the handler registered in `init()`.
 */
function buildService(): {
  service: AgentService;
  providerEmitter: EventEmitter;
  memoryPressureService: { markActive: ReturnType<typeof vi.fn>; markIdle: ReturnType<typeof vi.fn> };
} {
  const thread = makeThread();
  const providerEmitter = new EventEmitter();

  // sendTurn() is called on the resolved provider
  (providerEmitter as any).sendTurn = vi.fn(() => Promise.resolve());

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
    updateCompactSummary: vi.fn(),
    updateLineage: vi.fn(),
  } as unknown as ThreadRepo;

  const workspaceRepo = {
    findById: vi.fn(() => ({ id: "ws-1", path: "/workspace" })),
  } as unknown as WorkspaceRepo;

  const messageRepo = {
    listByThread: vi.fn(() => ({ messages: [] })),
    create: vi.fn(() => ({ id: "msg-1", sequence: 1 })),
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

  const toolCallRecordRepo = {
    bulkCreate: vi.fn(),
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
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService as MemoryPressureService,
    taskRepo,
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../repositories/plan-repo.js").PlanRepo,
      { orchestrate: vi.fn() } as any,
      { write: vi.fn(), copyAttachments: vi.fn(() => []), deleteThreadFiles: vi.fn() } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/thought-segment-repo.js").ThoughtSegmentRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/hook-execution-repo.js").HookExecutionRepo,
      ),
      new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
  );

  return { service, providerEmitter, memoryPressureService: memoryPressureService as MemoryPressureService & { markActive: ReturnType<typeof vi.fn>; markIdle: ReturnType<typeof vi.fn> } };
}

describe("AgentService turn cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes thread from activeThreadIds on TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    // sendMessage adds thread to activeSessionIds and emits TurnStarted
    await service.sendMessage(THREAD_ID, "hello", "default", "claude-sonnet-4-6", [], undefined, "claude");

    expect(service.activeThreadIds()).toContain(THREAD_ID);

    // Fire TurnComplete through the provider
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

    // Thread should no longer be active
    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });

  it("does NOT remove thread from activeThreadIds on TurnComplete during compaction", async () => {
    const { service, providerEmitter } = buildService();
    service.init();

    await service.sendMessage(THREAD_ID, "hello", "default", "claude-sonnet-4-6", [], undefined, "claude");
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

    await service.sendMessage(THREAD_ID, "hello", "default", "claude-sonnet-4-6", [], undefined, "claude");
    expect(service.activeThreadIds()).toContain(THREAD_ID);

    // Turn completes, thread removed from active
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

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);

    // SDK auto-resumes: TurnStarted fires from stream loop
    memoryPressureService.markActive.mockClear();
    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
    } satisfies AgentEvent);

    // Thread should be active again
    expect(service.activeThreadIds()).toContain(THREAD_ID);
    expect(memoryPressureService.markActive).toHaveBeenCalled();
  });

  it("does not re-add thread after an Error event following TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    await service.sendMessage(THREAD_ID, "hello", "default", "claude-sonnet-4-6", [], undefined, "claude");
    expect(service.activeThreadIds()).toContain(THREAD_ID);

    // Turn completes, thread removed
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

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);

    // Error event should not re-add the thread
    memoryPressureService.markActive.mockClear();
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: THREAD_ID,
      error: "Something went wrong",
    } satisfies AgentEvent);

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markActive).not.toHaveBeenCalled();
  });

  it("removes thread from activeThreadIds on Ended event", async () => {
    const { service, providerEmitter, memoryPressureService } = buildService();
    service.init();

    await service.sendMessage(THREAD_ID, "hello", "default", "claude-sonnet-4-6", [], undefined, "claude");
    expect(service.activeThreadIds()).toContain(THREAD_ID);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
    } satisfies AgentEvent);

    expect(service.activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });
});
