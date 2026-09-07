import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as NodeEvents from "node:events";
import type { Thread, IProviderRegistry, TurnRequest } from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
import {
  createAgentServiceForTest,
  startAgentServiceIngressForTest,
  wrapProviderEmitterForRuntimeEvents,
} from "./agent-service-test-harness.js";
import { publishParentProviderEvent } from "../../events/provider-event-publication.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
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

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

const THREAD_ID = "thread-retry-test";

/** Thread fixture that resumes a live SDK session, so the first attempt sends `resumeFrom`. */
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
    sdk_session_id: "sess-abc",
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

/** Build an AgentService over a fake provider whose `sendTurn` the test scripts per attempt. */
function buildService(): {
  service: AgentService;
  sendTurn: ReturnType<typeof vi.fn>;
  discardSession: ReturnType<typeof vi.fn>;
  waitForSessionExit: ReturnType<typeof vi.fn>;
  threadControlMcp: { activate: ReturnType<typeof vi.fn> };
  providerEmitter: NodeEvents.EventEmitter;
  messageRepo: MessageRepo;
  mutationReservations: ThreadControlMutationReservationService;
  threadRepo: ThreadRepo & { clearSdkSessionId: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };
} {
  const thread = makeThread();
  const providerEmitter = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
    id: "claude" as const,
  }));
  const sendTurn = vi.fn(() => Promise.resolve());
  (providerEmitter as unknown as { sendTurn: typeof sendTurn }).sendTurn = sendTurn;
  const stopSession = vi.fn().mockResolvedValue(undefined);
  (providerEmitter as unknown as { stopSession: typeof stopSession }).stopSession = stopSession;
  // Implementing discardSession makes the fake provider ISessionEvictable, so
  // the retry path force-evicts the pooled session before re-dispatch.
  const discardSession = vi.fn();
  const waitForSessionExit = vi.fn().mockResolvedValue(undefined);
  (providerEmitter as unknown as { discardSession: typeof discardSession }).discardSession = discardSession;
  (providerEmitter as unknown as { waitForSessionExit: typeof waitForSessionExit }).waitForSessionExit =
    waitForSessionExit;

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
    clearSdkSessionId: vi.fn(),
    updateCompactSummary: vi.fn(),
    updateLineage: vi.fn(),
  } as unknown as ThreadRepo & { clearSdkSessionId: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn> };

  const workspaceRepo = {
    findById: vi.fn(() => ({ id: "ws-1", path: "/workspace" })),
  } as unknown as WorkspaceRepo;

  // A prior message means nextSeq > 1, so the first attempt is a resume.
  let latestSequence = 1;
  const createMessage = vi.fn((_threadId: string, _role: string, _content: string, sequence: number) => {
    latestSequence = Math.max(latestSequence, sequence);
    return { id: `msg-${sequence}`, sequence };
  });
  const messageRepo = {
    listByThread: vi.fn(() => ({ messages: [{ id: "m0", sequence: 1, role: "user", content: "prev" }] })),
    getLatestSequenceIncludingInternal: vi.fn(() => latestSequence),
    create: createMessage,
    createAssistantIdempotent: vi.fn((input: Parameters<MessageRepo["createAssistantIdempotent"]>[0]) => ({
      id: input.id,
      thread_id: input.threadId,
      role: "assistant",
      content: input.content,
    }) as ReturnType<MessageRepo["createAssistantIdempotent"]>),
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
  const toolCallRecordRepo = { bulkCreate: vi.fn() } as unknown as ToolCallRecordRepo;
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
  const availability = { assertUsable: vi.fn() } as unknown as ProviderAvailabilityService;
  const planQuestionAnswersRepo = {
    markAnswered: vi.fn(),
    isAnswered: vi.fn(() => false),
    listAnsweredForThread: vi.fn(() => []),
  } as unknown as PlanQuestionAnswersRepo;
  const threadControlMcp = { activate: vi.fn(), revoke: vi.fn(), close: vi.fn() };
  const mutationReservations = new ThreadControlMutationReservationService();
  const db = {
    filename: ":memory:",
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
    prepare: vi.fn(() => ({ run: vi.fn() })),
  } as unknown as import("bun:sqlite").Database;

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
    memoryPressureService,
    settingsService,
    availability,
    planQuestionAnswersRepo,
    { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as never,
    { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as never,
    new NarrativeStore(
      messageRepo,
      toolCallRecordRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../conversation/narrative/persistence/thought-segment-repo.js").ThoughtSegmentRepo,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
    ),
    new ParentAssistantTextCheckpointService(db),
    undefined,
    threadControlMcp as never,
    mutationReservations,
    createCanonicalAgentEventSinkStub(db),
  );

  return {
    service,
    sendTurn,
    discardSession,
    waitForSessionExit,
    providerEmitter,
    messageRepo,
    threadRepo,
    threadControlMcp,
    mutationReservations,
  };
}

function synthesizedTurnCompleteEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === "turnComplete"
    && (event.reason === "message_received" || event.reason === "provider_stream_exhausted"));
}

describe("AgentService transient-failure auto-retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a transient send failure once against a fresh session", async () => {
    const { service, sendTurn, discardSession, threadRepo } = buildService();
    startAgentServiceIngressForTest(service, );
    sendTurn
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(sendTurn).toHaveBeenCalledTimes(2);
    // First attempt resumes the live session; the retry must drop it for a fresh spawn.
    expect((sendTurn.mock.calls[0][0] as TurnRequest).resumeFrom).toBe("sess-abc");
    expect((sendTurn.mock.calls[1][0] as TurnRequest).resumeFrom).toBeUndefined();
    // Dropping resumeFrom is not enough: the provider pools a warm session by
    // sessionName, so the retry must also force-evict it to truly spawn fresh.
    expect(discardSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
    expect(threadRepo.clearSdkSessionId).toHaveBeenCalledWith(THREAD_ID);
    expect(threadRepo.updateStatus).not.toHaveBeenCalledWith(THREAD_ID, "errored");
  });

  it("reactivates the same turn authority after retry discards its provider session", async () => {
    const { service, sendTurn, threadControlMcp } = buildService();
    startAgentServiceIngressForTest(service, );
    sendTurn.mockRejectedValueOnce(new Error("read ECONNRESET")).mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "Create one Mcode thread named leaf_probe",
      permissionMode: "full",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(threadControlMcp.activate).toHaveBeenCalledTimes(2);
    expect(threadControlMcp.activate.mock.calls[1][0]).toMatchObject({
      sourceThreadId: THREAD_ID,
      sourceTurnId: threadControlMcp.activate.mock.calls[0][0].sourceTurnId,
      sourceProviderId: "claude",
      permissionMode: "full",
    });
  });

  it("does not retry a fatal send failure", async () => {
    const { service, sendTurn, discardSession, threadRepo } = buildService();
    startAgentServiceIngressForTest(service, );
    sendTurn.mockRejectedValue(new Error("permission denied"));

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(discardSession).not.toHaveBeenCalled();
    expect(threadRepo.clearSdkSessionId).not.toHaveBeenCalled();
    expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "errored");
  });

  it("terminalizes exhausted provider retries with the active turn identity", async () => {
    const { service, sendTurn, providerEmitter, threadRepo } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockRejectedValue(new Error("read ECONNRESET"));

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    const terminalEvents = events.filter((event) => event.type === "error" || event.type === "ended");
    expect(terminalEvents).toHaveLength(2);
    expect(terminalEvents[0]?.turnExecutionId).toEqual(expect.any(String));
    expect(terminalEvents[1]?.turnExecutionId).toBe(terminalEvents[0]?.turnExecutionId);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("errored");
    expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "errored");
    expect(threadRepo.updateStatus).not.toHaveBeenCalledWith(THREAD_ID, "interrupted");
  });

  it("does not publish an interrupted status for suppressed retry teardown", async () => {
    const { service, sendTurn, providerEmitter, threadRepo } = buildService();
    startAgentServiceIngressForTest(service, (event) => {
      publishParentProviderEvent(event, event, {
        publishAgentEvent: vi.fn(),
        updateThreadStatus: threadRepo.updateStatus,
        publishThreadStatus: vi.fn(),
      });
    });
    sendTurn
      .mockImplementationOnce((request: TurnRequest) => {
        providerEmitter.emit("event", {
          type: "error",
          threadId: THREAD_ID,
          turnExecutionId: request.turnExecutionId,
          error: "read ECONNRESET",
        });
        providerEmitter.emit("event", {
          type: "ended",
          threadId: THREAD_ID,
          turnExecutionId: request.turnExecutionId,
        });
        return Promise.reject(new Error("read ECONNRESET"));
      })
      .mockImplementationOnce((request: TurnRequest) => {
        providerEmitter.emit("event", {
          type: "turnComplete",
          threadId: THREAD_ID,
          turnExecutionId: request.turnExecutionId,
          reason: "end_turn",
          costUsd: null,
          tokensIn: 0,
          tokensOut: 0,
        });
        return Promise.resolve();
      });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "retry without a visible interruption",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    await vi.waitFor(() => {
      expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "completed");
    });
    expect(threadRepo.updateStatus).not.toHaveBeenCalledWith(THREAD_ID, "interrupted");
  });

  it("leaves a full-looking response unresolved when the provider ends without terminal proof", async () => {
    const { service, sendTurn, providerEmitter, messageRepo } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockImplementationOnce((request: TurnRequest) => {
      providerEmitter.emit("event", {
        type: "message",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        content: "done",
        tokens: null,
      });
      providerEmitter.emit("event", {
        type: "ended",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
      });
      return Promise.resolve();
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    const executionId = (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId;
    await Promise.resolve();
    expect(messageRepo.setAssistantOutcome).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), executionId);
    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(0);
    expect(events.filter((event) => event.type === "ended")).toHaveLength(1);
    expect(messageRepo.createAssistantIdempotent).not.toHaveBeenCalled();
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");
  });

  it("does not synthesize a terminal event after an explicit completion", async () => {
    const { service, sendTurn, providerEmitter, messageRepo } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockImplementationOnce((request: TurnRequest) => {
      providerEmitter.emit("event", {
        type: "message",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        content: "done",
        tokens: null,
      });
      return Promise.resolve();
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // A provider body alone is not terminal proof and must remain buffered.
    expect(messageRepo.createAssistantIdempotent).not.toHaveBeenCalled();

    providerEmitter.emit("event", {
      type: "turnComplete",
      threadId: THREAD_ID,
      turnExecutionId: (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    });
    providerEmitter.emit("event", {
      type: "ended",
      threadId: THREAD_ID,
      turnExecutionId: (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId,
    });

    const executionId = (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId;
    await vi.waitFor(() => {
      expect(messageRepo.setAssistantOutcome).toHaveBeenCalledWith(expect.any(String), "completed", executionId);
    });
    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ended")).toHaveLength(1);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("completed");
  });

  it("fences child Ended events and clears the final-response marker for the next turn", async () => {
    const { service, sendTurn, providerEmitter, messageRepo } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockImplementation((request: TurnRequest) => {
      if (sendTurn.mock.calls.length === 1) {
        providerEmitter.emit("event", {
          type: "message",
          threadId: THREAD_ID,
          turnExecutionId: request.turnExecutionId,
          content: "done",
          tokens: null,
        });
        providerEmitter.emit("event", {
          type: "ended",
          threadId: THREAD_ID,
          turnExecutionId: "child-execution",
        });
      }
      providerEmitter.emit("event", {
        type: "ended",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        outcome: "completed",
      });
      return Promise.resolve();
    });

    const command = {
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default" as const,
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude" as const,
    };
    await service.sendMessage(command);
    const firstExecutionId = (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId;
    await service.sendMessage(command);

    await vi.waitFor(() => {
      expect(messageRepo.setAssistantOutcome).toHaveBeenCalledWith(expect.any(String), "completed", firstExecutionId);
    });
    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(0);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    // The raw provider stream includes the fenced child Ended plus one Ended
    // for each root execution; only the matching root Ended terminalizes.
    expect(events.filter((event) => event.type === "ended")).toHaveLength(3);
    await vi.waitFor(() => {
      expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("completed");
    });
  });

  it("keeps a stream that reports an error on the error path", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockImplementationOnce((request: TurnRequest) => {
      providerEmitter.emit("event", {
        type: "error",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        error: "stream failed",
      });
      return Promise.resolve();
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(0);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("errored");
  });

  it("does not turn a stopped turn into a successful fallback", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );
    sendTurn.mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const executionId = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.turnExecutionId;
    await service.stopSession(THREAD_ID);

    providerEmitter.emit("event", {
      type: "ended",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    });
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("cancelled");
  });

  it("ignores stale Message events and interrupts only the matching execution", async () => {
    const { service, sendTurn, providerEmitter, messageRepo } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const executionId = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.turnExecutionId;
    providerEmitter.emit("event", {
      type: "message",
      threadId: THREAD_ID,
      turnExecutionId: "child-execution",
      content: "child",
      tokens: null,
    });
    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");

    providerEmitter.emit("event", {
      type: "message",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "root",
      tokens: null,
    });
    await Promise.resolve();
    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(messageRepo.createAssistantIdempotent).not.toHaveBeenCalled();
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");

    providerEmitter.emit("event", {
      type: "ended",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      outcome: "completed",
    });
    await vi.waitFor(() => {
      expect(messageRepo.setAssistantOutcome).toHaveBeenCalledWith(expect.any(String), "completed", executionId);
    });
    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(0);
    expect(messageRepo.createAssistantIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "root" }),
    );
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("completed");
  });

  it("does not treat a post-turn goal receipt as a new completion", async () => {
    const { service, sendTurn, providerEmitter, messageRepo } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const executionId = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.turnExecutionId;
    providerEmitter.emit("event", {
      type: "message",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "done",
      tokens: null,
    });
    await Promise.resolve();
    providerEmitter.emit("event", {
      type: "message",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "Goal achieved in 1s.",
      tokens: null,
    });

    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(0);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");

    providerEmitter.emit("event", {
      type: "ended",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      outcome: "completed",
    });
    await vi.waitFor(() => {
      expect(messageRepo.setAssistantOutcome).toHaveBeenCalledWith(expect.any(String), "completed", executionId);
    });
    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(messageRepo.createAssistantIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Goal achieved in 1s." }),
    );
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("completed");
  });

  it("leaves compaction-owned messages running until compaction finishes", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    startAgentServiceIngressForTest(service, );
    sendTurn.mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const executionId = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.turnExecutionId;
    providerEmitter.emit("event", {
      type: "compacting",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      active: true,
    });
    providerEmitter.emit("event", {
      type: "message",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "compaction result",
      tokens: null,
    });
    await Promise.resolve();

    expect(synthesizedTurnCompleteEvents(events)).toHaveLength(0);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");
    providerEmitter.emit("event", {
      type: "compacting",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      active: false,
    });
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");
  });

  it("swallows discardSession's trailing Ended when sendTurn rejects without emitting Error", async () => {
    const { service, sendTurn, discardSession, waitForSessionExit, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );

    // Spawn-style failure: no provider Error, but discardSession unwinds a pooled
    // subprocess and emits Ended on the next tick while the retry catch runs.
    discardSession.mockImplementation(() => {
      queueMicrotask(() => {
        const executionId = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.turnExecutionId;
        if (!executionId) return;
        providerEmitter.emit("event", {
          type: "ended",
          threadId: THREAD_ID,
          turnExecutionId: executionId,
        });
      });
    });
    waitForSessionExit.mockImplementation(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });
    sendTurn
      .mockRejectedValueOnce(new Error("spawn claude EAGAIN"))
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(discardSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
    expect(waitForSessionExit).toHaveBeenCalledWith(`mcode-${THREAD_ID}`, 5000);
    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");
  });

  it("keeps a transient disconnect unfinished until a real terminal outcome", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    const events: Array<Record<string, unknown>> = [];
    providerEmitter.on("event", (event: { event: Record<string, unknown> }) => events.push(event.event));
    let markRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });
    let releaseRetry!: () => void;
    const retryBlocked = new Promise<void>((resolve) => { releaseRetry = resolve; });
    startAgentServiceIngressForTest(service, );
    sendTurn
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => {
        markRetryStarted();
        return retryBlocked;
      });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    const executionId = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.turnExecutionId;
    providerEmitter.emit("event", {
      type: "error",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      error: "read ECONNRESET",
    });
    providerEmitter.emit("event", {
      type: "ended",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    });
    await retryStarted;

    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");
    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(0);

    releaseRetry();
    await Promise.resolve();
    await Promise.resolve();
    providerEmitter.emit("event", {
      type: "turnComplete",
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    });
    await Promise.resolve();

    expect(events.filter((event) => event.type === "turnComplete")).toHaveLength(1);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("completed");
  });

  it("fences a delayed stream retry from stop and a replacement turn", async () => {
    const { service, sendTurn, discardSession, providerEmitter, mutationReservations } = buildService();
    startAgentServiceIngressForTest(service, );

    let releaseEviction!: () => void;
    let evictionStarted!: () => void;
    const evictionReady = new Promise<void>((resolve) => { evictionStarted = resolve; });
    const evictionReleased = new Promise<void>((resolve) => { releaseEviction = resolve; });
    discardSession.mockImplementation(async () => {
      evictionStarted();
      await evictionReleased;
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const initialTurnExecutionId = (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId;
    providerEmitter.emit("event", {
      type: "error",
      threadId: THREAD_ID,
      turnExecutionId: initialTurnExecutionId,
      error: "read ECONNRESET",
    });
    await evictionReady;

    await service.stopSession(THREAD_ID);
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "replacement",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const replacementReservation = mutationReservations.get(THREAD_ID);
    expect(replacementReservation?.state).toBe("activeTurn");

    releaseEviction();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(mutationReservations.get(THREAD_ID)).toEqual(replacementReservation);
  });

  it("retries when sendTurn resolves early then a transient stream Error arrives", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );

    sendTurn
      .mockImplementationOnce(async () => {
        // Fire-and-forget: resolve before the stream error.
      })
      .mockResolvedValueOnce(undefined);

    const sendPromise = service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await sendPromise;

    providerEmitter.emit("event", {
      type: "error",
      threadId: THREAD_ID,
      turnExecutionId: (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId,
      error: "read ECONNRESET",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect((sendTurn.mock.calls[1][0] as TurnRequest).resumeFrom).toBeUndefined();
  });

  it("retries when a failed completion emits an identified transient Error", async () => {
    const { service, sendTurn, providerEmitter, threadRepo } = buildService();
    startAgentServiceIngressForTest(service, );
    sendTurn.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const turnExecutionId = (sendTurn.mock.calls[0][0] as TurnRequest).turnExecutionId;

    providerEmitter.emit("event", {
      type: "error",
      threadId: THREAD_ID,
      error: "stream disconnected before completion: error sending request for url (http://127.0.0.1:3845/mcp)",
      turnExecutionId,
    });
    providerEmitter.emit("event", {
      type: "ended",
      threadId: THREAD_ID,
      outcome: "errored",
      turnExecutionId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect((sendTurn.mock.calls[1][0] as TurnRequest).resumeFrom).toBeUndefined();
    expect(threadRepo.updateStatus).not.toHaveBeenCalledWith(THREAD_ID, "errored");
    providerEmitter.emit("event", {
      type: "turnComplete",
      threadId: THREAD_ID,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      turnExecutionId: (sendTurn.mock.calls[1][0] as TurnRequest).turnExecutionId,
    });
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("completed");
  });

  it("swallows a failed attempt's TurnComplete during the retry window", async () => {
    const { service, sendTurn, providerEmitter } = buildService();
    startAgentServiceIngressForTest(service, );

    sendTurn
      .mockImplementationOnce((request: TurnRequest) => {
        providerEmitter.emit("event", {
          type: "error",
          threadId: THREAD_ID,
          turnExecutionId: request.turnExecutionId,
          error: "read ECONNRESET",
        });
        providerEmitter.emit("event", {
          type: "turnComplete",
          threadId: THREAD_ID,
          turnExecutionId: request.turnExecutionId,
          reason: "end_turn",
          costUsd: null,
          tokensIn: 0,
          tokensOut: 0,
        });
        return Promise.reject(new Error("read ECONNRESET"));
      })
      .mockResolvedValueOnce(undefined);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("running");
    providerEmitter.emit("event", {
      type: "turnComplete",
      threadId: THREAD_ID,
      turnExecutionId: (sendTurn.mock.calls[1][0] as TurnRequest).turnExecutionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    });
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID)?.phase).toBe("completed");
  });

  it("stops retrying at the attempt cap when a transient signature keeps failing", async () => {
    const { service, sendTurn, threadRepo } = buildService();
    startAgentServiceIngressForTest(service, );
    sendTurn.mockRejectedValue(new Error("read ECONNRESET"));

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    // Cap is 2: one original attempt plus one retry, then it gives up.
    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(threadRepo.updateStatus).toHaveBeenCalledWith(THREAD_ID, "errored");
  });
});
