import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import type { Thread, IProviderRegistry } from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import { TaskRepo } from "../persistence/task-repo.js";
import { AgentService } from "../agent-service.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import { EventEmitter } from "events";

// Stub broadcast so we can assert push events without a real WebSocket server.
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../../../application/transport/push.js";

/**
 * Build an AgentService against a real in-memory SQLite DB so the marker
 * transaction can be exercised end-to-end (FK enforcement + rollback).
 */
function buildService(db: Database.Database) {
  container.reset();
  container.registerInstance("Database", db);

  const threadRepo = container.resolve(ThreadRepo);
  const workspaceRepo = container.resolve(WorkspaceRepo);
  const messageRepo = container.resolve(MessageRepo);
  const planQuestionAnswersRepo = container.resolve(PlanQuestionAnswersRepo);
  const turnSnapshotRepo = container.resolve(TurnSnapshotRepo);
  const taskRepo = container.resolve(TaskRepo);

  const gitService = {
    resolveWorkingDir: vi.fn(() => process.cwd()),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;

  // Provider stub: extends EventEmitter (matches real provider shape) and
  // resolves sendTurn immediately so the turn "completes" without I/O.
  const providerStub = Object.assign(new EventEmitter(), {
    id: "claude" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn(() => Promise.resolve()),
    // Claude-concrete off-interface method invoked by armPlanGenerationTurn via cast.
    setPlanAnswerMode: vi.fn(),
  });
  const providerRegistry = {
    resolve: vi.fn(() => providerStub),
    resolveAll: vi.fn(() => []),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;

  const threadService = { create: vi.fn() } as unknown as ThreadService;

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
    get: vi.fn(() =>
      Promise.resolve({
        model: { defaults: { fallbackId: undefined, contextWindow: "auto", thinking: false } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
        provider: { enabled: {}, cli: {} },
      }),
    ),
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
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService,
    taskRepo,
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../planning/persistence/plan-repo.js").PlanRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      container.resolve(NarrativeStore),
      container.resolve(PlanQuestionService),
      undefined,
      undefined,
      undefined,
      createCanonicalAgentEventSinkStub(db),
  );

  return { svc, threadRepo, workspaceRepo, messageRepo, planQuestionAnswersRepo };
}

describe("AgentService.sendMessage — plan-questions answered marker", () => {
  let db: Database.Database;
  let thread: Thread;
  let assistantMessageId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openMemoryDatabase();
    const { workspaceRepo, threadRepo, messageRepo } = buildService(db);
    const ws = workspaceRepo.create("test-ws", process.cwd(), false);
    thread = threadRepo.create(ws.id, "thread", "direct", "main");
    // Pre-existing assistant message that contains the plan-questions fence.
    const assistantMsg = messageRepo.create(
      thread.id,
      "assistant",
      "```plan-questions\n[]\n```",
      1,
    );
    assistantMessageId = assistantMsg.id;
  });

  it("marks the plan-questions message answered when markPlanAnswerForMessageId is set", async () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "my answers",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
      markPlanAnswerForMessageId: assistantMessageId,
    });

    expect(planQuestionAnswersRepo.isAnswered(assistantMessageId)).toBe(true);
  });

  it("does not mark anything when markPlanAnswerForMessageId is unset (regression guard)", async () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "regular message",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(planQuestionAnswersRepo.listAnsweredForThread(thread.id)).toEqual([]);
  });

  it("answerQuestions marks the latest plan-questions message answered", async () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    await svc.answerQuestions(thread.id, [
      { questionId: "q1", selectedOptionId: "opt1", freeText: null },
    ]);

    expect(planQuestionAnswersRepo.isAnswered(assistantMessageId)).toBe(true);
  });

  it("answerQuestions still sends when no plan-questions message exists", async () => {
    // Fresh thread/workspace with NO plan-questions assistant message.
    const { svc, workspaceRepo, threadRepo, planQuestionAnswersRepo } =
      buildService(db);
    const ws2 = workspaceRepo.create("plain-ws", `${process.cwd()}#alt`, false);
    const plainThread = threadRepo.create(ws2.id, "plain", "direct", "main");

    await expect(
      svc.answerQuestions(plainThread.id, [
        { questionId: "q1", selectedOptionId: null, freeText: "anything" },
      ]),
    ).resolves.toBeUndefined();

    expect(planQuestionAnswersRepo.listAnsweredForThread(plainThread.id)).toEqual([]);
  });

  it("broadcasts plan.answered after the marker tx commits", async () => {
    const { svc } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "my answers",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
      markPlanAnswerForMessageId: assistantMessageId,
    });

    expect(broadcast).toHaveBeenCalledWith("plan.answered", {
      threadId: thread.id,
      assistantMessageId,
    });
  });

  it("does not broadcast plan.answered when no marker was set", async () => {
    const { svc } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "regular message",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    const calls = (broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "plan.answered",
    );
    expect(calls).toEqual([]);
  });

  it("does not broadcast plan.answered when the marker tx rolls back", async () => {
    const { svc } = buildService(db);

    await expect(
      svc.sendMessage({
        threadId: thread.id,
        content: "answers that should NOT persist",
        permissionMode: "default",
        model: "claude-sonnet-4-6",
        attachments: [],
        provider: "claude",
        markPlanAnswerForMessageId: "non-existent-message-id",
      }),
    ).rejects.toThrow();

    const calls = (broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "plan.answered",
    );
    expect(calls).toEqual([]);
  });

  it("dismissPlanQuestions marks the latest fence answered and broadcasts plan.dismissed", () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    svc.dismissPlanQuestions(thread.id);

    expect(planQuestionAnswersRepo.isAnswered(assistantMessageId)).toBe(true);
    expect(broadcast).toHaveBeenCalledWith("plan.dismissed", {
      threadId: thread.id,
      assistantMessageId,
    });
    // Dismiss must NOT broadcast plan.answered — that channel is reserved
    // for submissions and triggers the AnsweredSummary echo on receivers.
    const answeredCalls = (broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "plan.answered",
    );
    expect(answeredCalls).toEqual([]);
  });

  it("dismissPlanQuestions is idempotent — repeat calls don't fail and re-broadcast", () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    svc.dismissPlanQuestions(thread.id);
    svc.dismissPlanQuestions(thread.id);

    expect(planQuestionAnswersRepo.listAnsweredForThread(thread.id)).toEqual([
      assistantMessageId,
    ]);
  });

  it("dismissPlanQuestions is a no-op when the thread has no plan-questions fence", () => {
    const { svc, workspaceRepo, threadRepo, planQuestionAnswersRepo } =
      buildService(db);
    const ws2 = workspaceRepo.create("dismiss-ws", `${process.cwd()}#dismiss`, false);
    const plainThread = threadRepo.create(ws2.id, "plain", "direct", "main");

    svc.dismissPlanQuestions(plainThread.id);

    expect(planQuestionAnswersRepo.listAnsweredForThread(plainThread.id)).toEqual([]);
    const calls = (broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) =>
        (c[0] === "plan.dismissed" || c[0] === "plan.answered") &&
        (c[1] as { threadId: string }).threadId === plainThread.id,
    );
    expect(calls).toEqual([]);
  });

  it("rolls back the user message when the marker insert fails (FK violation)", async () => {
    const { svc, messageRepo, planQuestionAnswersRepo } = buildService(db);
    const beforeCount =
      messageRepo.listByThread(thread.id, 100).messages.length;

    // Pass an unknown message id so the FK rejects the marker insert.
    // The user-message INSERT must roll back as part of the same transaction.
    await expect(
      svc.sendMessage({
        threadId: thread.id,
        content: "answers that should NOT persist",
        permissionMode: "default",
        model: "claude-sonnet-4-6",
        attachments: [],
        provider: "claude",
        markPlanAnswerForMessageId: "non-existent-message-id",
      }),
    ).rejects.toThrow();

    const afterCount =
      messageRepo.listByThread(thread.id, 100).messages.length;
    expect(afterCount).toBe(beforeCount);
    expect(planQuestionAnswersRepo.listAnsweredForThread(thread.id)).toEqual([]);
  });
});

describe("AgentService.sendMessage completed-thread lifecycle", () => {
  let db: Database.Database;
  let thread: Thread;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openMemoryDatabase();
    const { workspaceRepo, threadRepo } = buildService(db);
    const workspace = workspaceRepo.create("test-ws", process.cwd(), false);
    thread = threadRepo.create(workspace.id, "completed thread", "direct", "main");
    threadRepo.complete(
      thread.id,
      "2026-08-12T08:00:00.000Z",
      "2026-08-15T08:00:00.000Z",
    );
  });

  it("atomically reopens a completed thread when persisting a new user message", async () => {
    const { svc, threadRepo, messageRepo } = buildService(db);

    await svc.sendMessage({
      threadId: thread.id,
      content: "continue",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(threadRepo.findById(thread.id)?.user_completed_at).toBeNull();
    expect(threadRepo.findById(thread.id)?.scheduled_deletion_at).toBeNull();
    expect(messageRepo.listByThread(thread.id, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "continue" }),
    ]);
    expect(broadcast).toHaveBeenCalledWith(
      "thread.lifecycleChanged",
      expect.objectContaining({
        thread: expect.objectContaining({ id: thread.id, user_completed_at: null }),
      }),
    );
  });

  it("keeps completion when user-message persistence fails", async () => {
    db.exec(`
      CREATE TRIGGER reject_completed_thread_message
      BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'message persistence rejected');
      END
    `);
    const { svc, threadRepo } = buildService(db);

    await expect(svc.sendMessage({
      threadId: thread.id,
      content: "continue",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    })).rejects.toThrow("message persistence rejected");

    expect(threadRepo.findById(thread.id)?.user_completed_at).toBe(
      "2026-08-12T08:00:00.000Z",
    );
    expect(threadRepo.findById(thread.id)?.scheduled_deletion_at).toBe(
      "2026-08-15T08:00:00.000Z",
    );
  });
});
