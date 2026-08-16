import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Thread, IProviderRegistry } from "@mcode/contracts";
import { AgentService, usesInternalThreadControlMcp } from "../agent-service.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { ProviderDisabledError } from "../../../providers/availability/provider-availability-errors.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import type { MessageRepo } from "../../conversation/persistence/message-repo.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import type { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { TaskRepo } from "../persistence/task-repo.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import { EventEmitter } from "node:events";

// Mock the broadcast transport so we can assert agent.event emissions
// without a real WebSocket server.
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../../../application/transport/push.js";

const THREAD_ID = "thread-abc";
type PersistedThreadStatus = Thread["status"] | "failed" | "idle" | "stopped";
type PersistedThread = Omit<Thread, "status"> & { status: PersistedThreadStatus };

function makeThread(overrides: Partial<PersistedThread> = {}): PersistedThread {
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
    user_completed_at: null,
    scheduled_deletion_at: null,
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
  threadStatus?: PersistedThreadStatus;
} = {}) {
  const thread = makeThread({ status: threadStatus });

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
    findById: vi.fn(() => ({ id: "ws-1", path: process.cwd() })),
  } as unknown as WorkspaceRepo;

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
  } as unknown as MessageRepo;

  const gitService = {
    resolveWorkingDir: vi.fn(() => process.cwd()),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;

  const providerStub = Object.assign(new EventEmitter(), {
    id: "codex" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn(() => Promise.resolve()),
  });

  const providerRegistry = {
    resolve: resolveProvider.getMockImplementation() ? resolveProvider : vi.fn(() => providerStub),
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
  } as unknown as import("../../planning/persistence/plan-question-answers-repo.js").PlanQuestionAnswersRepo;

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
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../conversation/narrative/persistence/thought-segment-repo.js").ThoughtSegmentRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
      ),
      new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
      undefined,
      undefined,
      undefined,
      createCanonicalAgentEventSinkStub(db),
  );
  return { svc, threadRepo, messageRepo, providerStub, providerRegistry };
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

    const { svc } = buildService({ assertUsable, resolveProvider });

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

  it.each(["failed", "stopped", "archived", "deleted"] as const)("rejects composer sends to %s threads before persistence", async (threadStatus) => {
    const assertUsable = vi.fn();
    const { svc } = buildService({ threadStatus, assertUsable });

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

  it.each(["completed", "interrupted", "errored"] as const)("allows a direct follow-up to the %s thread through persistence and provider dispatch", async (threadStatus) => {
    const { svc, threadRepo, messageRepo, providerStub } = buildService({ threadStatus });

    await svc.sendMessage({
      threadId: THREAD_ID,
      content: "Continue from the completed turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
    });

    expect(messageRepo.create).toHaveBeenCalled();
    expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "active");
    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "interrupted"] as const)("allows a fully-provenanced cross-thread send to a %s thread", async (threadStatus) => {
    const { svc, threadRepo, messageRepo, providerStub } = buildService({ threadStatus });

    await svc.sendMessage({
      threadId: THREAD_ID,
      content: "Delegated follow-up resumes the target task",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
      sourceThreadId: "source-thread",
      originSourceTurnId: "source-turn",
      sourceProviderId: "claude",
    });

    expect(messageRepo.create).toHaveBeenCalledWith(
      THREAD_ID,
      "user",
      "Delegated follow-up resumes the target task",
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        type: "thread",
        sourceThreadId: "source-thread",
        sourceTurnId: "source-turn",
        sourceProviderId: "claude",
      },
    );
    expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "active");
    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete cross-thread provenance before provider side effects", async () => {
    const assertUsable = vi.fn();
    const resolveProvider = vi.fn();
    const { svc } = buildService({ assertUsable, resolveProvider });

    await expect(svc.sendMessage({
      threadId: THREAD_ID,
      content: "Must retain the real source tuple",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
      sourceThreadId: "source-thread",
      sourceProviderId: "claude",
    })).rejects.toThrow("complete thread provenance tuple");

    expect(assertUsable).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();
  });
});

describe("AgentService internal MCP provider allowlist", () => {
  it.each(["claude", "codex", "cursor", "copilot"])("includes %s for initial and retry activation", (provider) => {
    expect(usesInternalThreadControlMcp(provider)).toBe(true);
  });

  it("excludes unsupported providers", () => {
    expect(usesInternalThreadControlMcp("unknown")).toBe(false);
  });
});
