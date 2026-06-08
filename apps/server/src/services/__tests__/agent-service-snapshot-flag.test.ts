import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Thread, IProviderRegistry } from "@mcode/contracts";
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

vi.mock("../../transport/push.js", () => ({ broadcast: vi.fn() }));

const THREAD_ID = "thread-snap-test";
const IDEMPOTENT_SQL =
  "UPDATE threads SET has_file_changes = 1 WHERE id = ? AND has_file_changes = 0";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    workspace_id: "ws-1",
    title: "Snapshot test thread",
    status: "idle",
    mode: "direct",
    branch: "main",
    worktree_path: null,
    model: "claude-sonnet-4-6",
    provider: "codex",
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

interface BuildServiceOptions {
  /** spy returned from db.prepare(...).run */
  runSpy?: ReturnType<typeof vi.fn>;
  /** files returned by snapshotService.getFilesChanged */
  filesChanged?: string[];
}

function buildService(opts: BuildServiceOptions = {}): {
  svc: AgentService;
  turnSnapshotRepo: TurnSnapshotRepo;
  snapshotService: SnapshotService;
  db: import("better-sqlite3").Database;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const runSpy = opts.runSpy ?? vi.fn();
  const filesChanged = opts.filesChanged ?? ["src/index.ts"];

  const thread = makeThread();

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
    listByThread: vi.fn(() => ({
      messages: [{ id: "msg-1", sequence: 1 }],
    })),
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

  const providerRegistry = {
    resolve: vi.fn(),
    resolveAll: vi.fn(() => []),
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
    // Return a ref different from the seeded "abc111" to trigger the transaction block
    captureRef: vi.fn(() => Promise.resolve("def222")),
    getFilesChanged: vi.fn(() => Promise.resolve(filesChanged)),
  } as unknown as SnapshotService;

  const db = {
    transaction: vi.fn((fn) => fn),
    prepare: vi.fn(() => ({ run: runSpy })),
  } as unknown as import("better-sqlite3").Database;

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

  const svc = new AgentService(
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
    { markAnswered: vi.fn(), isAnswered: vi.fn(() => false), listAnsweredForThread: vi.fn(() => []) } as unknown as import("../../repositories/plan-question-answers-repo.js").PlanQuestionAnswersRepo,
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
      { buildAnswerPayload: vi.fn(), findLatestPlanQuestionsMessageId: vi.fn(() => null), dismiss: vi.fn(() => null), buildPlanOutputInstructions: vi.fn(() => "") } as unknown as PlanQuestionService,
  );

  return { svc, turnSnapshotRepo, snapshotService, db, runSpy };
}

describe("AgentService snapshot flag write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls db.transaction when ref changes", async () => {
    const { svc, db } = buildService();

    // Seed turnRefBefore so persistTurn has a ref to compare against
    (svc as any).turnRefBefore.set(THREAD_ID, {
      ref: "abc111",
      cwd: "/workspace",
    });

    await (svc as any).persistTurn(THREAD_ID);

    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it("calls turnSnapshotRepo.create with correct args inside transaction", async () => {
    const { svc, turnSnapshotRepo } = buildService({
      filesChanged: ["src/index.ts"],
    });

    (svc as any).turnRefBefore.set(THREAD_ID, {
      ref: "abc111",
      cwd: "/workspace",
    });

    await (svc as any).persistTurn(THREAD_ID);

    expect(turnSnapshotRepo.create).toHaveBeenCalledOnce();
    expect(turnSnapshotRepo.create).toHaveBeenCalledWith({
      messageId: "msg-1",
      threadId: THREAD_ID,
      refBefore: "abc111",
      refAfter: "def222",
      filesChanged: ["src/index.ts"],
      worktreePath: null,
    });
  });

  it("calls db.prepare with idempotent SQL and runs with threadId when filesChanged is non-empty", async () => {
    const { svc, db, runSpy } = buildService({
      filesChanged: ["src/index.ts"],
    });

    (svc as any).turnRefBefore.set(THREAD_ID, {
      ref: "abc111",
      cwd: "/workspace",
    });

    await (svc as any).persistTurn(THREAD_ID);

    expect(db.prepare).toHaveBeenCalledWith(IDEMPOTENT_SQL);
    expect(runSpy).toHaveBeenCalledWith(THREAD_ID);
  });

  it("does NOT call db.prepare when filesChanged is empty", async () => {
    const { svc, db } = buildService({ filesChanged: [] });

    (svc as any).turnRefBefore.set(THREAD_ID, {
      ref: "abc111",
      cwd: "/workspace",
    });

    await (svc as any).persistTurn(THREAD_ID);

    expect(db.prepare).not.toHaveBeenCalled();
  });
});
