import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Thread, IProviderRegistry } from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
import { NarrativeStore } from "../narrative-store.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { ProviderAvailabilityService } from "../provider-availability-service.js";
import { ProviderDisabledError } from "../provider-availability-errors.js";
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

// Mock the broadcast transport so we can assert agent.event emissions
// without a real WebSocket server.
vi.mock("../../transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../transport/push.js";

const THREAD_ID = "thread-abc";

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

/**
 * Build a minimal AgentService with only the dependencies needed to test
 * the provider availability gate. All other deps are no-op stubs.
 */
function buildService({
  assertUsable = vi.fn(),
  resolveProvider = vi.fn(),
  threadStatus = "idle",
}: {
  assertUsable?: ReturnType<typeof vi.fn>;
  resolveProvider?: ReturnType<typeof vi.fn>;
  threadStatus?: Thread["status"] | "idle";
} = {}): AgentService {
  const thread = threadStatus === "idle" ? makeThread() : makeThread({ status: threadStatus });

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

  const providerRegistry = {
    resolve: resolveProvider,
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
    assertUsable,
  } as unknown as ProviderAvailabilityService;

  const db = {
    transaction: vi.fn((fn) => fn),
    prepare: vi.fn(() => ({ run: vi.fn() })),
  } as unknown as import("better-sqlite3").Database;

  // AgentService constructor (15 params):
  //   threadRepo, workspaceRepo, messageRepo, gitService, attachmentService,
  //   providerRegistry, threadService, toolCallRecordRepo, turnSnapshotRepo,
  //   snapshotService, db, memoryPressureService, taskRepo, settingsService, availability
  const planQuestionAnswersRepo = {
    markAnswered: vi.fn(),
    isAnswered: vi.fn(() => false),
    listAnsweredForThread: vi.fn(() => []),
  } as unknown as import("../../repositories/plan-question-answers-repo.js").PlanQuestionAnswersRepo;

  return new AgentService(
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
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/thought-segment-repo.js").ThoughtSegmentRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/hook-execution-repo.js").HookExecutionRepo,
      ),
      new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
  );
}

describe("AgentService.sendMessage — provider availability gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits providerUnavailable and returns early when assertUsable throws ProviderDisabledError", async () => {
    const resolveProvider = vi.fn();
    const assertUsable = vi.fn(() => {
      throw new ProviderDisabledError("codex");
    });

    const svc = buildService({ assertUsable, resolveProvider });

    await expect(
      svc.sendMessage({
        threadId: THREAD_ID,
        content: "Hello",
        permissionMode: "default",
        model: "claude-sonnet-4-6",
        attachments: [],
        provider: "codex",
      }),
    ).rejects.toThrow(ProviderDisabledError);

    // Provider must NOT be resolved — no agent session started
    expect(resolveProvider).not.toHaveBeenCalled();

    // A providerUnavailable event must have been broadcast on the agent.event channel
    expect(broadcast).toHaveBeenCalledWith("agent.event", {
      type: "providerUnavailable",
      threadId: THREAD_ID,
      providerId: "codex",
      reason: "disabled",
      configuredPath: undefined,
    });
  });

  it.each(["completed", "errored", "interrupted"] as const)("rejects composer sends to %s threads before persistence", async (threadStatus) => {
    const assertUsable = vi.fn();
    const svc = buildService({ threadStatus, assertUsable });

    await expect(svc.sendMessage({
      threadId: THREAD_ID,
      content: "Must not append",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
    })).rejects.toThrow("terminal thread");

    expect(assertUsable).not.toHaveBeenCalled();
  });
});
