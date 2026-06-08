import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import type Database from "better-sqlite3";
import { AgentEventType } from "@mcode/contracts";
import type {
  AgentEvent,
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../store/database";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { MessageRepo } from "../repositories/message-repo";
import { PlanQuestionAnswersRepo } from "../repositories/plan-question-answers-repo";
import { ToolCallRecordRepo } from "../repositories/tool-call-record-repo";
import { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import { TaskRepo } from "../repositories/task-repo";
import { AgentService } from "../services/agent-service";
import { NarrativeStore } from "../services/narrative-store";
import { PlanQuestionService } from "../services/plan-question-service";
import type { GitService } from "../services/git-service";
import type { AttachmentService } from "../services/attachment-service";
import type { SnapshotService } from "../services/snapshot-service";
import type { MemoryPressureService } from "../services/memory-pressure-service";
import type { ThreadService } from "../services/thread-service";
import type { SettingsService } from "../services/settings-service";
import type { ProviderAvailabilityService } from "../services/provider-availability-service";

/**
 * Verifies the poison-pill recovery wiring: when the Claude provider abandons an
 * unresumable session (emitting a System `sdk_session_invalidated` event), the
 * service clears the thread's persisted `sdk_session_id` so the next turn spawns
 * a fresh session instead of resuming the broken transcript forever.
 */
describe("AgentService clears sdk_session_id on session invalidation", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let messageRepo: MessageRepo;
  let toolCallRecordRepo: ToolCallRecordRepo;
  let turnSnapshotRepo: TurnSnapshotRepo;
  let taskRepo: TaskRepo;
  let svc: AgentService;
  let providerStub: EventEmitter & Partial<IAgentProvider>;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    messageRepo = new MessageRepo(db);
    toolCallRecordRepo = new ToolCallRecordRepo(db);
    turnSnapshotRepo = new TurnSnapshotRepo(db);
    taskRepo = new TaskRepo(db);

    providerStub = Object.assign(new EventEmitter(), {
      id: "claude" as ProviderId,
      supportsCompletion: false,
      sessionForkOnResume: "unsupported" as const,
      maxInputCharactersPerTurn: 16_000,
      sendTurn: vi.fn(() => new Promise<void>(() => {})),
      stopSession: vi.fn(),
      shutdown: vi.fn(),
    });

    const registryStub: IProviderRegistry = {
      resolve: () => providerStub as unknown as IAgentProvider,
      resolveAll: () => [providerStub as unknown as IAgentProvider],
      shutdown: () => {},
    };

    const gitServiceStub = {
      resolveWorkingDir: vi.fn(() => process.cwd()),
    } as unknown as GitService;
    const attachmentServiceStub = {
      persist: vi.fn(async () => ({ stored: [], persisted: [] })),
    } as unknown as AttachmentService;
    const snapshotServiceStub = {
      captureRef: vi.fn(async () => "ref-before-sha"),
    } as unknown as SnapshotService;
    const memoryPressureServiceStub = {
      markActive: vi.fn(),
      markIdle: vi.fn(),
    } as unknown as MemoryPressureService;
    const settingsServiceStub = {
      get: vi.fn(async () => ({
        model: { defaults: { fallbackId: undefined } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      })),
    } as unknown as SettingsService;
    const threadServiceStub = {} as unknown as ThreadService;
    const availabilityStub = {
      assertUsable: vi.fn(),
    } as unknown as ProviderAvailabilityService;

    svc = new AgentService(
      threadRepo,
      workspaceRepo,
      messageRepo,
      gitServiceStub,
      attachmentServiceStub,
      registryStub,
      threadServiceStub,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../repositories/hook-execution-repo.js").HookExecutionRepo,
      turnSnapshotRepo,
      snapshotServiceStub,
      db,
      memoryPressureServiceStub,
      taskRepo,
      settingsServiceStub,
      availabilityStub,
      { markAnswered: vi.fn(), isAnswered: vi.fn(() => false), listAnsweredForThread: vi.fn(() => []) } as unknown as import("../repositories/plan-question-answers-repo.js").PlanQuestionAnswersRepo,
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../repositories/plan-repo.js").PlanRepo,
      { orchestrate: vi.fn() } as any,
      { write: vi.fn(), copyAttachments: vi.fn(() => []), deleteThreadFiles: vi.fn() } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../repositories/thought-segment-repo.js").ThoughtSegmentRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../repositories/hook-execution-repo.js").HookExecutionRepo,
      ),
      new PlanQuestionService(messageRepo, new PlanQuestionAnswersRepo(db)),
    );
    svc.init();
  });

  it("nulls sdk_session_id when a sdk_session_invalidated event arrives", () => {
    const workspace = workspaceRepo.create("test-ws", process.cwd());
    const thread = threadRepo.create(workspace.id, "Test Thread", "direct", "main", true, "claude");
    threadRepo.updateSdkSessionId(thread.id, "poison-sid");
    expect(threadRepo.findById(thread.id)?.sdk_session_id).toBe("poison-sid");

    providerStub.emit("event", {
      type: AgentEventType.System,
      threadId: thread.id,
      subtype: "sdk_session_invalidated",
    } satisfies AgentEvent);

    expect(threadRepo.findById(thread.id)?.sdk_session_id).toBeNull();
  });

  it("leaves sdk_session_id intact for an unrelated System subtype", () => {
    const workspace = workspaceRepo.create("test-ws", process.cwd());
    const thread = threadRepo.create(workspace.id, "Test Thread", "direct", "main", true, "claude");
    threadRepo.updateSdkSessionId(thread.id, "keep-sid");

    providerStub.emit("event", {
      type: AgentEventType.System,
      threadId: thread.id,
      subtype: "session_restarted",
    } satisfies AgentEvent);

    expect(threadRepo.findById(thread.id)?.sdk_session_id).toBe("keep-sid");
  });
});
