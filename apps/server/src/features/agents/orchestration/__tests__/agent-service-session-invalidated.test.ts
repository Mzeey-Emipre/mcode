import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import type Database from "better-sqlite3";
import { AgentEventType } from "@mcode/contracts";
import type {
  AgentEvent,
  CanonicalAgentEventEnvelope,
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
  TurnRequest,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import { TaskRepo } from "../persistence/task-repo.js";
import { AgentService } from "../agent-service.js";
import { createAgentServiceForTest, startAgentServiceIngressForTest, wrapProviderEmitterForRuntimeEvents } from "./agent-service-test-harness.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { ProviderEventIngress } from "../../../providers/composition/provider-event-ingress.js";

const CANONICAL_TIMESTAMP = "2026-08-29T15:00:00.000Z";

/** Creates a committed Cursor SDK-session identity event for the provider ingress boundary. */
function cursorSessionIdentityEnvelope(
  threadId: string,
  turnId: string,
  executionId: string,
): CanonicalAgentEventEnvelope {
  const eventId = `cursor:${executionId}:session-identity`;
  const itemId = `cursor:${executionId}:session-identity-item`;
  return {
    eventId,
    routing: { threadId, turnId, executionId, itemId },
    sourceProviderId: "cursor",
    sourceIdentities: [],
    sourceSequence: 1,
    acceptedSequence: 1,
    durableRevision: 1,
    serverTimestamps: { acceptedAt: CANONICAL_TIMESTAMP },
    payload: {
      type: "item.recorded",
      item: {
        id: itemId,
        threadId,
        turnId,
        kind: "system",
        providerIdentities: [],
        payload: {
          projection: "providerRuntimeEvent",
          runtimeEvent: {
            event: {
              type: AgentEventType.System,
              threadId,
              turnExecutionId: executionId,
              subtype: "sdk_session_id:cursor-session-1",
            },
          },
        },
        createdAt: CANONICAL_TIMESTAMP,
        updatedAt: CANONICAL_TIMESTAMP,
      },
    },
  };
}

/** Lets the asynchronous committed-event queue apply one canonical event batch. */
async function flushCommittedEvents(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

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
  let providerEventIngress: ProviderEventIngress;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    messageRepo = new MessageRepo(db);
    toolCallRecordRepo = new ToolCallRecordRepo(db);
    turnSnapshotRepo = new TurnSnapshotRepo(db);
    taskRepo = new TaskRepo(db);

    providerStub = wrapProviderEmitterForRuntimeEvents(Object.assign(new EventEmitter(), {
      id: "claude" as ProviderId,
      supportsCompletion: false,
      sessionForkOnResume: "unsupported" as const,
      maxInputCharactersPerTurn: 16_000,
      sendTurn: vi.fn(() => new Promise<void>(() => {})),
      stopSession: vi.fn(),
      shutdown: vi.fn(),
    }));

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
      assertCanStartTurn: vi.fn(),
      onPressureChange: vi.fn(),
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
    providerEventIngress = new ProviderEventIngress();
    const canonicalSink = createCanonicalAgentEventSinkStub(db);
    Object.assign(canonicalSink, { recordNativeCursor: vi.fn(() => true) });

    svc = createAgentServiceForTest(
      threadRepo,
      workspaceRepo,
      messageRepo,
      gitServiceStub,
      attachmentServiceStub,
      registryStub,
      threadServiceStub,
      { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
      turnSnapshotRepo,
      snapshotServiceStub,
      db,
      memoryPressureServiceStub,
      settingsServiceStub,
      availabilityStub,
      { markAnswered: vi.fn(), isAnswered: vi.fn(() => false), listAnsweredForThread: vi.fn(() => []) } as unknown as import("../../planning/persistence/plan-question-answers-repo.js").PlanQuestionAnswersRepo,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../conversation/narrative/persistence/thought-segment-repo.js").ThoughtSegmentRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
      ),
      new ParentAssistantTextCheckpointService(db),
      undefined,
      undefined,
      undefined,
      canonicalSink,
      undefined,
      providerEventIngress,
    );
    startAgentServiceIngressForTest(svc, );
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

  it("accepts a committed Cursor SDK session identity and resumes the next turn", async () => {
    Object.assign(providerStub, { id: "cursor" as ProviderId });
    vi.mocked(providerStub.sendTurn).mockResolvedValue(undefined);
    const workspace = workspaceRepo.create("test-ws", process.cwd());
    const thread = threadRepo.create(workspace.id, "Test Thread", "direct", "main", true, "cursor");

    await svc.sendMessage({
      threadId: thread.id,
      content: "first prompt",
      permissionMode: "default",
      model: "cursor-model",
      attachments: [],
    });
    const firstRequest = vi.mocked(providerStub.sendTurn).mock.calls[0]?.[0] as TurnRequest;
    providerEventIngress.acceptCommitted([
      cursorSessionIdentityEnvelope(thread.id, firstRequest.turnId, firstRequest.turnExecutionId),
    ]);
    await flushCommittedEvents();

    expect(threadRepo.findById(thread.id)?.sdk_session_id).toBe("cursor-session-1");

    providerStub.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: thread.id,
      turnExecutionId: firstRequest.turnExecutionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    } satisfies AgentEvent);

    await svc.sendMessage({
      threadId: thread.id,
      content: "second prompt",
      permissionMode: "default",
      model: "cursor-model",
      attachments: [],
    });

    expect(providerStub.sendTurn).toHaveBeenCalledTimes(2);
    expect((vi.mocked(providerStub.sendTurn).mock.calls[1]?.[0] as TurnRequest).resumeFrom)
      .toBe("cursor-session-1");
  });
});
