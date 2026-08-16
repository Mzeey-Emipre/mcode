import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { Thread, IProviderRegistry } from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
import { createCanonicalAgentEventSinkStub } from "../../../../test-utils/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../../../../services/narrative-store.js";
import { PlanQuestionService } from "../../../../services/plan-question-service.js";
import type { ThreadRepo } from "../../../../repositories/thread-repo.js";
import type { WorkspaceRepo } from "../../../../repositories/workspace-repo.js";
import type { MessageRepo } from "../../../../repositories/message-repo.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../../services/attachment-service.js";
import type { ToolCallRecordRepo } from "../../../../repositories/tool-call-record-repo.js";
import type { ThoughtSegmentRepo } from "../../../../repositories/thought-segment-repo.js";
import type { HookExecutionRepo } from "../../../../repositories/hook-execution-repo.js";
import type { TurnSnapshotRepo } from "../../../../repositories/turn-snapshot-repo.js";
import type { SnapshotService } from "../../../../services/snapshot-service.js";
import type { MemoryPressureService } from "../../../../services/memory-pressure-service.js";
import type { TaskRepo } from "../../../../repositories/task-repo.js";
import type { SettingsService } from "../../../../services/settings-service.js";
import type { ThreadService } from "../../../../services/thread-service.js";
import type { ProviderAvailabilityService } from "../../../../services/provider-availability-service.js";
import type { PlanQuestionAnswersRepo } from "../../../../repositories/plan-question-answers-repo.js";

vi.mock("../../../../transport/push.js", () => ({ broadcast: vi.fn() }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

const THREAD_ID = "t-stack";

function makeThread(): Thread {
  return {
    id: THREAD_ID,
    workspace_id: "ws-1",
    title: "x",
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
  } as unknown as Thread;
}

interface BufferedToolRow {
  toolCallId: string;
  toolName: string;
  status: string;
}

function minimalService(): AgentService {
  const thread = makeThread();
  const providerEmitter = new EventEmitter();
  (providerEmitter as unknown as Record<string, unknown>).sendMessage = vi.fn(() => Promise.resolve());

  const threadRepo = {
    findById: vi.fn(() => thread),
  } as unknown as ThreadRepo;
  const workspaceRepo = {
    findById: vi.fn(() => ({ id: "ws-1", path: "/workspace" })),
  } as unknown as WorkspaceRepo;
  const messageRepo = {} as unknown as MessageRepo;
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
  const thoughtSegmentRepo = { bulkCreate: vi.fn() } as unknown as ThoughtSegmentRepo;
  const hookExecutionRepo = { bulkCreate: vi.fn() } as unknown as HookExecutionRepo;
  const turnSnapshotRepo = {
    listByThread: vi.fn(() => []),
    create: vi.fn(),
  } as unknown as TurnSnapshotRepo;
  const snapshotService = {
    captureRef: vi.fn(() => Promise.resolve("abc")),
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
  const db = {
    transaction: vi.fn((fn: Function) => fn),
    prepare: vi.fn(() => ({ run: vi.fn() })),
  } as unknown as import("better-sqlite3").Database;

  const narrativeStore = new NarrativeStore(
    messageRepo,
    toolCallRecordRepo,
    thoughtSegmentRepo,
    hookExecutionRepo,
  );

  return new AgentService(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService,
    providerRegistry,
    threadService,
    hookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService,
    taskRepo,
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../../../repositories/plan-repo.js").PlanRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      narrativeStore,
      new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
      undefined,
      undefined,
      undefined,
      createCanonicalAgentEventSinkStub(db),
  );
}

/**
 * Seed the in-turn buffers directly on the NarrativeStore (which now owns the
 * agentCallStack + tool-call buffer the fallback rule reads) so we can probe
 * `getCurrentParentToolCallId`'s exactly-one-running-Agent semantics.
 */
function seedThreadState(
  service: AgentService,
  stack: string[],
  bufferRows: BufferedToolRow[],
): void {
  const narrativeStore = (service as unknown as { narrativeStore: NarrativeStore }).narrativeStore;
  (narrativeStore as unknown as { agentCallStack: Map<string, string[]> }).agentCallStack.set(
    THREAD_ID,
    stack,
  );
  const fullRows = bufferRows.map((r) => ({
    toolCallId: r.toolCallId,
    messageId: "",
    toolName: r.toolName,
    inputSummary: "",
    outputSummary: "",
    status: r.status,
    sortOrder: 0,
    parentToolCallId: undefined as string | undefined,
    _rawToolInput: {} as Record<string, unknown>,
  }));
  (narrativeStore as unknown as { turnToolCalls: Map<string, typeof fullRows> }).turnToolCalls.set(
    THREAD_ID,
    fullRows,
  );
}

describe("AgentService stack-derived parent fallback", () => {
  let service: AgentService;

  beforeEach(() => {
    service = minimalService();
  });

  it("returns undefined when every Agent on the stack is completed in the buffer", () => {
    seedThreadState(service, ["a1", "a4"], [
      { toolCallId: "a1", toolName: "Agent", status: "completed" },
      { toolCallId: "a4", toolName: "Agent", status: "completed" },
    ]);
    expect(service.getCurrentParentToolCallId(THREAD_ID)).toBeUndefined();
  });

  it("returns undefined when multiple Agents are still running", () => {
    seedThreadState(service, ["a1", "a2"], [
      { toolCallId: "a1", toolName: "Agent", status: "running" },
      { toolCallId: "a2", toolName: "Agent", status: "running" },
    ]);
    expect(service.getCurrentParentToolCallId(THREAD_ID)).toBeUndefined();
  });

  it("returns the Agent id when it is the only running stack entry", () => {
    seedThreadState(service, ["solo"], [{ toolCallId: "solo", toolName: "Agent", status: "running" }]);
    expect(service.getCurrentParentToolCallId(THREAD_ID)).toBe("solo");
  });
});
