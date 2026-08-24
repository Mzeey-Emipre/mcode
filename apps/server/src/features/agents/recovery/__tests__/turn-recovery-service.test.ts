import "reflect-metadata";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import {
  CanonicalAgentEventSink,
  type CanonicalAgentEventPublisher,
} from "../../canonical/canonical-agent-event-sink.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { TurnRecoveryService } from "../turn-recovery-service.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SendMessageCommand } from "../../orchestration/agent-service.js";

const NOW = "2026-08-10T09:00:00.000Z";
const THREAD_ID = "thread-recovery";
const TURN_ID = "turn-recovery";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000015";

describe("TurnRecoveryService", () => {
  let db: Database.Database;
  let sink: CanonicalAgentEventSink;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageRepo;
  let defaultCheckpoints: ParentAssistantTextCheckpointService;
  let published: ReturnType<typeof vi.fn<CanonicalAgentEventPublisher>>;

  beforeEach(() => {
    db = openMemoryDatabase();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("workspace-recovery", "Workspace", "C:/workspace", NOW, NOW);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "workspace-recovery", "Recovery", "main", "codex", "active", NOW, NOW);
    published = vi.fn();
    sink = new CanonicalAgentEventSink(db, published);
    threadRepo = new ThreadRepo(db);
    messageRepo = new MessageRepo(db);
    defaultCheckpoints = new ParentAssistantTextCheckpointService(db);
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-recovery",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [{
        providerId: "codex",
        scope: "thread",
        value: "native-cursor-15",
        provenance: "native",
      }],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "repeat only when asked", 1),
    });
  });

  it("interrupts every execution that lacks exact provider proof at startup", () => {
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
    );

    const result = service.reconcileOnStartup();

    expect(result).toEqual({ interrupted: [EXECUTION_ID] });
    expect(sink.loadTurn(TURN_ID)?.status).toBe("Interrupted");
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "interrupted",
      terminalOutcome: "interrupted",
    });
    expect(threadRepo.findById(THREAD_ID)?.status).toBe("interrupted");
  });

  it("marks an existing assistant projection interrupted with its original execution identity", () => {
    const assistant = messageRepo.createAssistantIdempotent({
      id: "assistant-recovery",
      threadId: THREAD_ID,
      content: "A full-looking response",
      sequence: 2,
      isInternal: true,
    });
    const thread = sink.loadThread(THREAD_ID);
    if (!thread) throw new Error("Recovery test thread was not persisted canonically");

    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: [{
        eventId: `${EXECUTION_ID}:partial-assistant`,
        routing: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          executionId: EXECUTION_ID,
          itemId: `message:${assistant.id}`,
        },
        sourceProviderId: thread.providerId,
        sourceIdentities: thread.providerIdentities,
        payload: {
          type: "item.recorded",
          item: {
            id: `message:${assistant.id}`,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            kind: "message",
            providerIdentities: thread.providerIdentities,
            payload: { projection: "message", message: assistant },
            createdAt: assistant.timestamp,
            updatedAt: assistant.timestamp,
          },
        },
      }],
    });
    defaultCheckpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "stale checkpoint must not replace canonical text",
    }]);

    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
    );
    service.reconcileOnStartup();

    expect(messageRepo.findById(assistant.id)).toMatchObject({
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
      is_internal: false,
    });
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      id: assistant.id,
      content: "A full-looking response",
      is_internal: false,
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
    });
    expect(defaultCheckpoints.restore(EXECUTION_ID)).toBe("");
  });

  it("restores exact checkpoint text in order, interrupts it, and retires the checkpoint", () => {
    const checkpoints = new ParentAssistantTextCheckpointService(db);
    checkpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "First durable ",
    }]);
    checkpoints.appendChunk([
      {
        executionId: EXECUTION_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        sequence: 2,
        text: "second durable ",
      },
      {
        executionId: EXECUTION_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        sequence: 3,
        text: "third durable.",
      },
    ]);
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      checkpoints,
      messageRepo,
    );

    expect(service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "repeat only when asked" }),
      expect.objectContaining({
        role: "assistant",
        content: "First durable second durable third durable.",
        is_internal: false,
        outcome: "interrupted",
        outcomeExecutionId: EXECUTION_ID,
      }),
    ]);
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      content: "First durable second durable third durable.",
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
    });
    expect(checkpoints.restore(EXECUTION_ID)).toBe("");

    expect(service.reconcileOnStartup()).toEqual({ interrupted: [] });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toHaveLength(2);
  });

  it("removes a stale checkpoint when a completed canonical message already exists", () => {
    const checkpoints = new ParentAssistantTextCheckpointService(db);
    checkpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "stale checkpoint text",
    }]);
    const completed = messageRepo.createAssistantIdempotent({
      id: "completed-canonical-message",
      threadId: THREAD_ID,
      content: "canonical completed text",
      sequence: 2,
    });
    sink.finishParentTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed",
      projectTurn: () => ({
        message: {
          ...completed,
          outcome: "completed",
          outcomeExecutionId: EXECUTION_ID,
        },
        narrative: [],
      }),
    });
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      checkpoints,
      messageRepo,
    );

    expect(service.reconcileOnStartup()).toEqual({ interrupted: [] });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "repeat only when asked" }),
      expect.objectContaining({
        id: "completed-canonical-message",
        content: "canonical completed text",
      }),
    ]);
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      id: "completed-canonical-message",
      content: "canonical completed text",
      outcome: "completed",
    });
    expect(checkpoints.restore(EXECUTION_ID)).toBe("");
  });

  it("marks an unresolved child delivery unknown before interrupting its parent execution", () => {
    // Regression: restart must not classify a dispatched child as rejected or make
    // its uncertain identity eligible for reuse.
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:recovery-child",
      receiverThreadIds: ["native-recovery-child"],
      providerIdentities: [],
    });
    published.mockClear();
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
    );

    service.reconcileOnStartup();

    expect(sink.loadCollaborationAction(delegation.collaborationAction.id)).toMatchObject({
      status: "Dispatched",
      deliveryUnknown: true,
    });
    expect(sink.loadThread(delegation.childThread.id)?.activityState).toBe("Unavailable");
    expect(published).toHaveBeenCalledTimes(3);
    expect(published.mock.calls[1]![0].every((event: { routing: { threadId: string } }) => (
      event.routing.threadId === delegation.childThread.id
    ))).toBe(true);
    expect(sink.loadThread(delegation.childThread.id)?.conversationRevision).toBe(1);
    expect(sink.recoverThread(delegation.childThread.id, {
      conversationRevision: 0,
      rosterRevision: 0,
    }).mode).toBe("snapshot");
  });

  it("offers Retry but never Resume for an unproved native cursor", () => {
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
    );
    service.reconcileOnStartup();

    expect(service.listRecoveries()).toEqual([{
      threadId: THREAD_ID,
      executionId: EXECUTION_ID,
      acceptedThrough: 6,
      durableThrough: 6,
      phase: "interrupted",
      error: "The provider could not prove that this execution was still active after restart.",
      actions: ["retry"],
    }]);
  });

  it("dispatches an explicit Retry as a fresh execution with the accepted user input", async () => {
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
    );
    service.reconcileOnStartup();
    const dispatched: SendMessageCommand[] = [];
    const dispatch = vi.fn(async (command: SendMessageCommand) => {
      dispatched.push(command);
    });

    await service.retry(EXECUTION_ID, dispatch);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD_ID,
      content: "repeat only when asked",
      provider: "codex",
      forceFreshSession: true,
      retryOfExecutionId: EXECUTION_ID,
    }));

    const retryCommand = dispatched[0]!;
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-recovery",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: "turn-retry",
      executionId: "00000000-0000-4000-8000-000000000016",
      permissionMode: "supervised",
      providerIdentities: [],
      retryOfExecutionId: retryCommand.retryOfExecutionId,
      projectUserMessage: () => new MessageRepo(db).create(
        THREAD_ID,
        "user",
        retryCommand.content,
        2,
      ),
    });

    expect(sink.listInterruptedCheckpoints()).toEqual([]);
    expect(sink.loadCheckpoint(EXECUTION_ID)?.phase).toBe("retried");
  });

  it("offers Retry for a known terminal provider failure", async () => {
    sink.finishParentTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "errored",
      error: "provider failed",
      projectTurn: () => ({ message: null, narrative: [] }),
    });
    threadRepo.updateStatus(THREAD_ID, "errored");

    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
    );
    expect(service.listRecoveries()).toEqual([expect.objectContaining({
      executionId: EXECUTION_ID,
      phase: "errored",
      error: "provider failed",
      actions: ["retry"],
    })]);

    const dispatch = vi.fn(async () => undefined);
    await service.retry(EXECUTION_ID, dispatch);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      retryOfExecutionId: EXECUTION_ID,
      forceFreshSession: true,
    }));
  });
});
