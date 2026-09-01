import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
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
  let narrativeStore: NarrativeStore;
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
    narrativeStore = new NarrativeStore(
      messageRepo,
      new ToolCallRecordRepo(db),
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
    );
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

  function startUnfinishedTurn(input: {
    workspaceId: string;
    workspaceName: string;
    threadId: string;
    threadTitle: string;
    turnId: string;
    executionId: string;
  }): void {
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.workspaceId, input.workspaceName, `C:/${input.workspaceId}`, NOW, NOW);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.threadId, input.workspaceId, input.threadTitle, "main", "codex", "active", NOW, NOW);
    sink.startParentTurn({
      thread: {
        id: input.threadId,
        workspaceId: input.workspaceId,
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: input.turnId,
      executionId: input.executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messageRepo.create(input.threadId, "user", "recover this turn", 1),
    });
  }

  it("interrupts every execution that lacks exact provider proof at startup", () => {
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
      narrativeStore,
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
      narrativeStore,
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
      narrativeStore,
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

  it("imports a fsynced recovery journal before it restores the interrupted assistant text", () => {
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-recovery-journal-"));
    const checkpoints = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    checkpoints.recoveryJournal.append([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "Journal text survives the SQLite outage.",
    }]);
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      checkpoints,
      messageRepo,
      narrativeStore,
    );

    try {
      expect(service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
      expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
        content: "Journal text survives the SQLite outage.",
        outcome: "interrupted",
        outcomeExecutionId: EXECUTION_ID,
      });
    } finally {
      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("restores ordered narration, interrupted tools, completed hooks, and explicit parallel parents", () => {
    narrativeStore.beginTurn(THREAD_ID);
    narrativeStore.resetTurnCounters(THREAD_ID);
    narrativeStore.openOrExtendThought(THREAD_ID, "I will inspect both children.");
    narrativeStore.closeOpenThought(THREAD_ID);
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "agent-a",
      toolName: "Agent",
      toolInput: { description: "first" },
    });
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "agent-b",
      toolName: "Agent",
      toolInput: { description: "second" },
    });
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "read-a",
      toolName: "Read",
      toolInput: { path: "a.ts" },
      parentToolCallId: "agent-a",
    });
    narrativeStore.updateBufferedToolCallOutput(THREAD_ID, "read-a", "contents", false);
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "agent-a-child",
      toolName: "Agent",
      toolInput: { description: "nested" },
      parentToolCallId: "agent-a",
    });
    const hookId = narrativeStore.openHook(THREAD_ID, {
      hookName: "PreToolUse",
      toolName: "Read",
      phase: "preToolUse",
      payload: "{\"hookType\":\"preToolUse\"}",
      sortOrder: narrativeStore.nextSortOrder(THREAD_ID),
    });
    narrativeStore.pushClosedHook(THREAD_ID, {
      id: hookId,
      messageId: "",
      hookName: "PreToolUse",
      toolName: "Read",
      phase: "preToolUse",
      payload: "{\"hookType\":\"preToolUse\"}",
      durationMs: 12,
      didBlock: false,
      startedAt: NOW,
      endedAt: NOW,
      sortOrder: 5,
    });
    narrativeStore.removeOpenHook(THREAD_ID, "PreToolUse");
    narrativeStore.openHook(THREAD_ID, {
      hookName: "PostToolUse",
      toolName: "Read",
      phase: "postToolUse",
      payload: "{\"hookType\":\"postToolUse\"}",
      sortOrder: narrativeStore.nextSortOrder(THREAD_ID),
    });

    sink.recordParentNarrativeRecovery({
      executionId: EXECUTION_ID,
      items: narrativeStore.recoverySnapshot(THREAD_ID),
    });
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
      narrativeStore,
    );

    expect(service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    const assistant = messageRepo.listByThread(THREAD_ID, 10).messages.at(-1)!;
    expect(assistant).toMatchObject({ role: "assistant", content: "", outcome: "interrupted" });
    const recovered = narrativeStore.loadForMessages([assistant]);
    expect(recovered.map((entry) => entry.kind)).toEqual([
      "narrationSegment",
      "toolCall",
      "toolCall",
      "toolCall",
      "toolCall",
      "hook",
      "hook",
      "assistantMessage",
    ]);
    const recoveredRead = recovered.find((entry) => entry.kind === "toolCall" && entry.record.id === "read-a");
    expect(recoveredRead).toMatchObject({
      record: {
        parent_tool_call_id: "agent-a",
        status: "completed",
        output_summary: "contents",
      },
    });
    expect(recovered.find((entry) => entry.kind === "toolCall" && entry.record.id === "agent-a"))
      .toMatchObject({ record: { status: "failed", completed_at: expect.any(String) } });
    expect(recovered.find((entry) => entry.kind === "toolCall" && entry.record.id === "agent-a-child"))
      .toMatchObject({ record: { parent_tool_call_id: "agent-a", status: "failed" } });
    expect(recovered.find((entry) => entry.kind === "hook")).toMatchObject({
      record: { hook_name: "PreToolUse", duration_ms: 12, ended_at: NOW },
    });
    expect(recovered.find((entry) => entry.kind === "hook" && entry.record.hook_name === "PostToolUse"))
      .toMatchObject({ record: { phase: "postToolUse", ended_at: expect.any(String) } });
    const canonicalPayload = db.prepare(`
      SELECT payload_json FROM canonical_agent_items
      WHERE id = 'toolCall:read-a'
    `).get() as { payload_json: string };
    expect(canonicalPayload.payload_json).not.toContain("toolInput");
    expect(canonicalPayload.payload_json).toContain('"projection":"toolCall"');
    expect(sink.loadParentNarrativeRecovery(TURN_ID)).toEqual([]);
  });

  it("repairs a terminal checkpoint whose assistant projection was not materialized before process loss", () => {
    narrativeStore.beginTurn(THREAD_ID);
    narrativeStore.resetTurnCounters(THREAD_ID);
    narrativeStore.openOrExtendThought(THREAD_ID, "I will run the command.");
    narrativeStore.closeOpenThought(THREAD_ID);
    narrativeStore.bufferToolCall(THREAD_ID, {
      toolCallId: "shell-live-1523",
      toolName: "Bash",
      toolInput: { command: "git status --short" },
    });
    narrativeStore.updateBufferedToolCallOutput(THREAD_ID, "shell-live-1523", "clean", false);
    sink.recordParentNarrativeRecovery({
      executionId: EXECUTION_ID,
      items: narrativeStore.recoverySnapshot(THREAD_ID),
    });
    defaultCheckpoints.appendChunk([{
      executionId: EXECUTION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      sequence: 1,
      text: "LIVE-NARRATION-1523 final answer",
    }]);
    db.prepare(`
      UPDATE canonical_agent_turns
      SET status = 'Completed', ended_at = ?
      WHERE id = ?
    `).run(NOW, TURN_ID);
    db.prepare(`
      UPDATE canonical_agent_ingest_checkpoints
      SET phase = 'completed', terminal_outcome = 'completed'
      WHERE execution_id = ?
    `).run(EXECUTION_ID);
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
      narrativeStore,
    );

    expect(service.reconcileOnStartup()).toEqual({ interrupted: [EXECUTION_ID] });
    const projection = sink.loadConversationProjection(THREAD_ID, 10);
    expect(projection.messages).toEqual([
      expect.objectContaining({ role: "user", content: "repeat only when asked" }),
      expect.objectContaining({
        role: "assistant",
        content: "LIVE-NARRATION-1523 final answer",
        outcome: "interrupted",
        outcomeExecutionId: EXECUTION_ID,
      }),
    ]);
    const assistant = projection.messages.at(-1)!;
    expect(projection.narrativeByMessage[assistant.id]).toMatchObject({
      thoughts: [expect.objectContaining({ text: "I will run the command." })],
      tools: [expect.objectContaining({ id: "shell-live-1523", status: "completed" })],
    });
    expect(defaultCheckpoints.restore(EXECUTION_ID)).toBe("");
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
      narrativeStore,
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
      narrativeStore,
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

  it("reports only the exact turns interrupted by the current restart", () => {
    const other = {
      workspaceId: "workspace-other",
      workspaceName: "Other workspace",
      threadId: "thread-other",
      threadTitle: "Other recovery",
      turnId: "turn-other",
      executionId: "00000000-0000-4000-8000-000000000016",
    };
    const completed = {
      workspaceId: "workspace-completed",
      workspaceName: "Completed workspace",
      threadId: "thread-completed",
      threadTitle: "Completed recovery",
      turnId: "turn-completed",
      executionId: "00000000-0000-4000-8000-000000000017",
    };
    const historic = {
      workspaceId: "workspace-historic",
      workspaceName: "Historic workspace",
      threadId: "thread-historic",
      threadTitle: "Historic error",
      turnId: "turn-historic",
      executionId: "00000000-0000-4000-8000-000000000018",
    };
    startUnfinishedTurn(other);
    startUnfinishedTurn(completed);
    startUnfinishedTurn(historic);
    sink.finishParentTurn({
      threadId: historic.threadId,
      turnId: historic.turnId,
      executionId: historic.executionId,
      providerId: "codex",
      providerIdentities: [],
      outcome: "errored",
      error: "historic provider failure",
      projectTurn: () => ({ message: null, narrative: [] }),
    });
    db.prepare("UPDATE threads SET user_completed_at = ? WHERE id = ?").run(NOW, completed.threadId);
    db.prepare("UPDATE canonical_agent_turns SET started_at = ? WHERE execution_id = ?")
      .run("2026-08-10T09:00:00.000Z", EXECUTION_ID);
    db.prepare("UPDATE canonical_agent_turns SET started_at = ? WHERE execution_id = ?")
      .run("2026-08-10T09:02:00.000Z", other.executionId);
    db.prepare("UPDATE canonical_agent_turns SET started_at = ? WHERE execution_id = ?")
      .run("2026-08-10T09:01:00.000Z", completed.executionId);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T09:03:00.000Z"));
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
      narrativeStore,
    );
    try {
      expect(service.reconcileOnStartup()).toEqual({
        interrupted: [EXECUTION_ID, other.executionId, completed.executionId],
      });
      const incident = service.currentRecoveryIncident();
      expect(incident).toMatchObject({
        createdAt: "2026-08-10T09:03:00.000Z",
        entries: [
          {
            workspaceId: "workspace-recovery",
            workspaceName: "Workspace",
            threadId: THREAD_ID,
            threadTitle: "Recovery",
            executionId: EXECUTION_ID,
            startedAt: "2026-08-10T09:00:00.000Z",
            interruptedAt: "2026-08-10T09:03:00.000Z",
            durationMs: 180_000,
          },
          {
            workspaceId: other.workspaceId,
            workspaceName: other.workspaceName,
            threadId: other.threadId,
            threadTitle: other.threadTitle,
            executionId: other.executionId,
            startedAt: "2026-08-10T09:02:00.000Z",
            interruptedAt: "2026-08-10T09:03:00.000Z",
            durationMs: 60_000,
          },
        ],
      });
      expect(incident?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      const cleanRestart = new TurnRecoveryService(
        sink,
        threadRepo,
        new AttachmentService(),
        defaultCheckpoints,
        messageRepo,
        narrativeStore,
      );
      expect(cleanRestart.reconcileOnStartup()).toEqual({ interrupted: [] });
      expect(cleanRestart.currentRecoveryIncident()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches an explicit Retry as a fresh execution with the accepted user input", async () => {
    const service = new TurnRecoveryService(
      sink,
      threadRepo,
      new AttachmentService(),
      defaultCheckpoints,
      messageRepo,
      narrativeStore,
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
    expect(service.currentRecoveryIncident()).toMatchObject({
      entries: [{ executionId: EXECUTION_ID }],
    });
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
      narrativeStore,
    );
    const dispatch = vi.fn(async () => undefined);
    await service.retry(EXECUTION_ID, dispatch);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      retryOfExecutionId: EXECUTION_ID,
      forceFreshSession: true,
    }));
  });
});
