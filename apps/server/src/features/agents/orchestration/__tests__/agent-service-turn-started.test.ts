import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as NodeEvents from "node:events";
import type Database from "better-sqlite3";
import { AgentEventType } from "@mcode/contracts";
import type {
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
  ProviderRuntimeEvent,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import { AgentService } from "../agent-service.js";
import { createAgentServiceForTest, startAgentServiceIngressForTest, wrapProviderEmitterForRuntimeEvents } from "./agent-service-test-harness.js";
import { CanonicalAgentEventSink } from "../../canonical/canonical-agent-event-sink.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";

/**
 * Test harness for AgentService.sendMessage "turn started" emission.
 *
 * The provider is stubbed with an EventEmitter whose sendMessage() returns a
 * never-resolving promise, so we can assert the turnStarted event lands on the
 * EventEmitter bus BEFORE provider.sendMessage() completes.
 */
describe("AgentService.sendMessage emits TurnStarted", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let messageRepo: MessageRepo;
  let toolCallRecordRepo: ToolCallRecordRepo;
  let turnSnapshotRepo: TurnSnapshotRepo;
  let svc: AgentService;
  let canonicalSink: CanonicalAgentEventSink;
  let providerStub: NodeEvents.EventEmitter & Partial<IAgentProvider> & {
    sendTurn: ReturnType<typeof vi.fn>;
  };
  let capturedEvents: ProviderRuntimeEvent[];
  // Snapshot of capturedEvents.length taken synchronously when the provider's
  // sendMessage body is entered. If emit truly precedes the call, this must be >= 1.
  let eventsLengthAtSendMessageEntry: number;

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    messageRepo = new MessageRepo(db);
    toolCallRecordRepo = new ToolCallRecordRepo(db);
    turnSnapshotRepo = new TurnSnapshotRepo(db);

    // Capture runtime envelopes emitted on the provider bus.
    capturedEvents = [];
    eventsLengthAtSendMessageEntry = -1;
    providerStub = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
      id: "claude" as ProviderId,
      supportsCompletion: false,
      sessionForkOnResume: "unsupported" as const,
      maxInputCharactersPerTurn: 16_000,
      // Never resolves. We want to observe events emitted BEFORE completion.
      // Snapshot capturedEvents.length synchronously on entry: this is the
      // load-bearing ordering signal. If the emit happened BEFORE the call
      // entered (correct order), this will be >= 1.
      sendTurn: vi.fn(() => {
        eventsLengthAtSendMessageEntry = capturedEvents.length;
        return new Promise<void>(() => {});
      }),
      stopSession: vi.fn(),
      shutdown: vi.fn(),
    }));
    providerStub.on("event", (event: ProviderRuntimeEvent) => capturedEvents.push(event));

    const registryStub: IProviderRegistry = {
      resolve: () => providerStub as unknown as IAgentProvider,
      resolveAll: () => [providerStub as unknown as IAgentProvider],
      shutdown: () => {},
    };

    const gitServiceStub = {
      // process.cwd() is guaranteed to be a real absolute directory, satisfying
      // AgentService's isAbsolute/existsSync/statSync validation.
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

    // ThreadService is lazy-resolved via tsyringe's delay(), so a shallow stub is fine.
    const threadServiceStub = {} as unknown as ThreadService;

    // Availability gate is a no-op stub — turn-started emission is orthogonal to
    // provider enable/disable checks.
    const availabilityStub = {
      assertUsable: vi.fn(),
    } as unknown as ProviderAvailabilityService;

    canonicalSink = new CanonicalAgentEventSink(db, vi.fn());
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
    );
  });

  it("emits turnStarted through the provider before provider.sendMessage resolves", async () => {
    const workspace = workspaceRepo.create("test-ws", process.cwd());
    const thread = threadRepo.create(workspace.id, "Test Thread", "direct", "main", true, "claude");

    // Kick off sendMessage without awaiting (provider.sendMessage never resolves).
    void svc.sendMessage({
      threadId: thread.id,
      content: "hello",
      permissionMode: "default",
      sourceTurnId: "canonical-source-turn",
    });

    // Let the async prelude (attachment persist + ref capture + settings.get) settle.
    await new Promise((r) => setTimeout(r, 10));

    // TurnStarted must be the FIRST event on the bus (nothing precedes it).
    expect(capturedEvents.length, "expected at least one event on the bus").toBeGreaterThan(0);
    expect(capturedEvents[0]?.event).toMatchObject({
      type: AgentEventType.TurnStarted,
      threadId: thread.id,
    });
    const executionId = capturedEvents[0]!.event.turnExecutionId;
    expect(canonicalSink.loadTurnByExecution(executionId)).toMatchObject({
      threadId: thread.id,
      status: "Running",
      providerIdentities: [],
    });
    expect(canonicalSink.loadConversationProjection(thread.id, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
    ]);

    // Load-bearing ordering assertion: the snapshot taken synchronously inside
    // the provider's sendMessage body must show the TurnStarted emit had already
    // landed on the bus BEFORE the call entered. This is the real "emit precedes
    // call" proof, not just "emit precedes the (never-resolving) promise".
    expect(
      eventsLengthAtSendMessageEntry,
      "expected capturedEvents.length >= 1 at sendMessage entry (emit must precede call)",
    ).toBeGreaterThanOrEqual(1);

    // Guard against accidental double-emission on resume/retry paths.
    const turnStartedCount = capturedEvents.filter(
      (runtimeEvent) => runtimeEvent.event.type === AgentEventType.TurnStarted,
    ).length;
    expect(turnStartedCount, "turnStarted must be emitted exactly once").toBe(1);
    expect(svc.runtimeAccess().runtimeSnapshots()).toContainEqual(expect.objectContaining({
      threadId: thread.id,
      phase: "running",
    }));

    // Provider.sendTurn must have been invoked. Confirms the emit happened
    // during sendTurn flow, not via some other path.
    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
    expect(providerStub.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "canonical-source-turn",
    }));
  });

  it("starts canonical providers through AgentService without leaving terminal suppression behind", async () => {
    Object.assign(providerStub, {
      id: "cursor" as ProviderId,
    });
    startAgentServiceIngressForTest(svc, );
    const workspace = workspaceRepo.create("test-ws", process.cwd());
    const thread = threadRepo.create(workspace.id, "Cursor Thread", "direct", "main", true, "cursor");
    void svc.sendMessage({
      threadId: thread.id,
      content: "hello",
      permissionMode: "default",
      sourceTurnId: "canonical-cursor-turn",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(svc.runtimeAccess().activeThreadIds()).toContain(thread.id);
    expect(providerStub.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "canonical-cursor-turn",
    }));
  });
});
