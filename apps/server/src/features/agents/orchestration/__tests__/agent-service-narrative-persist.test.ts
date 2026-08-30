import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { AgentEventType } from "@mcode/contracts";
import type {
  AgentEvent,
  IProviderRegistry,
  Message,
  ProviderRuntimeEvent,
  ProviderRuntimeExtension,
  Thread,
} from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
import {
  createAgentServiceForTest,
  runtimeProviderEvent,
  startAgentServiceIngressForTest,
  streamAgentReliabilityTextForTest,
} from "./agent-service-test-harness.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { TaskPersistenceService } from "../../tasks/task-persistence-service.js";
import {
  ParentAssistantTextCheckpointService,
  PARENT_ASSISTANT_TEXT_RETAINED_LIMITS,
} from "../../turns/parent-assistant-text-checkpoint-service.js";
import { CanonicalAgentEventSink } from "../../canonical/canonical-agent-event-sink.js";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { broadcast } from "../../../../application/transport/push.js";
import { isTurnScopedEvent } from "../../turns/turn-runtime.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import type { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { MessageRepo as SqliteMessageRepo } from "../../conversation/persistence/message-repo.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type {
  ToolCallRecordRepo,
  CreateToolCallRecordInput,
} from "../../tools/persistence/tool-call-record-repo.js";
import type { ThoughtSegmentRepo, CreateThoughtSegmentInput } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import type { HookExecutionRepo, CreateHookExecutionInput } from "../../events/persistence/hook-execution-repo.js";
import type { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { TaskRepo } from "../persistence/task-repo.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";

type NarrativeTestTurnRuntime = {
  start: (threadId: string) => { turnExecutionId: string };
  snapshot: (threadId: string) => { turnExecutionId: string | null; phase: string } | undefined;
};

function normalizedNarrativeProviderEvent(event: Record<string, unknown>): Record<string, unknown> {
  return event.type === AgentEventType.TurnComplete
    ? { reason: "completed", costUsd: null, ...event }
    : event;
}

function needsNarrativeTurnExecutionId(event: unknown): event is Record<string, unknown> {
  return Boolean(
    event
    && typeof event === "object"
    && isTurnScopedEvent(event as Parameters<typeof isTurnScopedEvent>[0])
    && !(event as { turnExecutionId?: string }).turnExecutionId,
  );
}

function providerRuntimeEventForNarrativeTest(eventName: string, event: unknown): unknown {
  if (eventName !== "event" || !event || typeof event !== "object" || "event" in event) return event;
  return runtimeProviderEvent(event as AgentEvent);
}
import type { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { CodexCollaborationEventAdapter } from "../../collaboration/adapters/codex-collaboration-event-adapter.js";
import { ProviderEventIngress } from "../../../providers/composition/provider-event-ingress.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
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

function codexRuntimeEvent(
  event: AgentEvent,
  extension: Omit<ProviderRuntimeExtension, "providerId" | "kind">,
): ProviderRuntimeEvent {
  return {
    event,
    extension: {
      providerId: "codex",
      kind: "codex-collaboration",
      ...extension,
    },
  };
}

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
  canonicalSink: CanonicalAgentEventSink;
  db: Database.Database;
  thoughtBulk: ReturnType<typeof vi.fn>;
  hookBulk: ReturnType<typeof vi.fn>;
  toolBulk: ReturnType<typeof vi.fn>;
  taskAppend: ReturnType<typeof vi.fn>;
  taskUpsertGroup: ReturnType<typeof vi.fn>;
  taskUpdate: ReturnType<typeof vi.fn>;
  taskRemove: ReturnType<typeof vi.fn>;
  narrativeStore: NarrativeStore;
}

function build(options: {
  db?: Database.Database;
  canonicalSink?: CanonicalAgentEventSink;
  parentAssistantTextCheckpoints?: ParentAssistantTextCheckpointService;
  onProviderEvent?: (event: AgentEvent) => void;
} = {}): Built {
  const thread = makeThread();
  const providerEmitter = Object.assign(new EventEmitter(), {
    id: "codex" as const,
  });
  (providerEmitter as any).sendTurn = vi.fn(() => Promise.resolve());
  (providerEmitter as any).stopSession = vi.fn(() => Promise.resolve());

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
  let latestSequence = 2;
  const messageRepo = {
    listByThread: vi.fn(() => ({ messages: [{ id: MSG_ID, role: "assistant", sequence: 2 }] })),
    getLatestSequenceIncludingInternal: vi.fn(() => latestSequence),
    create: vi.fn((_threadId: string, _role: string, _content: string, sequence: number) => {
      latestSequence = Math.max(latestSequence, sequence);
      return { id: MSG_ID, sequence };
    }),
    findByIdInThread: vi.fn(),
    listByThreadUpToSequence: vi.fn(() => []),
    setAssistantOutcome: vi.fn(),
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
  const toolCallRecordRepo = {
    bulkCreate: toolBulk,
    bulkCreateBatched: toolBulk,
  } as unknown as ToolCallRecordRepo;
  const thoughtBulk = vi.fn();
  const thoughtSegmentRepo = {
    bulkCreate: thoughtBulk,
    bulkCreateBatched: thoughtBulk,
  } as unknown as ThoughtSegmentRepo;
  const hookBulk = vi.fn();
  const hookExecutionRepo = {
    bulkCreate: hookBulk,
    bulkCreateBatched: hookBulk,
  } as unknown as HookExecutionRepo;
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
  const db = options.db ?? ({
    name: ":memory:",
    transaction: vi.fn((fn: Function) => fn),
    prepare: vi.fn(() => ({ run: vi.fn() })),
  } as unknown as Database.Database);
  const canonicalSink = options.canonicalSink ?? createCanonicalAgentEventSinkStub(db);
  const parentAssistantTextCheckpoints = options.parentAssistantTextCheckpoints
    ?? new ParentAssistantTextCheckpointService(db);

  // The narrative write seam lives in NarrativeStore; build it from the same
  // repo mocks so the bulkCreate spies observe what AgentService delegates.
  const narrativeStore = new NarrativeStore(
    messageRepo,
    toolCallRecordRepo,
    thoughtSegmentRepo,
    hookExecutionRepo,
  );

  const service = createAgentServiceForTest(
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
    settingsService,
    availability,
    planQuestionAnswersRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      narrativeStore,
      parentAssistantTextCheckpoints,
      undefined,
      undefined,
      undefined,
      canonicalSink,
      undefined,
      new ProviderEventIngress(
        undefined,
        new CodexCollaborationEventAdapter(canonicalSink),
      ),
      undefined,
      undefined,
      undefined,
      new TaskPersistenceService(taskRepo, narrativeStore),
  );
  startAgentServiceIngressForTest(service, options.onProviderEvent);
  // Provider adapters always stamp turn-scoped events with the active execution
  // identity. Keep this fixture aligned with that production boundary while
  // leaving each test focused on the narrative payload it emits.
  const turnRuntime = (service as unknown as { turnRuntime: NarrativeTestTurnRuntime }).turnRuntime;
  turnRuntime.start(THREAD_ID);
  const emit = providerEmitter.emit.bind(providerEmitter);
  providerEmitter.emit = ((eventName: string, event?: unknown, ...args: unknown[]) => {
    if (eventName === "event" && event && typeof event === "object") {
      event = normalizedNarrativeProviderEvent(event as Record<string, unknown>);
      if (needsNarrativeTurnExecutionId(event)) {
        const runtime = turnRuntime.snapshot(THREAD_ID);
        event = { ...(event as Record<string, unknown>), turnExecutionId: runtime?.turnExecutionId };
      }
    }
    return emit(
      eventName,
      providerRuntimeEventForNarrativeTest(eventName, event),
      ...args,
    );
  }) as typeof providerEmitter.emit;
  // Prime per-thread state without running sendMessage's full path. The buffers
  // now live in NarrativeStore; seed them via the same public entry points
  // sendMessage uses (beginTurn + resetTurnCounters).
  narrativeStore.beginTurn(THREAD_ID);
  narrativeStore.resetTurnCounters(THREAD_ID);
  return {
    service,
    providerEmitter,
    canonicalSink,
    db,
    thoughtBulk,
    hookBulk,
    toolBulk,
    taskAppend,
    taskUpsertGroup,
    taskUpdate,
    taskRemove,
    narrativeStore,
  };
}

describe("AgentService narrative persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves unclassified text to narration and clears its assistant checkpoint at a false boundary", () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    const { providerEmitter, service } = build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-durable-text",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
    });

    vi.useFakeTimers();
    try {
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "durable ",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "text",
      });

      expect(published).toEqual([]);
      expect(db.prepare(
        "SELECT text FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?",
      ).all(executionId)).toEqual([]);

      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });

      expect(published
        .filter((event) => event.type === AgentEventType.TextDelta)
        .map((event) => event.delta))
        .toEqual(["durable ", "text"]);
      expect(db.prepare(`
        SELECT first_sequence, last_sequence, text
        FROM parent_assistant_text_checkpoint_chunks
        WHERE execution_id = ?
      `).all(executionId)).toEqual([]);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("starts a fresh retention window after each durable narration boundary", () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    const { providerEmitter, service } = build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-multiple-narration-segments",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
    });
    const firstSegment = Array.from({ length: 10 }, () => "a".repeat(14 * 1024));
    const secondSegment = Array.from({ length: 10 }, () => "b".repeat(14 * 1024));

    try {
      for (const segment of [firstSegment, secondSegment]) {
        for (const delta of segment) {
          providerEmitter.emit("event", {
            type: AgentEventType.TextDelta,
            threadId: THREAD_ID,
            turnExecutionId: executionId,
            delta,
          });
        }
        providerEmitter.emit("event", {
          type: AgentEventType.AssistantMessageBoundary,
          threadId: THREAD_ID,
          turnExecutionId: executionId,
          isFinalResponse: false,
        });
      }

      expect(published
        .filter((event) => event.type === AgentEventType.TextDelta)
        .map((event) => event.delta.length))
        .toEqual([...firstSegment, ...secondSegment].map((delta) => delta.length));
      expect(published.filter((event) => event.type === AgentEventType.AssistantMessageBoundary))
        .toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("holds a semantic boundary until delayed text reaches SQLite, then publishes both in provider order", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    let sqliteAvailable = false;
    const appendChunk = ParentAssistantTextCheckpointService.prototype.appendChunk;
    const appendSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "appendChunk")
      .mockImplementation(function (inputs) {
        if (!sqliteAvailable) throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        return appendChunk.call(this, inputs);
      });

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = build({
        db,
        canonicalSink,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = (service as unknown as {
        turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
      }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
      const messages = new SqliteMessageRepo(db);
      canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-delayed-semantic-boundary",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "delayed text",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });

      expect(published).toEqual([]);

      sqliteAvailable = true;
      await vi.advanceTimersByTimeAsync(250);

      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(appendSpy).toHaveBeenCalledTimes(3);
    } finally {
      appendSpy.mockRestore();
      vi.useRealTimers();
      db.close();
    }
  });

  it("holds the provider FIFO until the assistant-text baseline is readable", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    const restoreChunks = ParentAssistantTextCheckpointService.prototype.restoreChunks;
    const restoreChunksSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "restoreChunks")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      })
      .mockImplementation(function (executionId) {
        return restoreChunks.call(this, executionId);
      });

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = build({
        db,
        canonicalSink,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = (service as unknown as {
        turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
      }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
      const messages = new SqliteMessageRepo(db);
      canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-delayed-baseline",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "delayed baseline",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });

      expect(published).toEqual([]);

      await vi.advanceTimersByTimeAsync(250);
      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(restoreChunksSpy).toHaveBeenCalledTimes(3);
    } finally {
      restoreChunksSpy.mockRestore();
      vi.useRealTimers();
      db.close();
    }
  });

  it("stops before a queued non-text provider payload exceeds the FIFO byte limit", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const restoreChunksSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "restoreChunks")
      .mockImplementation(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      });

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = build({ db, canonicalSink, onProviderEvent: vi.fn() });
      const executionId = (service as unknown as {
        turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
      }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
      const messages = new SqliteMessageRepo(db);
      canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-oversized-event",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "blocked first",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        toolCallId: "oversized-result",
        output: "x".repeat(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes),
        isError: false,
      });

      expect((providerEmitter as unknown as { stopSession: ReturnType<typeof vi.fn> }).stopSession)
        .toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
      expect(service.runtimeSnapshots()).toContainEqual(expect.objectContaining({
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        phase: "interrupted",
      }));
    } finally {
      restoreChunksSpy.mockRestore();
      vi.useRealTimers();
      db.close();
    }
  });

  it("stops before a deeply nested queued provider payload can exhaust the event pump", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const restoreChunksSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "restoreChunks")
      .mockImplementation(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      });
    const nestedInput: Record<string, unknown> = {};
    let current = nestedInput;
    for (let index = 0; index < 60_000; index += 1) {
      const child: Record<string, unknown> = {};
      current.child = child;
      current = child;
    }

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = build({ db, canonicalSink, onProviderEvent: vi.fn() });
      const executionId = (service as unknown as {
        turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
      }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
      const messages = new SqliteMessageRepo(db);
      canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-deep-event",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "blocked first",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        toolCallId: "deep-tool",
        toolName: "Read",
        toolInput: nestedInput,
      });

      expect((providerEmitter as unknown as { stopSession: ReturnType<typeof vi.fn> }).stopSession)
        .toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
      expect(service.runtimeSnapshots()).toContainEqual(expect.objectContaining({
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        phase: "interrupted",
      }));
    } finally {
      restoreChunksSpy.mockRestore();
      vi.useRealTimers();
      db.close();
    }
  });

  it("resumes a journal-blocked boundary after SQLite recovers without another provider event", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-agent-journal-"));
    const filesystem = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(existsSync).mockImplementation(filesystem.existsSync);
    vi.mocked(statSync).mockImplementation(filesystem.statSync);
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const journalService = new ParentAssistantTextCheckpointService(
      db,
      undefined,
      { directory: journalDirectory },
    );
    const published: AgentEvent[] = [];
    let sqliteAvailable = false;
    const appendChunk = journalService.appendChunk.bind(journalService);
    const appendRecoveredChunk = journalService.appendRecoveredChunk.bind(journalService);
    const appendChunkSpy = vi.spyOn(journalService, "appendChunk")
      .mockImplementation((inputs) => {
        if (!sqliteAvailable) throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        return appendChunk(inputs);
      });
    const appendRecoveredChunkSpy = vi.spyOn(journalService, "appendRecoveredChunk")
      .mockImplementation((input) => {
        if (!sqliteAvailable) throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        return appendRecoveredChunk(input);
      });

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = build({
        db,
        canonicalSink,
        parentAssistantTextCheckpoints: journalService,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = (service as unknown as {
        turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
      }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
      const messages = new SqliteMessageRepo(db);
      canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-journal-boundary",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "journaled text",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });

      expect(published.map((event) => event.type)).toEqual([AgentEventType.TextDelta]);

      sqliteAvailable = true;
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();

      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
    } finally {
      appendChunkSpy.mockRestore();
      appendRecoveredChunkSpy.mockRestore();
      vi.mocked(existsSync).mockImplementation(() => true);
      vi.mocked(statSync).mockImplementation(() => ({ isDirectory: () => true }) as ReturnType<typeof statSync>);
      vi.useRealTimers();
      db.close();
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly unsaved narration boundary in memory without creating a recovery projection", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    const appendSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "appendChunk")
      .mockImplementation(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      });

    try {
      const { providerEmitter, service, narrativeStore } = build({
        db,
        canonicalSink,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = (service as unknown as {
        turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
      }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
      const messages = new SqliteMessageRepo(db);
      canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-unsaved-narration",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "visible but unsaved",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });

      expect(published).toEqual([]);

      service.continueWithoutSaving(executionId);
      await Promise.resolve();

      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(narrativeStore.recoverySnapshot(THREAD_ID)).toEqual([
        expect.objectContaining({
          kind: "narrationSegment",
          record: expect.objectContaining({ text: "visible but unsaved" }),
        }),
      ]);
      expect(canonicalSink.loadParentNarrativeRecovery("turn-unsaved-narration")).toEqual([]);
    } finally {
      appendSpy.mockRestore();
      db.close();
    }
  });

  it("retains provisional text and withholds the boundary when narration recovery fails", () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    const { providerEmitter, service, thoughtBulk, narrativeStore } = build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-rejected-narration",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
    });

    vi.useFakeTimers();
    try {
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "provisional text",
      });
      vi.advanceTimersByTime(250);
      expect(published).toHaveLength(1);
      published.length = 0;
      db.exec(`
        CREATE TRIGGER reject_narration_recovery
        BEFORE INSERT ON canonical_agent_items
        WHEN json_extract(NEW.payload_json, '$.projection') = 'narrativeRecovery'
        BEGIN
          SELECT RAISE(ABORT, 'forced narration recovery failure');
        END;
      `);

      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });

      expect(published).toEqual([]);
      expect(db.prepare(`
        SELECT text FROM parent_assistant_text_checkpoint_chunks
        WHERE execution_id = ?
      `).all(executionId)).toEqual([{ text: "provisional text" }]);
      expect(canonicalSink.loadParentNarrativeRecovery("turn-rejected-narration")).toEqual([]);
      expect(narrativeStore.recoverySnapshot(THREAD_ID)).toEqual([]);
      expect(thoughtBulk).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("commits narration classification before it publishes the covered text delta", () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const observed: Array<{ type: string; persisted: string | undefined }> = [];
    const { providerEmitter, service } = build({
      db,
      canonicalSink,
      onProviderEvent: (event) => {
        const row = db.prepare(`
          SELECT payload_json FROM canonical_agent_items
          WHERE json_extract(payload_json, '$.projection') = 'narrativeRecovery'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get() as { payload_json: string } | undefined;
        observed.push({ type: event.type, persisted: row?.payload_json });
      },
    });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-narration-before-publish",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
    });

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      delta: "I will inspect the child.",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      isFinalResponse: false,
    });

    expect(observed.at(-1)).toMatchObject({
      type: AgentEventType.AssistantMessageBoundary,
      persisted: expect.stringContaining("I will inspect the child."),
    });
    expect(observed.at(-1)?.persisted).not.toContain("turnExecutionId");
    db.close();
  });

  it("commits and publishes the private unfinished reliability prefix", () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    const { service } = build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    (service as unknown as { messageRepo: MessageRepo }).messageRepo = new SqliteMessageRepo(db);

    try {
      const stream = streamAgentReliabilityTextForTest(service, THREAD_ID);

      expect(stream).toMatchObject({
        threadId: THREAD_ID,
        text: "Durable assistant prefix for restart recovery.",
      });
      expect(published).toEqual([{
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: stream.executionId,
        delta: stream.text,
        isFinalResponse: true,
      }]);
      expect(db.prepare(`
        SELECT first_sequence, last_sequence, text
        FROM parent_assistant_text_checkpoint_chunks
        WHERE execution_id = ?
      `).all(stream.executionId)).toEqual([{
        first_sequence: 1,
        last_sequence: 1,
        text: stream.text,
      }]);
    } finally {
      db.close();
    }
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

    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "I will ", isFinalResponse: false });
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "read.", isFinalResponse: false });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-1",
      toolName: "Read",
      toolInput: { file_path: "/a" },
    });
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "Now respond.", isFinalResponse: false });
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

  it("publishes each late hook once after the terminal projection is durable", async () => {
    const published: AgentEvent[] = [];
    const publicationOrder: string[] = [];
    vi.mocked(broadcast).mockReset();
    const { service, providerEmitter, hookBulk } = build({
      onProviderEvent: (event) => {
        published.push(event);
        if (event.type === AgentEventType.HookStarted || event.type === AgentEventType.HookCompleted) {
          publicationOrder.push(`provider:${event.type}`);
        }
      },
    });
    const finalizer = (service as unknown as {
      turnFinalizer: {
        finalize: (...args: unknown[]) => Promise<void>;
        getLastPersistedMessageId: (threadId: string) => string | undefined;
      };
    }).turnFinalizer;
    let completeFinalization!: () => void;
    vi.spyOn(finalizer, "finalize").mockReturnValue(new Promise<void>((resolve) => {
      completeFinalization = resolve;
    }));
    vi.spyOn(finalizer, "getLastPersistedMessageId").mockReturnValue(MSG_ID);
    vi.mocked(broadcast).mockImplementation(((channel: string, payload: unknown) => {
      if (channel === "agent.event"
        && typeof payload === "object"
        && payload !== null
        && (payload as { type?: string }).type === AgentEventType.HookCompleted) {
        publicationOrder.push("broadcast:hookCompleted");
      }
    }) as typeof broadcast);

    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });
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

    expect(published.filter((event) => (
      event.type === AgentEventType.HookStarted || event.type === AgentEventType.HookCompleted
    ))).toEqual([]);
    expect(hookBulk).not.toHaveBeenCalled();

    completeFinalization();

    await vi.waitFor(() => {
      expect(hookBulk).toHaveBeenCalledOnce();
      expect(publicationOrder).toEqual([
        "provider:hookStarted",
        "broadcast:hookCompleted",
      ]);
    });
    expect(published.filter((event) => event.type === AgentEventType.HookCompleted)).toEqual([]);
    const completedBroadcasts = vi.mocked(broadcast).mock.calls.filter(([channel, payload]) => (
      channel === "agent.event"
      && typeof payload === "object"
      && payload !== null
      && (payload as { type?: string }).type === AgentEventType.HookCompleted
    ));
    expect(completedBroadcasts).toHaveLength(1);
    expect(completedBroadcasts[0]?.[1]).toMatchObject({
      persistedMessageId: MSG_ID,
      persistedHookId: expect.any(String),
    });
  });

  it("retains an owned completed late hook when terminal finalization fails", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const published: AgentEvent[] = [];
    const { service, providerEmitter, hookBulk, narrativeStore } = build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-late-hook-failure",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
    });
    const finalizer = (service as unknown as {
      turnFinalizer: { finalize: (...args: unknown[]) => Promise<void> };
    }).turnFinalizer;
    vi.spyOn(finalizer, "finalize").mockRejectedValue(new Error("forced terminal failure"));

    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      hookName: "Stop",
      hookType: "stop",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      hookName: "Stop",
      exitCode: 0,
      durationMs: 42,
      didBlock: false,
    });

    await vi.waitFor(() => {
      expect(canonicalSink.loadParentNarrativeRecovery("turn-late-hook-failure")).toEqual([
        expect.objectContaining({
          kind: "hook",
          record: expect.objectContaining({
            hook_name: "Stop",
            ended_at: expect.any(String),
            duration_ms: 42,
          }),
        }),
      ]);
    });
    expect(narrativeStore.recoverySnapshot(THREAD_ID)).toEqual([
      expect.objectContaining({ kind: "hook", record: expect.objectContaining({ hook_name: "Stop" }) }),
    ]);
    expect(hookBulk).not.toHaveBeenCalled();
    expect(published.filter((event) => (
      event.type === AgentEventType.HookStarted || event.type === AgentEventType.HookCompleted
    ))).toEqual([]);
    db.close();
  });

  it("publishes an unmatched late completion through the normal event publisher", async () => {
    const published: AgentEvent[] = [];
    vi.mocked(broadcast).mockReset();
    const { service, providerEmitter } = build({ onProviderEvent: (event) => published.push(event) });
    const finalizer = (service as unknown as {
      turnFinalizer: { finalize: (...args: unknown[]) => Promise<void> };
    }).turnFinalizer;
    let completeFinalization!: () => void;
    vi.spyOn(finalizer, "finalize").mockReturnValue(new Promise<void>((resolve) => {
      completeFinalization = resolve;
    }));

    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      hookName: "UnmatchedStop",
      exitCode: 0,
      durationMs: 1,
      didBlock: false,
    });

    expect(published.filter((event) => event.type === AgentEventType.HookCompleted)).toEqual([]);
    completeFinalization();

    await vi.waitFor(() => {
      expect(published.filter((event) => event.type === AgentEventType.HookCompleted)).toEqual([
        expect.objectContaining({
          hookName: "UnmatchedStop",
          durationMs: 1,
        }),
      ]);
    });
    expect("persistedHookId" in published.find((event) => (
      event.type === AgentEventType.HookCompleted
    ))!).toBe(false);
    expect(vi.mocked(broadcast).mock.calls.filter(([channel, payload]) => (
      channel === "agent.event"
      && typeof payload === "object"
      && payload !== null
      && (payload as { type?: string }).type === AgentEventType.HookCompleted
    ))).toHaveLength(0);
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

    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: body, isFinalResponse: false });
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
      isFinalResponse: false,
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

  it("routes provider Codex child evidence through canonical recovery and keeps its payload out of the parent", () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "codex", now, now);
    const published = vi.fn();
    const canonicalSink = new CanonicalAgentEventSink(db, published);
    const { providerEmitter, service, narrativeStore } = build({ db, canonicalSink });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    const userMessage = messages.create(THREAD_ID, "user", "delegate", 1);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "codex", createdAt: now },
      turnId: "turn-provider-parent",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => userMessage,
    });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-from-provider",
      toolName: "Agent",
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        prompt: "secret child prompt",
        receiverThreadIds: ["provider-child-thread"],
      },
    }));
    const provisional = canonicalSink.loadCodexChildDelegation(
      THREAD_ID,
      "toolCall:spawn-from-provider",
    );
    expect(provisional?.childThread.activityState).toBe("Starting");
    expect(narrativeStore.getBufferedToolCalls(THREAD_ID).find(
      (toolCall) => toolCall.toolCallId === "spawn-from-provider",
    )?._rawToolInput).not.toHaveProperty("prompt");

    const childEvidence = {
      nativeThreadId: "provider-child-thread",
      nativeTurnId: "provider-child-turn",
      parentCollaborationItemId: "spawn-from-provider",
      prompt: "secret child prompt",
    };
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: childEvidence }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "provider-child-tool",
      toolName: "Read",
      toolInput: { path: "secret-child-input" },
    }, { child: { ...childEvidence, nativeItemId: "provider-child-tool", itemEventKey: "started" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "provider-child-tool",
      output: "secret-child-output",
      isError: false,
    }, { child: { ...childEvidence, nativeItemId: "provider-child-tool", itemEventKey: "completed" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      delta: "secret-child-narration",
      isFinalResponse: false,
    }, { child: { ...childEvidence, nativeItemId: "provider-child-reasoning", itemEventKey: "completed" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.Message,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "secret-child-message",
      tokens: null,
    }, { child: { ...childEvidence, nativeItemId: "provider-child-message", itemEventKey: "completed" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: childEvidence }));

    const child = canonicalSink.loadCodexChildDelegation(
      THREAD_ID,
      "toolCall:spawn-from-provider",
    )!;
    const parentMessage = messages.create(THREAD_ID, "assistant", "parent answer", 2);
    canonicalSink.finishParentTurn({
      threadId: THREAD_ID,
      turnId: "turn-provider-parent",
      executionId,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed",
      projectTurn: () => ({
        message: parentMessage,
        narrative: [
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 0,
            record: {
              id: "spawn-from-provider",
              message_id: parentMessage.id,
              parent_tool_call_id: null,
              tool_name: "Agent",
              tool_input: { codexCollabKind: "spawnAgent" },
              started_at: now,
              completed_at: now,
              status: "completed",
            } as never,
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 1,
            record: {
              id: "provider-child-tool",
              message_id: parentMessage.id,
              parent_tool_call_id: "spawn-from-provider",
              tool_name: "Read",
              input_summary: "secret-child-input",
              output_summary: "secret-child-output",
              started_at: now,
              completed_at: now,
              status: "completed",
              sort_order: 1,
            },
          },
        ],
      }),
    });

    const childRows = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(child.childThread.id) as Array<{ payload_json: string }>;
    const parentRows = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(THREAD_ID) as Array<{ payload_json: string }>;
    expect(JSON.stringify(childRows)).toContain("secret-child-output");
    expect(JSON.stringify(childRows)).toContain("secret-child-message");
    expect(JSON.stringify(childRows)).toContain("secret-child-narration");
    expect(JSON.stringify(childRows)).toContain("secret child prompt");
    expect(JSON.stringify(parentRows)).not.toContain("secret-child-output");
    expect(JSON.stringify(parentRows)).not.toContain("secret-child-message");
    expect(JSON.stringify(parentRows)).not.toContain("secret-child-narration");
    expect(JSON.stringify(parentRows)).not.toContain("secret child prompt");
    expect(canonicalSink.loadTurn(child.collaborationAction.target.turnId!)?.status).toBe("Interrupted");
  });

  it("registers a nested Codex child under its emitting canonical child and binds its native turn", () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-nested", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-nested", "Parent", "main", "codex", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const { providerEmitter, service } = build({ db, canonicalSink });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    const userMessage = messages.create(THREAD_ID, "user", "delegate", 1);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-nested", providerId: "codex", createdAt: now },
      turnId: "turn-nested-parent",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => userMessage,
    });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "root-spawn",
      toolName: "Agent",
      toolInput: {},
    }, { collaboration: {
      kind: "spawnAgent",
        agentName: "Direct child",
        receiverThreadIds: ["native-direct-child"],
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
    } }));

    const directChild = canonicalSink.loadThreadByProviderIdentity({
      providerId: "codex",
      scope: "thread",
      value: "native-direct-child",
      provenance: "native",
    });
    const directTurn = directChild
      ? canonicalSink.loadTurnByProviderIdentity(directChild.id, {
          providerId: "codex",
          scope: "turn",
          value: "native-direct-turn",
          provenance: "native",
        })
      : null;
    expect(directChild).toBeTruthy();
    expect(directTurn).toMatchObject({ threadId: directChild!.id });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "nested-spawn",
      toolName: "Agent",
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        agentName: "Nested child",
        receiverThreadIds: ["native-nested-child"],
      },
      child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "nested-spawn",
        itemEventKey: "started",
      },
    }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "nested-spawn",
      toolName: "Agent",
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        agentName: "Nested child",
        receiverThreadIds: ["native-nested-child"],
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      },
      child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "nested-spawn",
        itemEventKey: "started",
      },
    }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-nested-child",
        nativeTurnId: "native-nested-turn",
        parentCollaborationItemId: "nested-spawn",
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "completed",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    }, { child: {
        nativeThreadId: "native-nested-child",
        nativeTurnId: "native-nested-turn",
        parentCollaborationItemId: "nested-spawn",
        nativeItemId: "native-nested-turn",
        itemEventKey: "completed",
        outcome: "completed",
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "nested-spawn",
      output: "",
      isError: false,
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        agentName: "Nested child",
        receiverThreadIds: ["native-nested-child"],
      },
      child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "nested-spawn",
        itemEventKey: "completed",
      },
    }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.Message,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "direct child continues after nested spawn",
      tokens: null,
    }, { child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "direct-child-follow-up",
        itemEventKey: "completed",
    } }));

    const directItems = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ? AND kind = 'tool-call'",
    ).all(directChild!.id) as Array<{ payload_json: string }>;
    const directItemPayloads = directItems.map((row) => JSON.parse(row.payload_json));
    expect(directItemPayloads).toContainEqual(expect.objectContaining({
      projection: "codexChildToolCall",
      toolName: "Agent",
      toolInput: expect.objectContaining({ codexCollabKind: "spawnAgent" }),
    }));
    expect(directItemPayloads.filter((payload) => (
      payload.projection === "codexChildToolCall" && payload.nativeItemId === "nested-spawn"
    ))).toHaveLength(1);

    const nestedChild = canonicalSink.loadThreadByProviderIdentity({
      providerId: "codex",
      scope: "thread",
      value: "native-nested-child",
      provenance: "native",
    });
    const nestedTurn = nestedChild
      ? canonicalSink.loadTurnByProviderIdentity(nestedChild.id, {
          providerId: "codex",
          scope: "turn",
          value: "native-nested-turn",
          provenance: "native",
        })
      : null;
    expect(nestedChild).toBeTruthy();
    expect(nestedTurn).toMatchObject({
      threadId: nestedChild!.id,
      trigger: {
        kind: "child",
        sourceThreadId: directChild!.id,
        sourceTurnId: directTurn!.id,
      },
    });
    const directPayloads = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(directChild!.id) as Array<{ payload_json: string }>;
    const nestedPayloads = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(nestedChild!.id) as Array<{ payload_json: string }>;
    const directChildContinuation = {
      projection: "message",
      message: { content: "direct child continues after nested spawn" },
    };
    const nestedSpawnResult = {
      projection: "codexChildToolResult",
      output: "",
      isError: false,
    };
    expect(directPayloads.map((row) => JSON.parse(row.payload_json))).toContainEqual(
      expect.objectContaining({
        projection: directChildContinuation.projection,
        message: expect.objectContaining(directChildContinuation.message),
      }),
    );
    expect(directPayloads.map((row) => JSON.parse(row.payload_json))).toContainEqual(
      expect.objectContaining(nestedSpawnResult),
    );
    expect(nestedPayloads.map((row) => JSON.parse(row.payload_json))).not.toContainEqual(
      expect.objectContaining({
        projection: directChildContinuation.projection,
        message: expect.objectContaining(directChildContinuation.message),
      }),
    );
    expect(nestedPayloads.map((row) => JSON.parse(row.payload_json))).not.toContainEqual(
      expect.objectContaining(nestedSpawnResult),
    );

    const roster = canonicalSink.loadSubagentRoster({ owningParentThreadId: THREAD_ID });
    const rosterRows = [...roster.active, ...roster.done];
    const nestedRow = rosterRows.find((row) => row.id === nestedChild!.id);
    expect(nestedRow).toMatchObject({
      id: nestedChild!.id,
      parentThreadId: directChild!.id,
      lineage: [THREAD_ID, directChild!.id, nestedChild!.id],
      model: "gpt-5.6-sol",
      reasoning: "medium",
    });
    expect(rosterRows.filter((row) => row.parentThreadId === THREAD_ID).map((row) => row.id))
      .toEqual([directChild!.id]);
    expect(rosterRows.filter((row) => row.parentThreadId === directChild!.id).map((row) => row.id))
      .toEqual([nestedChild!.id]);
    const parentItemPayloads = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(THREAD_ID) as Array<{ payload_json: string }>;
    expect(parentItemPayloads.map((row) => JSON.parse(row.payload_json)).filter((payload) => (
      payload.projection === "codexChildRoutingFailure"
    ))).toHaveLength(0);
  });

  it("persists an actionable parent failure record when child persistence fails", () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-failure", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-failure", "Parent", "main", "codex", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const { providerEmitter, service } = build({ db, canonicalSink });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    const userMessage = messages.create(THREAD_ID, "user", "delegate", 1);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-failure", providerId: "codex", createdAt: now },
      turnId: "turn-provider-failure",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => userMessage,
    });
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-failure",
      toolName: "Agent",
      toolInput: {},
    }, { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-failure-child"] } }));
    const provisional = canonicalSink.loadCodexChildDelegation(
      THREAD_ID,
      "toolCall:spawn-failure",
    )!;
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-failure-child",
        nativeTurnId: "native-failure-turn",
        parentCollaborationItemId: "spawn-failure",
    } }));
    (canonicalSink as unknown as {
      recordCodexChildItem: (...args: unknown[]) => never;
    }).recordCodexChildItem = vi.fn(() => {
      throw new Error("injected child persistence failure");
    });
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "child-failure-tool",
      toolName: "Read",
      toolInput: { path: "child-secret" },
    }, { child: {
        nativeThreadId: "native-failure-child",
        nativeTurnId: "native-failure-turn",
        parentCollaborationItemId: "spawn-failure",
        nativeItemId: "child-failure-tool",
        itemEventKey: "started",
    } }));

    const parentFailure = db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE thread_id = ? AND kind = 'error'
    `).get(THREAD_ID) as { payload_json: string } | undefined;
    expect(parentFailure).toBeDefined();
    expect(JSON.parse(parentFailure!.payload_json)).toMatchObject({
      projection: "codexChildRoutingFailure",
      status: "action-required",
      recovery: "retry-child-routing",
      reason: "injected child persistence failure",
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM canonical_agent_items WHERE thread_id = ? AND kind = 'tool-call'",
    ).get(provisional.childThread.id)).toEqual({ count: 0 });
  });

  it("persists a parent collaboration ToolUse and acknowledges its matching ToolResult", () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-action", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-action", "Parent", "main", "codex", now, now);
    const canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
    const { providerEmitter, service } = build({ db, canonicalSink });
    const executionId = (service as unknown as {
      turnRuntime: { snapshot: (threadId: string) => { turnExecutionId: string } | undefined };
    }).turnRuntime.snapshot(THREAD_ID)!.turnExecutionId;
    const messages = new SqliteMessageRepo(db);
    const userMessage = messages.create(THREAD_ID, "user", "delegate", 1);
    canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-action", providerId: "codex", createdAt: now },
      turnId: "turn-provider-action",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => userMessage,
    });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-action-child",
      toolName: "Agent",
      toolInput: {},
    }, { collaboration: {
        kind: "spawnAgent",
        receiverThreadIds: ["native-action-child"],
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-action-child",
      toolInput: {},
      output: "ready",
      isError: false,
    }, { collaboration: {
        kind: "spawnAgent",
        agentName: "Mendel",
        receiverThreadIds: ["native-action-child"],
    } }));
    expect(canonicalSink.loadSubagentRoster({ owningParentThreadId: THREAD_ID }).active[0]?.identity)
      .toBe("Mendel");
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-action-child",
        nativeTurnId: "native-action-turn",
        parentCollaborationItemId: "spawn-action-child",
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "parent-message-child",
      toolName: "sendInput",
      toolInput: {},
    }, { collaboration: {
        kind: "sendInput",
        receiverThreadIds: ["native-action-child"],
        prompt: "Inspect this case.",
    } }));

    const dispatched = db.prepare(`
      SELECT id, source_item_id, status, target_turn_id
      FROM canonical_collaboration_actions
      WHERE source_item_id = ?
    `).get("toolCall:parent-message-child") as {
      id: string;
      source_item_id: string;
      status: string;
      target_turn_id: string | null;
    } | undefined;
    expect(dispatched).toMatchObject({
      source_item_id: "toolCall:parent-message-child",
      status: "Dispatched",
    });
    expect(dispatched?.target_turn_id).toBeTruthy();
    expect(db.prepare("SELECT thread_id, turn_id FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:parent-message-child")).toMatchObject({ thread_id: THREAD_ID });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "parent-message-child",
      toolName: "sendInput",
      toolInput: {},
      output: "delivered",
      isError: false,
    }, { collaboration: {
        kind: "sendInput",
        receiverThreadIds: ["native-action-child"],
    } }));

    expect(db.prepare("SELECT status FROM canonical_collaboration_actions WHERE id = ?")
      .get(dispatched!.id)).toEqual({ status: "Acknowledged" });
    expect(db.prepare("SELECT target_turn_id FROM canonical_collaboration_actions WHERE id = ?")
      .get(dispatched!.id)).toEqual({ target_turn_id: dispatched!.target_turn_id });
  });

  it("rejects provider continuation evidence targeting another canonical thread", () => {
    const { service: _service, canonicalSink } = build();
    const sink = canonicalSink as unknown as {
      loadThreadByProviderIdentity: ReturnType<typeof vi.fn>;
      loadTurnByProviderIdentity: ReturnType<typeof vi.fn>;
      loadCollaborationActionBySourceProviderIdentity: ReturnType<typeof vi.fn>;
      loadExecutionIdForTurn: ReturnType<typeof vi.fn>;
      loadThread: ReturnType<typeof vi.fn>;
      startProviderContinuation: ReturnType<typeof vi.fn>;
    };
    sink.loadThreadByProviderIdentity = vi.fn((identity: { value: string }) => (
      identity.value === "native-source-child"
        ? { id: "source-child" }
        : { id: "another-parent" }
    ));
    sink.loadTurnByProviderIdentity = vi.fn(() => ({
      id: "source-child-turn",
      threadId: "source-child",
    }));
    sink.loadCollaborationActionBySourceProviderIdentity = vi.fn();
    sink.loadExecutionIdForTurn = vi.fn(() => "00000000-0000-4000-8000-000000000098");
    sink.loadThread = vi.fn(() => ({ id: THREAD_ID }));
    sink.startProviderContinuation = vi.fn();
    sink.recordCodexChildRoutingDiagnostic = vi.fn(() => true);

    const projection = new CodexCollaborationEventAdapter(canonicalSink).project({
      providerId: "codex",
      sourceKind: "provider-runtime",
      event: {
        type: AgentEventType.TurnStarted,
        threadId: THREAD_ID,
        turnExecutionId: "00000000-0000-4000-8000-000000000099",
      },
      runtimeExtension: {
        providerId: "codex",
        kind: "codex-collaboration",
        continuation: {
        sourceNativeThreadId: "native-source-child",
        sourceNativeTurnId: "native-source-turn",
        sourceNativeItemId: "native-return-parent",
        targetNativeThreadId: "native-wrong-parent",
        },
      },
    });

    expect(projection.status).toBe("rejected");
    expect(sink.loadCollaborationActionBySourceProviderIdentity).toHaveBeenCalled();
    expect(sink.startProviderContinuation).not.toHaveBeenCalled();
    expect(sink.recordCodexChildRoutingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "continuation-evidence-not-found",
      threadId: "source-child",
      executionId: "00000000-0000-4000-8000-000000000098",
    }));
  });

  it("records a failure signal when attributed child routing lacks parent execution context", () => {
    const { service: _service, canonicalSink } = build();
    const diagnostic = vi.fn(() => true);
    (canonicalSink as unknown as {
      recordCodexChildRoutingDiagnostic: typeof diagnostic;
    }).recordCodexChildRoutingDiagnostic = diagnostic;

    const projection = new CodexCollaborationEventAdapter(canonicalSink).project({
      providerId: "codex",
      sourceKind: "provider-runtime",
      event: {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        toolCallId: "child-failure",
        toolName: "Read",
        toolInput: {},
      },
      runtimeExtension: {
        providerId: "codex",
        kind: "codex-collaboration",
        child: {
        nativeThreadId: "child-native",
        nativeTurnId: "child-turn",
        parentCollaborationItemId: "missing-parent-item",
        },
      },
    });

    expect(projection.status).toBe("rejected");
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      reason: "missing-parent-execution",
      threadId: THREAD_ID,
    }));
  });

  it("consumes every child projection kind before parent narrative persistence", () => {
    const { service: _service, canonicalSink, thoughtBulk, hookBulk, toolBulk } = build();
    (canonicalSink as unknown as {
      recordCodexChildRoutingDiagnostic: () => boolean;
    }).recordCodexChildRoutingDiagnostic = vi.fn(() => true);
    const adapter = new CodexCollaborationEventAdapter(canonicalSink);
    const evidence = {
      nativeThreadId: "child-boundary-thread",
      nativeTurnId: "child-boundary-turn",
      parentCollaborationItemId: "boundary-parent-item",
    };
    const events = [
      { type: AgentEventType.Message, content: "child message", tokens: null },
      { type: AgentEventType.TextDelta, delta: "child reasoning", isFinalResponse: false },
      { type: AgentEventType.ToolUse, toolCallId: "child-boundary-tool", toolName: "Read", toolInput: {} },
      { type: AgentEventType.ToolResult, toolCallId: "child-boundary-tool", output: "child result", isError: false },
      { type: AgentEventType.Error, error: "child error" },
      { type: AgentEventType.TurnComplete, reason: "completed", costUsd: null, tokensIn: 0, tokensOut: 0 },
    ];
    for (const event of events) {
      expect(adapter.project({
        providerId: "codex",
        sourceKind: "provider-runtime",
        event: { threadId: THREAD_ID, ...event } as AgentEvent,
        runtimeExtension: {
          providerId: "codex",
          kind: "codex-collaboration",
          child: evidence,
        },
      }).status).toBe("rejected");
    }
    expect(toolBulk).not.toHaveBeenCalled();
    expect(thoughtBulk).not.toHaveBeenCalled();
    expect(hookBulk).not.toHaveBeenCalled();
  });

  it("fails closed when an attributed child event has no canonical owner", () => {
    const { service: _service, canonicalSink } = build();
    const diagnostic = vi.fn(() => false);
    (canonicalSink as unknown as {
      recordCodexChildRoutingDiagnostic: typeof diagnostic;
    }).recordCodexChildRoutingDiagnostic = diagnostic;
    const adapter = new CodexCollaborationEventAdapter(canonicalSink);

    expect(adapter.project({
      providerId: "codex",
      sourceKind: "provider-runtime",
      event: {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        toolCallId: "child-unowned",
        toolName: "Read",
        toolInput: {},
      },
      runtimeExtension: {
        providerId: "codex",
        kind: "codex-collaboration",
        child: {
        nativeThreadId: "child-unowned-thread",
        nativeTurnId: "child-unowned-turn",
        parentCollaborationItemId: "missing-parent-item",
        },
      },
    }).status).toBe("rejected");
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });

  it("withholds terminal provider publication when final durability fails", async () => {
    const published: AgentEvent[] = [];
    const { service, providerEmitter } = build({ onProviderEvent: (event) => published.push(event) });
    (service as unknown as { turnFinalizer: { finalize: () => Promise<void> } }).turnFinalizer.finalize =
      vi.fn(() => Promise.reject(new Error("terminal write failed")));

    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(published).not.toContainEqual(expect.objectContaining({
      type: AgentEventType.TurnComplete,
    }));
  });
});
