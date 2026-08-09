import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { AgentEventType } from "@mcode/contracts";
import type { Thread, IProviderRegistry, Message } from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
import { createCanonicalAgentEventSinkStub } from "../../test-utils/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../narrative-store.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { isTurnScopedEvent } from "../turn-runtime.js";
import type { ThreadRepo } from "../../repositories/thread-repo.js";
import type { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import type { MessageRepo } from "../../repositories/message-repo.js";
import type { GitService } from "../git-service.js";
import type { AttachmentService } from "../attachment-service.js";
import type {
  ToolCallRecordRepo,
  CreateToolCallRecordInput,
} from "../../repositories/tool-call-record-repo.js";
import type { ThoughtSegmentRepo, CreateThoughtSegmentInput } from "../../repositories/thought-segment-repo.js";
import type { HookExecutionRepo, CreateHookExecutionInput } from "../../repositories/hook-execution-repo.js";
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

const THREAD_ID = "t-narr";
const MSG_ID = "msg-narr";

function makeThread(overrides: Partial<Thread> = {}): Thread {
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
    ...overrides,
  } as Thread;
}

interface Built {
  service: AgentService;
  providerEmitter: EventEmitter;
  thoughtBulk: ReturnType<typeof vi.fn>;
  hookBulk: ReturnType<typeof vi.fn>;
  toolBulk: ReturnType<typeof vi.fn>;
  taskAppend: ReturnType<typeof vi.fn>;
  taskUpsertGroup: ReturnType<typeof vi.fn>;
  taskUpdate: ReturnType<typeof vi.fn>;
  taskRemove: ReturnType<typeof vi.fn>;
}

function build(): Built {
  const thread = makeThread();
  const providerEmitter = new EventEmitter();
  (providerEmitter as any).sendTurn = vi.fn(() => Promise.resolve());

  const threadRepo = {
    findById: vi.fn(() => thread),
    updateStatus: vi.fn(),
    updateModel: vi.fn(),
    updateProvider: vi.fn(),
    updateSettings: vi.fn(),
    updateContextUsage: vi.fn(),
    updateSdkSessionId: vi.fn(),
    updateCompactSummary: vi.fn(),
  } as unknown as ThreadRepo;
  const workspaceRepo = {
    findById: vi.fn(() => ({ id: "ws-1", path: "/workspace" })),
  } as unknown as WorkspaceRepo;
  const messageRepo = {
    listByThread: vi.fn(() => ({ messages: [{ id: MSG_ID, role: "assistant", sequence: 2 }] })),
    create: vi.fn(() => ({ id: MSG_ID, sequence: 2 })),
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
  const toolBulk = vi.fn();
  const toolCallRecordRepo = { bulkCreate: toolBulk } as unknown as ToolCallRecordRepo;
  const thoughtBulk = vi.fn();
  const thoughtSegmentRepo = { bulkCreate: thoughtBulk } as unknown as ThoughtSegmentRepo;
  const hookBulk = vi.fn();
  const hookExecutionRepo = { bulkCreate: hookBulk } as unknown as HookExecutionRepo;
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
  const taskAppend = vi.fn();
  const taskUpsertGroup = vi.fn();
  const taskUpdate = vi.fn(() => true);
  const taskRemove = vi.fn();
  const taskRepo = {
    get: vi.fn(() => []),
    upsert: vi.fn(),
    upsertGroup: taskUpsertGroup,
    appendTask: taskAppend,
    updateTask: taskUpdate,
    removeTask: taskRemove,
  } as unknown as TaskRepo;
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

  // The narrative write seam lives in NarrativeStore; build it from the same
  // repo mocks so the bulkCreate spies observe what AgentService delegates.
  const narrativeStore = new NarrativeStore(
    messageRepo,
    toolCallRecordRepo,
    thoughtSegmentRepo,
    hookExecutionRepo,
  );

  const service = new AgentService(
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
      { create: vi.fn(), updateStatus: vi.fn(), listByThread: vi.fn(() => []), getLatestForThread: vi.fn(() => null), getById: vi.fn(() => null) } as unknown as import("../../repositories/plan-repo.js").PlanRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      narrativeStore,
      new PlanQuestionService(messageRepo, planQuestionAnswersRepo),
      undefined,
      undefined,
      undefined,
      createCanonicalAgentEventSinkStub(db),
  );
  service.init();
  // Provider adapters always stamp turn-scoped events with the active execution
  // identity. Keep this fixture aligned with that production boundary while
  // leaving each test focused on the narrative payload it emits.
  const turnRuntime = (service as unknown as {
    turnRuntime: { start: (threadId: string) => { turnExecutionId: string }; snapshot: (threadId: string) => {
      turnExecutionId: string | null;
      phase: string;
    } | undefined };
  }).turnRuntime;
  turnRuntime.start(THREAD_ID);
  const emit = providerEmitter.emit.bind(providerEmitter);
  providerEmitter.emit = ((eventName: string, event?: unknown, ...args: unknown[]) => {
    if (eventName === "event" && event && typeof event === "object"
      && isTurnScopedEvent(event as Parameters<typeof isTurnScopedEvent>[0])
      && !(event as { turnExecutionId?: string }).turnExecutionId) {
      const runtime = turnRuntime.snapshot(THREAD_ID);
      event = { ...(event as Record<string, unknown>), turnExecutionId: runtime?.turnExecutionId };
    }
    return emit(eventName, event, ...args);
  }) as typeof providerEmitter.emit;
  // Prime per-thread state without running sendMessage's full path. The buffers
  // now live in NarrativeStore; seed them via the same public entry points
  // sendMessage uses (beginTurn + resetTurnCounters).
  narrativeStore.beginTurn(THREAD_ID);
  narrativeStore.resetTurnCounters(THREAD_ID);
  return { service, providerEmitter, thoughtBulk, hookBulk, toolBulk, taskAppend, taskUpsertGroup, taskUpdate, taskRemove };
}

describe("AgentService narrative persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists TaskCreate at result time keyed by the harness-assigned id", () => {
    const { providerEmitter, taskAppend } = build();

    // The harness assigns the task id only in the result, so the create must be
    // buffered on ToolUse and persisted on ToolResult.
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-create-1",
      toolName: "TaskCreate",
      toolInput: {
        subject: "Buy groceries",
        description: "Pick up milk, eggs, bread",
        activeForm: "Buying groceries",
      },
    });
    expect(taskAppend).not.toHaveBeenCalled();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "task-create-1",
      output: "Task #1 created successfully: Buy groceries",
      isError: false,
    });

    expect(taskAppend).toHaveBeenCalledWith(THREAD_ID, {
      id: "1",
      content: "Buy groceries - Pick up milk, eggs, bread",
      status: "pending",
      activeForm: "Buying groceries",
      group: "Tasks",
    });
  });

  it("does not persist a TaskCreate whose result errored", () => {
    const { providerEmitter, taskAppend } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-create-err",
      toolName: "TaskCreate",
      toolInput: { subject: "Doomed", description: "never lands" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "task-create-err",
      output: "Task #2 created successfully",
      isError: true,
    });

    expect(taskAppend).not.toHaveBeenCalled();
  });

  it("persists a shell exit code from its tool result", async () => {
    const { providerEmitter, toolBulk } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "shell-failed",
      toolName: "command_execution",
      toolInput: { command: "exit 1" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "shell-failed",
      output: "",
      isError: true,
      exitCode: 1,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(toolBulk).toHaveBeenCalledOnce();
    const toolCalls: CreateToolCallRecordInput[] = toolBulk.mock.calls[0][0];
    expect(toolCalls[0].exitCode).toBe(1);
  });

  it("persists privileged Browser evaluation without source, result, or artifacts", async () => {
    const { providerEmitter, toolBulk } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "evaluate-1",
      toolName: "mcp__mcode-browser__browser_evaluate",
      toolInput: { expression: "globalThis.SECRET_SOURCE" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "evaluate-1",
      output: '{"valueJson":"SECRET_RESULT"}',
      isError: false,
      outputTruncated: true,
      outputTotalBytes: 999,
      outputArtifactPath: "C:\\secret-result.txt",
      toolInput: { expression: "globalThis.SECRET_SOURCE" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(toolBulk).toHaveBeenCalledOnce();
    const toolCalls: CreateToolCallRecordInput[] = toolBulk.mock.calls[0][0];
    expect(toolCalls[0]).toMatchObject({
      toolName: "mcp__mcode-browser__browser_evaluate",
      inputSummary: '{"operation":"browser_evaluate"}',
      outputSummary: '{"operation":"browser_evaluate","outcome":"completed"}',
      outputTruncated: false,
    });
    expect(toolCalls[0].outputArtifactPath).toBeUndefined();
    expect(JSON.stringify(toolCalls[0])).not.toContain("SECRET_SOURCE");
    expect(JSON.stringify(toolCalls[0])).not.toContain("SECRET_RESULT");
  });

  it("persists Browser actions as content-free narrative receipts", async () => {
    const { providerEmitter, toolBulk } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "act-1",
      toolName: "mcp__mcode-browser__browser_act",
      toolInput: {
        observationRef: "SECRET_OBSERVATION",
        steps: [{ operation: "type", text: "SECRET_TYPED_VALUE" }],
      },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "act-1",
      output: JSON.stringify({
        operation: "act",
        outcome: "completed",
        effect: "complete",
        recovery: "inspect",
        receipts: [
          { index: 0, operation: "type", status: "applied", message: "SECRET_RESULT" },
        ],
        finalObservation: { visibleText: "SECRET_PAGE_BODY" },
      }),
      isError: false,
      outputArtifactPath: "C:\\SECRET_RESULT.txt",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(toolBulk).toHaveBeenCalledOnce();
    const toolCalls: CreateToolCallRecordInput[] = toolBulk.mock.calls[0][0];
    expect(toolCalls[0]).toMatchObject({
      inputSummary: '{"operation":"browser_act","steps":[{"operation":"type"}]}',
      outputSummary: '{"operation":"browser_act","outcome":"completed","effect":"complete","recovery":"inspect","receipts":[{"index":0,"operation":"type","status":"applied"}]}',
      outputTruncated: false,
    });
    expect(toolCalls[0].outputArtifactPath).toBeUndefined();
    expect(JSON.stringify(toolCalls[0])).not.toContain("SECRET");
  });

  it("applies a TaskUpdate status transition to the persisted task by harness id", () => {
    const { providerEmitter, taskUpdate } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-update-1",
      toolName: "TaskUpdate",
      toolInput: { taskId: "1", status: "in_progress" },
    });

    expect(taskUpdate).toHaveBeenCalledWith(
      THREAD_ID,
      "1",
      { status: "in_progress" },
      "Tasks",
    );
  });

  it("removes the persisted task when a TaskUpdate sets status deleted", () => {
    const { providerEmitter, taskRemove, taskUpdate } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-update-del",
      toolName: "TaskUpdate",
      toolInput: { taskId: "3", status: "deleted" },
    });

    expect(taskRemove).toHaveBeenCalledWith(THREAD_ID, "3", "Tasks");
    expect(taskUpdate).not.toHaveBeenCalled();
  });

  it("patches subject and activeForm via TaskUpdate without a status change", () => {
    const { providerEmitter, taskUpdate } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-update-edit",
      toolName: "TaskUpdate",
      toolInput: { taskId: "1", subject: "Run unit tests", activeForm: "Running unit tests" },
    });

    expect(taskUpdate).toHaveBeenCalledWith(
      THREAD_ID,
      "1",
      { content: "Run unit tests", activeForm: "Running unit tests" },
      "Tasks",
    );
  });

  it("persists Codex update_plan tool calls for Scope hydration", () => {
    const { providerEmitter, taskUpsertGroup } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "update-plan-1",
      toolName: "update_plan",
      toolInput: {
        plan: [
          { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
          { status: "inProgress", step: "Test todo item two with CODE-A2 and CODE-B2" },
          { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
        ],
      },
    });

    expect(taskUpsertGroup).toHaveBeenCalledWith(THREAD_ID, "Tasks", [
      {
        content: "Test todo item one with CODE-A1 and CODE-B1",
        status: "pending",
        group: "Tasks",
      },
      {
        content: "Test todo item two with CODE-A2 and CODE-B2",
        status: "in_progress",
        group: "Tasks",
      },
      {
        content: "Test todo item three with CODE-A3 and CODE-B3",
        status: "completed",
        group: "Tasks",
      },
    ]);
  });

  it("segments thoughts split by tool calls with strictly-ordered sortOrder", async () => {
    const { providerEmitter, thoughtBulk, toolBulk } = build();

    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "I will " });
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "read." });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-1",
      toolName: "Read",
      toolInput: { file_path: "/a" },
    });
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "Now respond." });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    // Wait for the persistTurn promise chain to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(toolBulk).toHaveBeenCalledOnce();
    expect(thoughtBulk).toHaveBeenCalledOnce();
    const thoughts: CreateThoughtSegmentInput[] = thoughtBulk.mock.calls[0][0];
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0].text).toBe("I will read.");
    expect(thoughts[0].sortOrder).toBe(0);
    expect(thoughts[1].text).toBe("Now respond.");
    expect(thoughts[1].sortOrder).toBe(2);
    expect(thoughts.every((t) => t.messageId === MSG_ID)).toBe(true);

    const toolCalls = toolBulk.mock.calls[0][0];
    expect(toolCalls[0].sortOrder).toBe(1);
  });

  it("records a hook execution between two tool calls with didBlock round-trip", async () => {
    const { providerEmitter, hookBulk } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-1",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookStarted,
      threadId: THREAD_ID,
      hookName: "PreToolUse",
      hookType: "permission",
      toolName: "Bash",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      hookName: "PreToolUse",
      exitCode: 0,
      durationMs: 17,
      didBlock: true,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-2",
      toolName: "Read",
      toolInput: { file_path: "/x" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(hookBulk).toHaveBeenCalledOnce();
    const hooks: CreateHookExecutionInput[] = hookBulk.mock.calls[0][0];
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hookName).toBe("PreToolUse");
    expect(hooks[0].toolName).toBe("Bash");
    expect(hooks[0].didBlock).toBe(true);
    expect(hooks[0].durationMs).toBe(17);
    // Tool#1 took sortOrder 0; hook 1; tool#2 2.
    expect(hooks[0].sortOrder).toBe(1);
    expect(hooks[0].messageId).toBe(MSG_ID);
  });

  it("persists late hooks (arriving after persistTurn) attached to the last message id", async () => {
    const { providerEmitter, hookBulk } = build();

    // The turn must have substance so TurnFinalizer materializes an assistant
    // row to attach the late hook to (#578: empty turns leave no row). A streamed
    // body satisfies the TurnSubstance predicate.
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "Done." });
    // Emit TurnComplete to simulate the SDK result arriving before hooks.
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    // Let persistTurn settle so lastPersistedMessageIdByThread is populated.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Now emit Stop hook events (as the SDK would after the result).
    providerEmitter.emit("event", {
      type: AgentEventType.HookStarted,
      threadId: THREAD_ID,
      hookName: "Stop",
      hookType: "stop",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      hookName: "Stop",
      exitCode: 0,
      durationMs: 42,
      didBlock: false,
    });

    // bulkCreate should have been called twice: once for mid-turn (empty array
    // skipped) and once for the late hook flush.
    // persistTurn's bulkCreate call is skipped because hooks list was empty.
    // The late hook flush calls bulkCreate with one item.
    expect(hookBulk).toHaveBeenCalledOnce();
    const lateHooks: CreateHookExecutionInput[] = hookBulk.mock.calls[0][0];
    expect(lateHooks).toHaveLength(1);
    expect(lateHooks[0].hookName).toBe("Stop");
    expect(lateHooks[0].messageId).toBe(MSG_ID);
    expect(lateHooks[0].phase).toBe("stop");
    expect(lateHooks[0].durationMs).toBe(42);
  });

  it("discards a late hook when the turn produced no recordable activity (no row to attach)", async () => {
    const { providerEmitter, hookBulk } = build();

    // A fully empty turn: no body, tool call, narration, or hook before finalize.
    // The TurnSubstance predicate is false, so no assistant row is materialized
    // (#578) and the finalizer records no last-persisted message id.
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // A late Stop hook now arrives but has nothing to attach to, so it is dropped.
    providerEmitter.emit("event", {
      type: AgentEventType.HookStarted,
      threadId: THREAD_ID,
      hookName: "Stop",
      hookType: "stop",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      hookName: "Stop",
      exitCode: 0,
      durationMs: 42,
      didBlock: false,
    });

    expect(hookBulk).not.toHaveBeenCalled();
  });

  it("marks a non-final thought as isFinalResponse when its text equals the assistant message body", async () => {
    const { providerEmitter, thoughtBulk, service } = build();
    const body = "FULL USER-FACING REPLY";
    const mockMsg: Message = {
      id: MSG_ID,
      thread_id: THREAD_ID,
      role: "assistant",
      content: body,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 2,
      attachments: null,
      is_internal: false,
    };
    (service as unknown as { messageRepo: MessageRepo }).messageRepo.listByThread = vi.fn(() => ({
      messages: [mockMsg],
      hasMore: false,
    }));

    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: body });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(thoughtBulk).toHaveBeenCalledOnce();
    const thoughts: CreateThoughtSegmentInput[] = thoughtBulk.mock.calls[0][0];
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe(body);
    expect(thoughts[0].isFinalResponse).toBe(1);
  });

  it("drops the open thought when AssistantMessageBoundary reports isFinalResponse=true", async () => {
    const { providerEmitter, thoughtBulk } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      delta: "Tool-free final answer",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      isFinalResponse: true,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(thoughtBulk).not.toHaveBeenCalled();
  });

  it("transfers boundary-final text to the assistant body owner when Message is absent", async () => {
    const { providerEmitter, thoughtBulk, service } = build();
    const body = "Tool-free final answer";
    const userMsg: Message = {
      id: "user-anchor",
      thread_id: THREAD_ID,
      role: "user",
      content: "go",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 1,
      attachments: null,
      is_internal: false,
    };
    const assistantMsg: Message = {
      id: MSG_ID,
      thread_id: THREAD_ID,
      role: "assistant",
      content: body,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 2,
      attachments: null,
      is_internal: false,
    };
    const messageRepo = (service as unknown as { messageRepo: MessageRepo }).messageRepo as
      & MessageRepo
      & { createAssistantIdempotent: ReturnType<typeof vi.fn> };
    messageRepo.listByThread = vi.fn(() => ({ messages: [userMsg], hasMore: false }));
    messageRepo.createAssistantIdempotent = vi.fn(() => assistantMsg);

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      delta: body,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      isFinalResponse: true,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(messageRepo.createAssistantIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ content: body }),
    );
    expect(thoughtBulk).not.toHaveBeenCalled();
  });

  it("persists preamble thought when AssistantMessageBoundary reports isFinalResponse=false", async () => {
    const { providerEmitter, thoughtBulk } = build();

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      delta: "Let me check that file.",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      isFinalResponse: false,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-read",
      toolName: "Read",
      toolInput: { file_path: "/a.ts" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(thoughtBulk).toHaveBeenCalledOnce();
    const thoughts: CreateThoughtSegmentInput[] = thoughtBulk.mock.calls[0][0];
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe("Let me check that file.");
    expect(thoughts[0].isFinalResponse).toBeUndefined();
  });
});
