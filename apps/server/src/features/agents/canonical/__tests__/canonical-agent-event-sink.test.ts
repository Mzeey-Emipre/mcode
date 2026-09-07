import "reflect-metadata";
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_AGENT_EVENT_BATCH_MAX,
  CANONICAL_SUBAGENT_TASK_MAX_LENGTH,
  CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
  MessageSchema,
  SUBAGENT_DISPLAY_NAME_MAX_LENGTH,
  SUBAGENT_METADATA_MAX_LENGTH,
  ThoughtSegmentRecordSchema,
  ToolCallRecordSchema,
  AgentEventType,
  createAgentModelState,
  reduceAgentEventBatch,
  type ParentNarrativeRecoveryItem,
  type CanonicalAgentEventEnvelope,
  MAX_TURN_RECOVERIES,
  type ProviderIdentity,
  type ProviderRuntimeExtension,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { PARENT_ASSISTANT_TEXT_RETAINED_LIMITS } from "../../turns/parent-assistant-text-checkpoint-service.js";
import {
  CANONICAL_AGENT_CONTROL_EVENT_RESERVE,
  CanonicalAgentEventSink,
  type CanonicalAgentEventDraft,
} from "../canonical-agent-event-sink.js";
import { CodexCollaborationEventAdapter } from "../../collaboration/adapters/codex-collaboration-event-adapter.js";
import type { CodexCollaborationDurability } from "../../collaboration/codex-collaboration-durability.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-09T20:00:00.000Z";

function seedThread(db: Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("workspace-1", "Workspace", "C:/workspace", NOW, NOW);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(THREAD_ID, "workspace-1", "Thread", "main", "codex", NOW, NOW);
}

function identity(): ProviderIdentity {
  return {
    providerId: "codex",
    scope: "thread",
    value: "native-thread-1",
    provenance: "native",
  };
}

function initialDrafts(): CanonicalAgentEventDraft[] {
  const sourceIdentities = [identity()];
  return [
    {
      eventId: `${EXECUTION_ID}:thread`,
      routing: { threadId: THREAD_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: {
        type: "thread.recorded",
        thread: {
          id: THREAD_ID,
          workspaceId: "workspace-1",
          rootThreadId: THREAD_ID,
          providerId: "codex",
          providerIdentities: sourceIdentities,
          activityState: "Active",
          conversationRevision: 0,
          rosterRevision: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    },
    {
      eventId: `${EXECUTION_ID}:turn-created`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: {
        type: "turn.created",
        turn: {
          id: TURN_ID,
          threadId: THREAD_ID,
          status: "Pending",
          trigger: { kind: "user" },
          permissionMode: "supervised",
          approvalReviewMode: "manual",
          approvalReviewReason: "manual-requested",
          providerIdentities: sourceIdentities,
          startedAt: null,
          endedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    },
    {
      eventId: `${EXECUTION_ID}:turn-started`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: { type: "turn.started", startedAt: NOW },
    },
  ];
}

function seedUnfinishedCheckpointCount(
  db: Database,
  sink: CanonicalAgentEventSink,
  count: number,
): void {
  const messageRepo = new MessageRepo(db);
  sink.startParentTurn({
    thread: {
      id: THREAD_ID,
      workspaceId: "workspace-1",
      providerId: "codex",
      createdAt: NOW,
    },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "supervised",
    providerIdentities: [],
    projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "bounded recovery", 1),
  });
  const insertTurn = db.prepare(`
    INSERT INTO canonical_agent_turns (
      id, thread_id, execution_id, status, trigger_json, permission_mode,
      provider_identities_json, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'Running', '{"kind":"user"}', 'supervised', '[]', ?, NULL, ?, ?)
  `);
  const insertCheckpoint = db.prepare(`
    INSERT INTO canonical_agent_ingest_checkpoints (
      execution_id, thread_id, turn_id, last_accepted_sequence, last_durable_sequence,
      native_cursor_json, phase, terminal_outcome, error, updated_at
    ) VALUES (?, ?, ?, 4, 4, NULL, 'running', NULL, NULL, ?)
  `);
  db.transaction(() => {
    for (let index = 1; index < count; index += 1) {
      const turnId = `bounded-turn-${index}`;
      const executionId = `bounded-execution-${index}`;
      insertTurn.run(turnId, THREAD_ID, executionId, NOW, NOW, NOW);
      insertCheckpoint.run(executionId, THREAD_ID, turnId, NOW);
    }
  })();
}

function terminalDraft(
  type: "turn.completed" | "turn.errored",
): CanonicalAgentEventDraft {
  return {
    eventId: `${EXECUTION_ID}:${type}`,
    routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
    sourceProviderId: "codex",
    sourceIdentities: [identity()],
    payload: type === "turn.completed"
      ? { type, endedAt: "2026-08-09T20:01:00.000Z" }
      : { type, endedAt: "2026-08-09T20:01:01.000Z", error: "late error" },
  };
}

function startCanonicalParent(
  sink: CanonicalAgentEventSink,
  db: Database,
  approvalReview: { mode: "manual" | "automatic"; reason: string } = { mode: "manual", reason: "manual-requested" },
): void {
  const messageRepo = new MessageRepo(db);
  sink.startParentTurn({
    thread: {
      id: THREAD_ID,
      workspaceId: "workspace-1",
      providerId: "codex",
      createdAt: NOW,
    },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "supervised",
    approvalReviewMode: approvalReview.mode,
    approvalReviewReason: approvalReview.reason,
    providerIdentities: [],
    projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "delegate", 1),
  });
}

function parentNarrativeToolCall(index: number): ParentNarrativeRecoveryItem {
  return {
    kind: "toolCall",
    record: {
      id: `recovery-tool-${index}`,
      message_id: "",
      parent_tool_call_id: null,
      tool_name: "Read",
      display_name: null,
      provider_agent_key: null,
      subagent_identity_key: null,
      subagent_provider_name: null,
      subagent_prompt: null,
      subagent_type: null,
      subagent_agent_id: null,
      subagent_duration_ms: null,
      model: null,
      reasoning_effort: null,
      input_summary: `file-${index}`,
      output_summary: "ok",
      output_total_bytes: null,
      output_artifact_path: null,
      exit_code: null,
      status: "completed",
      started_at: NOW,
      completed_at: NOW,
      sort_order: index,
    },
  };
}

function executionIdForTurn(db: Database, turnId: string): string {
  const row = db.prepare(
    "SELECT execution_id FROM canonical_agent_turns WHERE id = ?",
  ).get(turnId) as { execution_id: string };
  return row.execution_id;
}

describe("CanonicalAgentEventSink", () => {
  let db: Database;
  let published: ReturnType<typeof vi.fn<(events: readonly CanonicalAgentEventEnvelope[]) => void>>;
  let sink: CanonicalAgentEventSink;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    published = vi.fn();
    sink = new CanonicalAgentEventSink(db, published);
  });

  it("retains the resolved approval-review decision when a turn is read after reopening", () => {
    startCanonicalParent(sink, db, { mode: "automatic", reason: "automatic-review-available" });
    const reloaded = new CanonicalAgentEventSink(db, published);

    expect(reloaded.loadTurnByExecution(EXECUTION_ID)).toMatchObject({
      approvalReviewMode: "automatic",
      approvalReviewReason: "automatic-review-available",
    });
  });

  it("checkpoints parent narrative beyond one write transaction without interrupting its turn", () => {
    startCanonicalParent(sink, db);
    const items = Array.from(
      { length: ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows + 1 },
      (_, index) => parentNarrativeToolCall(index),
    );
    const transactions = vi.spyOn(db, "transaction");

    expect(sink.recordParentNarrativeRecovery({ executionId: EXECUTION_ID, items })).toBe(true);

    expect(transactions.mock.calls.length).toBeGreaterThan(1);
    expect(sink.loadTurn(TURN_ID)).toMatchObject({ status: "Running" });
    expect(sink.loadParentNarrativeRecovery(TURN_ID)).toEqual(items);
  });

  it("rejects aggregate parent recovery overflow before it writes", () => {
    startCanonicalParent(sink, db);
    const recordCount = Math.floor(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes / 4_000) + 2;
    const items = Array.from({ length: recordCount }, (_, index) => {
      const item = parentNarrativeToolCall(index);
      return {
        ...item,
        record: { ...item.record, output_summary: "x".repeat(4_000) },
      };
    });
    const before = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get();

    expect(items.every((item) => Buffer.byteLength(JSON.stringify(item), "utf8")
      < ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes)).toBe(true);
    expect(() => sink.recordParentNarrativeRecovery({ executionId: EXECUTION_ID, items }))
      .toThrow("retained byte capacity");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual(before);
  });

  it("commits records, a checkpoint, and one conversation revision before publication", () => {
    const result = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });

    expect(result).toMatchObject({
      outcome: "committed",
      conversationRevision: 1,
      rosterRevision: 0,
      acceptedThrough: 3,
      durableThrough: 3,
    });
    expect(sink.loadThread(THREAD_ID)).toMatchObject({
      id: THREAD_ID,
      conversationRevision: 1,
      providerIdentities: [identity()],
    });
    expect(sink.loadTurn(TURN_ID)).toMatchObject({ id: TURN_ID, status: "Running" });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      turnId: TURN_ID,
      phase: "running",
      lastAcceptedSequence: 3,
      lastDurableSequence: 3,
    });
    expect(published).toHaveBeenCalledTimes(1);
    expect(published.mock.calls[0]![0]).toHaveLength(3);
    expect(published.mock.calls[0]![0].every((event) => event.durableRevision === 1)).toBe(true);
  });

  it("reports deferred canonical delivery without undoing the durable commit", () => {
    const failingPublisher = vi.fn(() => { throw new Error("canonical delivery failed"); });
    const deferredSink = new CanonicalAgentEventSink(db, failingPublisher);

    const result = deferredSink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });

    expect(result).toMatchObject({ outcome: "committed", canonicalDelivery: "deferred" });
    expect(deferredSink.loadTurn(TURN_ID)).toMatchObject({ status: "Running" });
    expect(deferredSink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      lastAcceptedSequence: 3,
      lastDurableSequence: 3,
    });
  });

  it("returns only retained contiguous canonical deltas after known revisions", () => {
    const drafts = initialDrafts().map((draft, index) => ({
      ...draft,
      eventId: ["recovery-z", "recovery-a", "recovery-m"][index]!,
    }));
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: drafts,
    });

    const recovery = sink.recoverThread(THREAD_ID, {
      conversationRevision: 0,
      rosterRevision: 0,
    });

    expect(recovery).toMatchObject({
      mode: "delta",
      from: { conversationRevision: 0, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
    });
    expect(recovery.mode === "delta" ? recovery.events : []).toHaveLength(3);
    expect(recovery.mode === "delta"
      ? recovery.events.every((event) => event.durableRevision === 1)
      : false).toBe(true);
    expect(recovery.mode === "delta"
      ? recovery.events.map((event) => event.acceptedSequence)
      : []).toEqual([1, 2, 3]);
    expect(reduceAgentEventBatch(
      createAgentModelState(),
      recovery.mode === "delta" ? recovery.events : [],
    )).toMatchObject({
      outcome: "applied",
      state: { turns: { [TURN_ID]: { status: "Running" } } },
    });
  });

  it("returns a declared canonical snapshot when retained revisions contain a gap", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "completed",
      terminalOutcome: "completed",
      events: [terminalDraft("turn.completed")],
    });
    db.prepare("DELETE FROM canonical_agent_events WHERE durable_revision = 1").run();

    const recovery = sink.recoverThread(THREAD_ID, {
      conversationRevision: 0,
      rosterRevision: 0,
    });

    expect(recovery).toMatchObject({
      mode: "snapshot",
      snapshot: {
        revision: { conversationRevision: 2, rosterRevision: 0 },
        state: {
          threads: { [THREAD_ID]: { conversationRevision: 2 } },
          turns: { [TURN_ID]: { status: "Completed" } },
        },
      },
    });
  });

  it("returns an empty delta when the renderer already owns current revisions", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });

    expect(sink.recoverThread(THREAD_ID, {
      conversationRevision: 1,
      rosterRevision: 0,
    })).toEqual({
      mode: "delta",
      threadId: THREAD_ID,
      from: { conversationRevision: 1, rosterRevision: 0 },
      through: { conversationRevision: 1, rosterRevision: 0 },
      events: [],
    });
  });

  it("retains only the five fixed active-turn write statements", () => {
    const preparedSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: Database["prepare"] }).prepare = ((sql: string) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    }) as Database["prepare"];
    const instrumentedSink = new CanonicalAgentEventSink(db, vi.fn());

    instrumentedSink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });
    instrumentedSink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "completed",
      terminalOutcome: "completed",
      events: [terminalDraft("turn.completed")],
    });

    const retainedTargets = [
      "INSERT INTO canonical_agent_threads",
      "INSERT INTO canonical_agent_turns",
      "INSERT INTO canonical_agent_items",
      "INSERT INTO canonical_agent_events",
      "INSERT INTO canonical_agent_ingest_checkpoints",
    ];
    expect(retainedTargets.map((target) =>
      preparedSql.filter((sql) => sql.includes(target)).length
    )).toEqual([1, 1, 1, 1, 1]);
  });

  it("accepts duplicate input idempotently without a revision or publication", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });
    published.mockClear();

    const duplicate = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });

    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      conversationRevision: 1,
      acceptedThrough: 3,
      durableThrough: 3,
    });
    expect(published).not.toHaveBeenCalled();
  });

  it("marks unfinished work interrupted without removing accepted content", () => {
    const messageRepo = new MessageRepo(db);
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [identity()],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "keep this work", 1),
    });

    const result = sink.interruptUnfinishedExecution(
      EXECUTION_ID,
      "The provider could not prove that this execution was still active after restart.",
    );

    expect(result.outcome).toBe("committed");
    expect(sink.loadTurn(TURN_ID)).toMatchObject({ status: "Interrupted" });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "interrupted",
      terminalOutcome: "interrupted",
      lastAcceptedSequence: 6,
      lastDurableSequence: 6,
      nativeCursor: identity(),
    });
    expect(sink.loadConversationProjection(THREAD_ID, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "keep this work" }),
    ]);
    expect(published).toHaveBeenLastCalledWith([
      expect.objectContaining({ payload: expect.objectContaining({ type: "thread.recorded" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ type: "turn.interrupted" }) }),
    ]);
  });

  it("makes a staged recovered assistant message visible in the interruption commit", () => {
    const messageRepo = new MessageRepo(db);
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [identity()],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "recover this", 1),
    });
    const staged = messageRepo.createAssistantIdempotent({
      id: "staged-recovery-message",
      threadId: THREAD_ID,
      content: "first durable chunk, then second.",
      sequence: 2,
      isInternal: true,
    });

    sink.interruptUnfinishedExecution(
      EXECUTION_ID,
      "The provider could not prove that this execution was still active after restart.",
      staged,
    );

    expect(messageRepo.findById(staged.id)).toMatchObject({
      content: "first durable chunk, then second.",
      is_internal: false,
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
    });
    expect(sink.loadTerminalProjection(TURN_ID).message).toMatchObject({
      id: staged.id,
      content: "first durable chunk, then second.",
      is_internal: false,
      outcome: "interrupted",
      outcomeExecutionId: EXECUTION_ID,
    });
  });

  it.each([MAX_TURN_RECOVERIES - 1, MAX_TURN_RECOVERIES])(
    "loads %i unfinished checkpoints within the recovery bound",
    (count) => {
      seedUnfinishedCheckpointCount(db, sink, count);

      expect(sink.listUnfinishedCheckpoints()).toHaveLength(count);
    },
  );

  it("rejects unfinished checkpoint overflow explicitly", () => {
    seedUnfinishedCheckpointCount(db, sink, MAX_TURN_RECOVERIES + 1);

    expect(() => sink.listUnfinishedCheckpoints()).toThrow(
      `Canonical unfinished checkpoint count exceeds ${MAX_TURN_RECOVERIES}`,
    );
  });

  it("persists a native cursor that arrives while a turn is running", () => {
    const messageRepo = new MessageRepo(db);
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "checkpoint cursor", 1),
    });

    expect(sink.recordNativeCursor(EXECUTION_ID, identity())).toBe(true);
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "running",
      nativeCursor: identity(),
      lastAcceptedSequence: 4,
      lastDurableSequence: 4,
    });
  });

  it("reloads one ordinary parent turn from canonical message and narrative items", () => {
    const messageRepo = new MessageRepo(db);
    let userMessageId = "";
    let assistantMessageId = "";
    const startInput = {
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => {
        const message = messageRepo.create(THREAD_ID, "user", "canonical question", 1);
        userMessageId = message.id;
        return message;
      },
    } satisfies Parameters<CanonicalAgentEventSink["startParentTurn"]>[0];
    sink.startParentTurn(startInput);
    sink.startParentTurn(startInput);
    const finishInput = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [identity()],
      outcome: "completed",
      projectTurn: () => {
        const message = messageRepo.create(
          THREAD_ID,
          "assistant",
          "canonical answer",
          2,
          undefined,
          undefined,
          undefined,
          "gpt-5.6-sol",
          false,
          undefined,
          undefined,
          { type: "composer" },
        );
        assistantMessageId = message.id;
        return {
          message,
          narrative: [{
            kind: "toolCall",
            sequence: 2,
            sortOrder: 0,
            record: {
              id: "tool-1",
              message_id: message.id,
              parent_tool_call_id: null,
              tool_name: "Read",
              input_summary: "CONTEXT.md",
              output_summary: "read",
              status: "completed",
              started_at: NOW,
              completed_at: "2026-08-09T20:00:01.000Z",
              sort_order: 0,
            },
          }],
        };
      },
    } satisfies Parameters<CanonicalAgentEventSink["finishParentTurn"]>[0];
    sink.finishParentTurn(finishInput);
    sink.finishParentTurn(finishInput);

    db.prepare("UPDATE messages SET content = 'stale compatibility row'").run();
    const projection = sink.loadConversationProjection(THREAD_ID, 10);

    expect(projection.messages.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: userMessageId, content: "canonical question" },
      { id: assistantMessageId, content: "canonical answer" },
    ]);
    expect(projection.narrativeByMessage[assistantMessageId].tools).toEqual([
      expect.objectContaining({ id: "tool-1", tool_name: "Read" }),
    ]);
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "completed",
      terminalOutcome: "completed",
    });
    expect(sink.loadThread(THREAD_ID)).toMatchObject({ providerIdentities: [identity()] });
    expect(db.prepare(
      "SELECT provider_identities_json FROM canonical_agent_items WHERE id = ?",
    ).get(`message:${assistantMessageId}`)).toEqual({
      provider_identities_json: JSON.stringify([identity()]),
    });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toHaveLength(2);
  });

  it("resumes terminal batches when a recovered item changes", async () => {
    const messageRepo = new MessageRepo(db);
    let interruptPublication = false;
    let interrupted = false;
    const batchRows: number[] = [];
    sink = new CanonicalAgentEventSink(db, (events) => {
      batchRows.push(3 + events.reduce(
        (rows, event) => rows + (event.payload.type === "item.recorded" ? 2 : 1),
        0,
      ));
      if (interruptPublication && !interrupted && events.some(
        (event) => event.payload.type === "item.recorded" && event.payload.item.id === "toolCall:tool-0",
      )) {
        interrupted = true;
        throw new Error("simulated interruption");
      }
    });
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "question", 1),
    });
    interruptPublication = true;
    const message = messageRepo.create(THREAD_ID, "assistant", "answer", 2, undefined, undefined, undefined, undefined, true);
    const narrative = Array.from({ length: 100 }, (_, index) => ({
      kind: "toolCall" as const,
      sequence: 2,
      sortOrder: index,
      record: {
        id: `tool-${index}`,
        message_id: message.id,
        parent_tool_call_id: null,
        tool_name: "Read",
        input_summary: `file-${index}`,
        output_summary: "ok",
        status: "completed" as const,
        started_at: NOW,
        completed_at: NOW,
        sort_order: index,
      },
    }));
    let hasFinalToolOutput = false;
    const input = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed" as const,
      projectTurn: () => ({
        message: { ...message, is_internal: false },
        narrative: narrative.map((entry) => entry.record.id === "tool-0"
          ? {
              ...entry,
              record: {
                ...entry.record,
                output_summary: hasFinalToolOutput ? "final" : "partial",
              },
            }
          : entry),
      }),
      finalizeCompatibility: () => messageRepo.publishAssistant(message.id),
    };

    await expect(sink.finishParentTurnBatched(input)).rejects.toThrow("simulated interruption");
    expect(sink.loadCheckpoint(EXECUTION_ID)?.terminalOutcome).toBeNull();
    expect(sink.loadItem("toolCall:tool-0")?.payload).toMatchObject({
      record: { output_summary: "partial" },
    });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toHaveLength(1);
    expect(sink.loadConversationProjection(THREAD_ID, 10).messages).toHaveLength(1);

    hasFinalToolOutput = true;
    const result = await sink.finishParentTurnBatched(input);

    expect(result.outcome).toBe("committed");
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      terminalOutcome: "completed",
      lastAcceptedSequence: 107,
      lastDurableSequence: 107,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 107 });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toHaveLength(2);
    expect(sink.loadConversationProjection(THREAD_ID, 10).messages).toHaveLength(2);
    expect(sink.loadConversationProjection(THREAD_ID, 10).narrativeByMessage[message.id]?.tools)
      .toContainEqual(expect.objectContaining({ id: "tool-0", output_summary: "final" }));
    expect(Math.max(...batchRows)).toBeLessThanOrEqual(ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows);
    expect(db.prepare(`
      SELECT DISTINCT durable_revision
      FROM canonical_agent_events
      WHERE accepted_sequence > 4
    `).all()).toEqual([{ durable_revision: 2 }]);
    expect(sink.loadThread(THREAD_ID)?.conversationRevision).toBe(2);
  });

  it("commits terminal projections above the semantic event limit in bounded batches", async () => {
    const messageRepo = new MessageRepo(db);
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "question", 1),
    });
    const message = messageRepo.create(
      THREAD_ID,
      "assistant",
      "answer",
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const narrative = Array.from({ length: CANONICAL_AGENT_EVENT_BATCH_MAX }, (_, index) => ({
      kind: "toolCall" as const,
      sequence: 2,
      sortOrder: index,
      record: {
        id: `overflow-tool-${index}`,
        message_id: message.id,
        parent_tool_call_id: null,
        tool_name: "Read",
        input_summary: `file-${index}`,
        output_summary: "ok",
        status: "completed" as const,
        started_at: NOW,
        completed_at: NOW,
        sort_order: index,
      },
    }));
    const result = await sink.finishParentTurnBatched({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed",
      projectTurn: () => ({ message: { ...message, is_internal: false }, narrative }),
      finalizeCompatibility: () => messageRepo.publishAssistant(message.id),
    });

    expect(result.outcome).toBe("committed");
    expect(result.writeBatches.batches).toBeGreaterThan(1);
    expect(sink.loadTurn(TURN_ID)).toMatchObject({ status: "Completed" });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "completed",
      terminalOutcome: "completed",
      lastAcceptedSequence: 262,
      lastDurableSequence: 262,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({
      count: 262,
    });
    expect(sink.loadTerminalProjection(TURN_ID)).toMatchObject({
      message: expect.objectContaining({ content: "answer" }),
      toolCallCount: CANONICAL_AGENT_EVENT_BATCH_MAX,
    });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages.map((message) => ({
      content: message.content,
      is_internal: message.is_internal,
    }))).toEqual([
      { content: "question", is_internal: false },
      { content: "answer", is_internal: false },
    ]);
    expect(published.mock.calls.length).toBeGreaterThan(1);
    const publishedEvents = published.mock.calls.flatMap(([events]) => events);
    expect(publishedEvents).toHaveLength(262);
    expect(published.mock.calls.every(([events]) =>
      events.length <= CANONICAL_AGENT_EVENT_BATCH_MAX,
    )).toBe(true);
  });

  it("keeps the first confirmed terminal outcome", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "completed",
      terminalOutcome: "completed",
      events: [terminalDraft("turn.completed")],
    });
    published.mockClear();

    const late = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "errored",
      terminalOutcome: "errored",
      error: "late error",
      events: [terminalDraft("turn.errored")],
    });

    expect(late).toMatchObject({ outcome: "conflict", conversationRevision: 2 });
    expect(sink.loadTurn(TURN_ID)).toMatchObject({ status: "Completed" });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({ terminalOutcome: "completed" });
    expect(published).not.toHaveBeenCalled();
  });

  it.each(["claude", "cursor", "copilot"] as const)(
    "keeps %s terminal evidence stable across duplicate, conflict, and reload",
    (providerId) => {
      const providerIdentity: ProviderIdentity = {
        providerId,
        scope: "session",
        value: "native-session-1",
        provenance: "native",
      };
      const sourceIdentities = [providerIdentity];
      const messageRepo = new MessageRepo(db);
      sink.startParentTurn({
        thread: {
          id: THREAD_ID,
          workspaceId: "workspace-1",
          providerId,
          createdAt: NOW,
        },
        turnId: TURN_ID,
        executionId: EXECUTION_ID,
        permissionMode: "supervised",
        providerIdentities: sourceIdentities,
        projectUserMessage: () => messageRepo.create(THREAD_ID, "user", `${providerId} terminal fixture`, 1),
      });
      const completed = {
        eventId: `${EXECUTION_ID}:${providerId}-completed`,
        routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
        sourceProviderId: providerId,
        sourceIdentities,
        payload: { type: "turn.completed" as const, endedAt: "2026-08-27T12:01:00.000Z" },
      };
      const committed = sink.commit({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        executionId: EXECUTION_ID,
        phase: "completed",
        terminalOutcome: "completed",
        events: [completed],
      });
      const duplicate = sink.commit({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        executionId: EXECUTION_ID,
        phase: "completed",
        terminalOutcome: "completed",
        events: [completed],
      });
      const conflict = sink.commit({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        executionId: EXECUTION_ID,
        phase: "errored",
        terminalOutcome: "errored",
        error: `late ${providerId} error`,
        events: [{
          ...completed,
          eventId: `${EXECUTION_ID}:${providerId}-errored`,
          payload: {
            type: "turn.errored" as const,
            endedAt: "2026-08-27T12:02:00.000Z",
            error: `late ${providerId} error`,
          },
        }],
      });
      const reloaded = new CanonicalAgentEventSink(db, vi.fn());

      expect(committed.outcome).toBe("committed");
      expect(duplicate.outcome).toBe("duplicate");
      expect(conflict.outcome).toBe("conflict");
      expect(reloaded.loadTurnByExecution(EXECUTION_ID)).toMatchObject({ status: "Completed" });
      expect(reloaded.loadCheckpoint(EXECUTION_ID)).toMatchObject({
        terminalOutcome: "completed",
        phase: "completed",
      });
    },
  );

  it("preserves each turn's execution identity across later turns", () => {
    const messageRepo = new MessageRepo(db);
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "first", 1),
    });
    sink.finishParentTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed",
      projectTurn: () => ({ message: null, narrative: [] }),
    });
    const secondExecutionId = "00000000-0000-4000-8000-000000000002";
    sink.startParentTurn({
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        providerId: "codex",
        createdAt: NOW,
      },
      turnId: "turn-2",
      executionId: secondExecutionId,
      permissionMode: "supervised",
      providerIdentities: [],
      projectUserMessage: () => messageRepo.create(THREAD_ID, "user", "second", 2),
    });

    expect(sink.loadTurnByExecution(EXECUTION_ID)?.id).toBe(TURN_ID);
    expect(sink.loadTurnByExecution(secondExecutionId)?.id).toBe("turn-2");
  });

  it("rejects oversized semantic batches and rolls back compatibility writes", () => {
    const messageRepo = new MessageRepo(db);
    const draft = initialDrafts()[0];
    const events = Array.from({ length: 257 }, (_, index) => ({
      ...draft,
      eventId: `oversized:${index}`,
    }));

    expect(() => sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      projectCompatibility: () => {
        messageRepo.create(THREAD_ID, "user", "must roll back", 1);
      },
      events,
    })).toThrow("exceeds 256 events");

    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 0 });
  });

  it("fails closed with durable stopping sequences when structural capacity saturates", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });
    const stopExecution = vi.fn();
    const structuralEvents = Array.from(
      { length: CANONICAL_AGENT_EVENT_BATCH_MAX + 1 },
      (_, index): CanonicalAgentEventDraft => ({
        eventId: `${EXECUTION_ID}:structural-${index}`,
        routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
        sourceProviderId: "codex",
        sourceIdentities: [identity()],
        payload: {
          type: "item.recorded",
          item: {
            id: `structural-${index}`,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            kind: "system",
            providerIdentities: [identity()],
            payload: { index },
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      }),
    );

    const result = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: structuralEvents,
      onOverflow: stopExecution,
    });

    expect(result).toMatchObject({
      outcome: "ingest-overflow",
      acceptedThrough: 4,
      durableThrough: 4,
    });
    expect(stopExecution).toHaveBeenCalledOnce();
    expect(sink.loadTurn(TURN_ID)).toMatchObject({ status: "Interrupted" });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      phase: "ingest_overflow",
      terminalOutcome: "errored",
      lastAcceptedSequence: 4,
      lastDurableSequence: 4,
    });
    const overflow = db.prepare(`
      SELECT envelope_json
      FROM canonical_agent_events
      WHERE event_id = ?
    `).get(`${EXECUTION_ID}:ingest-overflow`) as { envelope_json: string };
    expect(JSON.parse(overflow.envelope_json).payload).toMatchObject({
      type: "ingest.overflow",
      acceptedStoppingSequence: 3,
      durableStoppingSequence: 3,
    });
  });

  it("exports canonical provenance and stopping-point context with redacted diagnostics", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });

    const exported = sink.exportTurnDiagnostics(TURN_ID);

    expect(exported.canonical).toMatchObject({
      thread: {
        id: THREAD_ID,
        providerIdentities: [identity()],
        conversationRevision: 1,
        rosterRevision: 0,
      },
      turn: {
        id: TURN_ID,
        providerIdentities: [identity()],
      },
      checkpoint: {
        executionId: EXECUTION_ID,
        lastAcceptedSequence: 3,
        lastDurableSequence: 3,
      },
    });
    expect(exported.canonical.events.map((event) => event.payload.type)).toEqual([
      "thread.recorded",
      "turn.created",
      "turn.started",
    ]);
    expect(exported.canonical.eventTruncation).toEqual({ droppedEvents: 0 });
    expect(exported.canonical.truncationMarkers).toEqual([]);
  });

  it.each([
    CANONICAL_AGENT_EVENT_BATCH_MAX - 1,
    CANONICAL_AGENT_EVENT_BATCH_MAX,
  ])("accepts %i structural events within the semantic bound", (count) => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });
    const structuralEvents = Array.from(
      { length: count },
      (_, index): CanonicalAgentEventDraft => ({
        eventId: `${EXECUTION_ID}:bounded-structural-${index}`,
        routing: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          executionId: EXECUTION_ID,
          itemId: `bounded-structural-${index}`,
        },
        sourceProviderId: "codex",
        sourceIdentities: [],
        payload: {
          type: "item.recorded",
          item: {
            id: `bounded-structural-${index}`,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            kind: "system",
            providerIdentities: [],
            payload: { index },
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      }),
    );

    const result = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: structuralEvents,
    });

    expect(result.outcome).toBe("committed");
    expect(result.events).toHaveLength(count);
  });

  it("keeps control capacity and records explicit volatile truncation metadata", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    });
    const volatileEvents = Array.from(
      { length: CANONICAL_AGENT_EVENT_BATCH_MAX },
      (_, index): CanonicalAgentEventDraft => ({
        eventId: `${EXECUTION_ID}:volatile-${index}`,
        routing: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          executionId: EXECUTION_ID,
          itemId: `volatile-${index}`,
        },
        sourceProviderId: "codex",
        sourceIdentities: [],
        ingestClass: "volatile",
        payload: {
          type: "item.recorded",
          item: {
            id: `volatile-${index}`,
            threadId: THREAD_ID,
            turnId: TURN_ID,
            kind: "reasoning",
            providerIdentities: [],
            payload: { delta: "x" },
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      }),
    );

    const result = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "completed",
      terminalOutcome: "completed",
      events: [...volatileEvents, terminalDraft("turn.completed")],
    });

    expect(result.outcome).toBe("committed");
    expect(result.events.at(-2)?.payload).toMatchObject({
      type: "ingest.volatile-truncated",
      droppedEventCount: CANONICAL_AGENT_CONTROL_EVENT_RESERVE,
    });
    expect(result.events.at(-1)?.payload.type).toBe("turn.completed");

    const replay = sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "completed",
      terminalOutcome: "completed",
      events: [...volatileEvents, terminalDraft("turn.completed")],
    });
    expect(replay.outcome).toBe("duplicate");
    const markers = db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_events
      WHERE envelope_json LIKE '%ingest.volatile-truncated%'
    `).get() as { count: number };
    expect(markers.count).toBe(1);
  });

  it("rolls back records and publishes nothing when the checkpoint write fails", () => {
    db.exec(`
      CREATE TRIGGER reject_checkpoint
      BEFORE INSERT ON canonical_agent_ingest_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'forced checkpoint failure');
      END;
    `);

    expect(() => sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
    })).toThrow("forced checkpoint failure");

    expect(sink.loadThread(THREAD_ID)).toBeNull();
    expect(sink.loadTurn(TURN_ID)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 0 });
    expect(published).not.toHaveBeenCalled();
  });

  it("provisions one Starting child without creating a synthetic child turn", () => {
    startCanonicalParent(sink, db);
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-1",
      receiverThreadIds: ["native-child-a", "native-child-b"],
      description: "same name",
      prompt: "same prompt",
      providerIdentities: [],
    });

    expect(delegation.childThread).toMatchObject({
      parentThreadId: THREAD_ID,
      rootThreadId: THREAD_ID,
      owningParentThreadId: THREAD_ID,
      activityState: "Starting",
      providerIdentities: [],
    });
    expect(delegation.collaborationAction).toMatchObject({
      status: "Dispatched",
      target: { threadId: delegation.childThread.id },
    });
    expect(sink.loadThread(THREAD_ID)?.rosterRevision).toBe(1);
    expect(sink.loadTurnByExecution(delegation.childThread.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE thread_id = ?")
      .get(delegation.childThread.id)).toEqual({ count: 0 });
  });

  it("keeps rejection, unknown delivery, late proof, and replacement retry distinct", () => {
    // Regression: a timeout or crash must not be persisted as confirmed rejection,
    // and retry must never reuse a child whose provider side effect is uncertain.
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-delivery-states",
      receiverThreadIds: ["native-delivery-states"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const uncertain = sink.startCodexChildDelegation(input);
    const unknown = sink.markCodexChildDeliveryUnknown({
      ...input,
      nativeThreadId: "native-delivery-states",
    });
    expect(unknown.collaborationAction).toMatchObject({
      status: "Dispatched",
      deliveryUnknown: true,
    });
    expect(sink.loadThread(uncertain.childThread.id)?.activityState).toBe("Unavailable");

    const replacement = sink.retryCodexChildDelegation({
      ...input,
      parentItemId: "toolCall:spawn-delivery-retry",
      receiverThreadIds: ["native-delivery-retry"],
      previousActionId: uncertain.collaborationAction.id,
    });
    expect(replacement.childThread.id).not.toBe(uncertain.childThread.id);
    expect(replacement.parentItem.payload).toMatchObject({
      replacementForActionId: uncertain.collaborationAction.id,
    });

    const lateTurn = sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-delivery-states",
      nativeTurnId: "native-turn-late-proof",
    });
    expect(lateTurn.status).toBe("Running");
    expect(sink.loadCollaborationAction(uncertain.collaborationAction.id)).toMatchObject({
      status: "Acknowledged",
      deliveryUnknown: false,
      target: { threadId: uncertain.childThread.id, turnId: lateTurn.id },
    });

    const rejectedInput = {
      ...input,
      parentItemId: "toolCall:spawn-confirmed-rejection",
      receiverThreadIds: ["native-confirmed-rejection"],
    };
    const rejected = sink.startCodexChildDelegation(rejectedInput);
    const failed = sink.markCodexChildDeliveryRejected({
      ...rejectedInput,
      nativeThreadId: "native-confirmed-rejection",
    });
    expect(failed.collaborationAction).toMatchObject({
      status: "Failed",
      deliveryUnknown: false,
    });
    expect(sink.loadThread(rejected.childThread.id)?.activityState).toBe("Unavailable");
    expect(() => sink.startCodexChildTurn({
      ...rejectedInput,
      nativeThreadId: "native-confirmed-rejection",
      nativeTurnId: "native-turn-after-rejection",
    })).toThrow("confirmed Codex child rejection");
    expect(() => sink.markCodexChildDeliveryUnknown({
      ...rejectedInput,
      nativeThreadId: "native-confirmed-rejection",
    })).toThrow("confirmed Codex child rejection");

  });

  it("rejects retry for still-live pending and dispatched child actions", () => {
    // Regression: retrying a live action can create duplicate provider work.
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:retry-live-dispatched",
      receiverThreadIds: ["native-retry-live-dispatched"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const dispatched = sink.startCodexChildDelegation(input);
    expect(() => sink.retryCodexChildDelegation({
      ...input,
      parentItemId: "toolCall:retry-live-dispatched-replacement",
      previousActionId: dispatched.collaborationAction.id,
    })).toThrow("not retryable");

    db.prepare("UPDATE canonical_collaboration_actions SET status = 'Pending' WHERE id = ?")
      .run(dispatched.collaborationAction.id);
    expect(() => sink.retryCodexChildDelegation({
      ...input,
      parentItemId: "toolCall:retry-live-pending-replacement",
      previousActionId: dispatched.collaborationAction.id,
    })).toThrow("not retryable");
  });

  it("publishes and reloads an unavailable child state with revisions", () => {
    // Regression: raw child SQL updates bypass canonical state, reconnect revisions, and child publication.
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:rejection-publication",
      receiverThreadIds: ["native-rejection-publication"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(input);
    const parentBeforeRejection = sink.loadThread(THREAD_ID)!;
    published.mockClear();

    sink.markCodexChildDeliveryRejected({
      ...input,
      nativeThreadId: "native-rejection-publication",
    });

    expect(published).toHaveBeenCalledTimes(2);
    expect(published.mock.calls[0]![0].every((event) => event.routing.threadId === THREAD_ID)).toBe(true);
    expect(published.mock.calls[1]![0].every((event) => (
      event.routing.threadId === delegation.childThread.id
    ))).toBe(true);
    expect(published.mock.calls[1]![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "thread.recorded",
          thread: expect.objectContaining({
            id: delegation.childThread.id,
            activityState: "Unavailable",
          }),
        }),
      }),
    ]));
    expect(sink.loadThread(delegation.childThread.id)).toMatchObject({
      activityState: "Unavailable",
      conversationRevision: 1,
    });
    expect(sink.loadThread(THREAD_ID)).toMatchObject({
      rosterRevision: parentBeforeRejection.rosterRevision + 1,
      conversationRevision: parentBeforeRejection.conversationRevision + 1,
    });
    expect(sink.recoverThread(delegation.childThread.id, {
      conversationRevision: 0,
      rosterRevision: 0,
    }).mode).toBe("snapshot");
  });

  it("loads roster metadata from the exact parent source item", () => {
    startCanonicalParent(sink, db);
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-roster-source",
      receiverThreadIds: ["native-roster-source"],
      description: "Inspect the source item",
      identity: "Roster analyst",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      providerIdentities: [identity()],
    });

    const roster = sink.loadSubagentRoster({
      owningParentThreadId: THREAD_ID,
      limit: CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    });

    expect(roster).toMatchObject({
      owningParentThreadId: THREAD_ID,
      active: [{
        id: delegation.childThread.id,
        parentThreadId: THREAD_ID,
        lineage: [THREAD_ID, delegation.childThread.id],
        sourceItemId: "toolCall:spawn-roster-source",
        task: "Inspect the source item",
        identity: "Roster analyst",
        model: "gpt-5.6-sol",
        reasoning: "high",
        sourceProviderIdentities: [identity()],
        providerIdentities: [
          identity(),
          {
            providerId: "codex",
            scope: "parentItem",
            value: "receiverThreadId:native-roster-source",
            provenance: "native",
          },
        ],
      }],
      done: [],
    });
  });

  it("loads roster metadata after the parent source becomes a generic tool-call projection", () => {
    startCanonicalParent(sink, db);
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-generic-roster-source",
      receiverThreadIds: ["native-generic-roster-source"],
      providerIdentities: [],
    });
    db.prepare(`
      UPDATE canonical_agent_items
      SET payload_json = ?
      WHERE id = ?
    `).run(JSON.stringify({
      projection: "toolCall",
      record: {
        tool_name: "Agent",
        display_name: "Franklin",
        subagent_prompt: null,
        input_summary: "verify_ui_child",
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
      },
    }), "toolCall:spawn-generic-roster-source");

    const restoredSink = new CanonicalAgentEventSink(db, vi.fn());
    const row = restoredSink.loadSubagentRoster({
      owningParentThreadId: THREAD_ID,
      limit: CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    }).active[0];

    expect(row).toMatchObject({
      id: delegation.childThread.id,
      sourceItemId: "toolCall:spawn-generic-roster-source",
      task: "verify_ui_child",
      identity: "Franklin",
      model: "gpt-5.6-luna",
      reasoning: "low",
    });
  });

  it("enriches an existing delegation when authoritative child metadata arrives later", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-late-roster-metadata",
      receiverThreadIds: ["native-late-roster-metadata"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(input);
    const childTurn = sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-late-roster-metadata",
      nativeTurnId: "native-turn-late-roster-metadata",
    });

    const enriched = sink.startCodexChildDelegation({
      ...input,
      description: "Inspect late metadata",
      prompt: "Inspect the v2 child metadata.",
      identity: "Worker",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      providerIdentities: [identity()],
    });
    const roster = sink.loadSubagentRoster({
      owningParentThreadId: THREAD_ID,
      limit: CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    });

    expect(enriched.childThread.id).toBe(delegation.childThread.id);
    expect(enriched.collaborationAction.message).toBe("Inspect the v2 child metadata.");
    expect(roster.active).toHaveLength(1);
    expect(roster.active[0]).toMatchObject({
      id: delegation.childThread.id,
      task: "Inspect late metadata",
      identity: "Worker",
      model: "gpt-5.6-terra",
      reasoning: "medium",
      sourceProviderIdentities: [identity()],
    });
    const promptRow = db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE thread_id = ?
        AND turn_id = ?
        AND kind = 'message'
    `).get(delegation.childThread.id, childTurn.id) as { payload_json: string } | undefined;
    expect(promptRow).toBeDefined();
    expect(JSON.parse(promptRow!.payload_json)).toMatchObject({
      projection: "message",
      message: {
        role: "user",
        content: "Inspect the v2 child metadata.",
        parentAgentProvenance: {
          parentThreadId: THREAD_ID,
          parentTurnId: TURN_ID,
          parentItemId: input.parentItemId,
        },
      },
    });
  });

  it("bounds hostile roster metadata before canonical persistence", () => {
    startCanonicalParent(sink, db);
    const description = "d".repeat(CANONICAL_SUBAGENT_TASK_MAX_LENGTH + 1);
    const identityValue = "i".repeat(SUBAGENT_DISPLAY_NAME_MAX_LENGTH + 1);
    const model = "m".repeat(SUBAGENT_METADATA_MAX_LENGTH + 1);
    const reasoningEffort = "r".repeat(SUBAGENT_METADATA_MAX_LENGTH + 1);
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-hostile-roster-metadata",
      description,
      identity: identityValue,
      model,
      reasoningEffort,
      providerIdentities: [],
    });

    const row = sink.loadSubagentRoster({
      owningParentThreadId: THREAD_ID,
      limit: CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    }).active[0]!;

    expect(row.task).toHaveLength(CANONICAL_SUBAGENT_TASK_MAX_LENGTH);
    expect(row.identity).toHaveLength(SUBAGENT_DISPLAY_NAME_MAX_LENGTH);
    expect(row.model).toBeUndefined();
    expect(row.reasoning).toBeUndefined();
    expect(JSON.stringify(sink.loadItem(delegation.parentItem.id)?.payload)).not.toContain(description);
  });

  it("bounds unique nested roster rows and orders active and terminal descendants", () => {
    startCanonicalParent(sink, db);
    const activeEarly = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-active-early",
      receiverThreadIds: ["native-active-early"],
      providerIdentities: [],
    });
    const activeEarlyTurn = sink.startCodexChildTurn({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-active-early",
      nativeThreadId: "native-active-early",
      nativeTurnId: "native-turn-active-early",
    });
    const activeLate = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-active-late",
      receiverThreadIds: ["native-active-late"],
      providerIdentities: [],
    });
    const activeLateTurn = sink.startCodexChildTurn({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-active-late",
      nativeThreadId: "native-active-late",
      nativeTurnId: "native-turn-active-late",
    });
    const nested = sink.startCodexChildDelegation({
      parentThreadId: activeEarly.childThread.id,
      parentTurnId: activeEarlyTurn.id,
      parentExecutionId: executionIdForTurn(db, activeEarlyTurn.id),
      parentItemId: "toolCall:spawn-nested",
      receiverThreadIds: ["native-nested"],
      providerIdentities: [],
    });
    const nestedTurn = sink.startCodexChildTurn({
      parentThreadId: activeEarly.childThread.id,
      parentTurnId: activeEarlyTurn.id,
      parentExecutionId: executionIdForTurn(db, activeEarlyTurn.id),
      parentItemId: "toolCall:spawn-nested",
      nativeThreadId: "native-nested",
      nativeTurnId: "native-turn-nested",
    });
    sink.finishCodexChildTurn({
      childThreadId: nested.childThread.id,
      nativeTurnId: "native-turn-nested",
      outcome: "completed",
    });
    const errored = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-errored",
      receiverThreadIds: ["native-errored"],
      providerIdentities: [],
    });
    const erroredTurn = sink.startCodexChildTurn({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-errored",
      nativeThreadId: "native-errored",
      nativeTurnId: "native-turn-errored",
    });
    sink.finishCodexChildTurn({
      childThreadId: errored.childThread.id,
      nativeTurnId: "native-turn-errored",
      outcome: "errored",
    });
    const interrupted = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-interrupted",
      receiverThreadIds: ["native-interrupted"],
      providerIdentities: [],
    });
    const interruptedTurn = sink.startCodexChildTurn({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-interrupted",
      nativeThreadId: "native-interrupted",
      nativeTurnId: "native-turn-interrupted",
    });
    sink.finishCodexChildTurn({
      childThreadId: interrupted.childThread.id,
      nativeTurnId: "native-turn-interrupted",
      outcome: "interrupted",
    });

    db.prepare("UPDATE canonical_agent_turns SET started_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-08-09T20:00:01.000Z", "2026-08-09T20:00:01.000Z", activeEarlyTurn.id);
    db.prepare("UPDATE canonical_agent_turns SET started_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-08-09T20:00:02.000Z", "2026-08-09T20:00:02.000Z", activeLateTurn.id);
    db.prepare("UPDATE canonical_agent_turns SET ended_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-08-09T20:00:05.000Z", "2026-08-09T20:00:05.000Z", nestedTurn.id);
    db.prepare("UPDATE canonical_agent_turns SET ended_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-08-09T20:00:04.000Z", "2026-08-09T20:00:04.000Z", erroredTurn.id);
    db.prepare("UPDATE canonical_agent_turns SET ended_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-08-09T20:00:03.000Z", "2026-08-09T20:00:03.000Z", interruptedTurn.id);

    const roster = sink.loadSubagentRoster({
      owningParentThreadId: THREAD_ID,
      limit: CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    });

    expect(roster.active.map((row) => row.id)).toEqual([
      activeEarly.childThread.id,
      activeLate.childThread.id,
    ]);
    expect(roster.done.map((row) => row.id)).toEqual([
      nested.childThread.id,
      errored.childThread.id,
      interrupted.childThread.id,
    ]);
    expect(roster.done.map((row) => row.terminalOutcome)).toEqual([
      "Completed",
      "Errored",
      "Interrupted",
    ]);
    expect(roster.done.find((row) => row.id === nested.childThread.id)?.lineage).toEqual([
      THREAD_ID,
      activeEarly.childThread.id,
      nested.childThread.id,
    ]);
    const ids = [...roster.active, ...roster.done].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN);
    const bounded = sink.loadSubagentRoster({ owningParentThreadId: THREAD_ID, limit: 1 });
    expect(bounded.active).toHaveLength(1);
    expect(bounded.done).toHaveLength(0);
  });

  it("loads every descendant stop target once with nested children first", () => {
    startCanonicalParent(sink, db);
    const direct = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-stop-direct",
      receiverThreadIds: ["native-stop-direct"],
      providerIdentities: [],
    });
    const directTurn = sink.startCodexChildTurn({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-stop-direct",
      nativeThreadId: "native-stop-direct",
      nativeTurnId: "native-turn-stop-direct",
    });
    const nested = sink.startCodexChildDelegation({
      parentThreadId: direct.childThread.id,
      parentTurnId: directTurn.id,
      parentExecutionId: executionIdForTurn(db, directTurn.id),
      parentItemId: "toolCall:spawn-stop-nested",
      receiverThreadIds: ["native-stop-nested"],
      providerIdentities: [],
    });
    sink.startCodexChildTurn({
      parentThreadId: direct.childThread.id,
      parentTurnId: directTurn.id,
      parentExecutionId: executionIdForTurn(db, directTurn.id),
      parentItemId: "toolCall:spawn-stop-nested",
      nativeThreadId: "native-stop-nested",
      nativeTurnId: "native-turn-stop-nested",
    });

    const targets = sink.loadCanonicalChildStopTargets(THREAD_ID);

    expect(targets.map((target) => target.childThread.id)).toEqual([
      nested.childThread.id,
      direct.childThread.id,
    ]);
    expect(targets.every((target) => target.latestTurn?.status === "Running")).toBe(true);
  });

  it("retains a newer active descendant when older done rows exceed the roster bound", () => {
    startCanonicalParent(sink, db);
    const insertThread = db.prepare(`
      INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCanonicalThread = db.prepare(`
      INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const oldTimestamp = "2026-08-01T00:00:00.000Z";
    for (let index = 0; index < CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN; index += 1) {
      const id = `thread:fixture-done-${String(index).padStart(3, "0")}`;
      insertThread.run(id, "workspace-1", id, "main", "codex", oldTimestamp, oldTimestamp);
      insertCanonicalThread.run(
        id,
        "workspace-1",
        THREAD_ID,
        THREAD_ID,
        THREAD_ID,
        "codex",
        "[]",
        "Idle",
        0,
        0,
        oldTimestamp,
        oldTimestamp,
      );
    }
    const newerActiveId = "thread:fixture-active-new";
    const newerTimestamp = "2026-08-02T00:00:00.000Z";
    insertThread.run(
      newerActiveId,
      "workspace-1",
      newerActiveId,
      "main",
      "codex",
      newerTimestamp,
      newerTimestamp,
    );
    insertCanonicalThread.run(
      newerActiveId,
      "workspace-1",
      THREAD_ID,
      THREAD_ID,
      THREAD_ID,
      "codex",
      "[]",
      "Active",
      0,
      0,
      newerTimestamp,
      newerTimestamp,
    );

    const roster = sink.loadSubagentRoster({
      owningParentThreadId: THREAD_ID,
      limit: CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    });

    expect(roster.active.map((row) => row.id)).toEqual([newerActiveId]);
    expect(roster.done).toHaveLength(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN - 1);
    expect([...roster.active, ...roster.done]).toHaveLength(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN);
  });

  it("projects child messages and narrative with persisted timestamps and native correlation", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-projection",
      receiverThreadIds: ["native-projection"],
      prompt: "Child prompt",
      providerIdentities: [identity()],
    };
    const delegation = sink.startCodexChildDelegation(input);
    sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-projection",
      nativeTurnId: "native-turn-projection",
    });
    const reasoning = sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-projection",
      nativeItemId: "native-reasoning",
      eventKey: "delta-1",
      kind: "reasoning",
      payload: { projection: "codexChildReasoning", content: "Thinking" },
    });
    const toolCall = sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-projection",
      nativeItemId: "native-tool",
      eventKey: "started",
      kind: "tool-call",
      payload: {
        projection: "codexChildToolCall",
        toolName: "Read",
        toolInput: { path: "src/app.ts" },
      },
    });
    const toolResult = sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-projection",
      nativeItemId: "native-tool",
      eventKey: "completed",
      kind: "tool-result",
      payload: {
        projection: "codexChildToolResult",
        output: "file contents",
        isError: false,
      },
    });
    sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-projection",
      nativeItemId: "native-message",
      eventKey: "completed",
      kind: "message",
      payload: {
        projection: "message",
        message: {
          id: "child-answer",
          role: "assistant",
          content: "Child answer",
          parentAgentProvenance: {
            parentThreadId: THREAD_ID,
            parentTurnId: TURN_ID,
            parentItemId: input.parentItemId,
            providerIdentities: [],
          },
        },
      },
    });
    sink.finishCodexChildTurn({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-projection",
      outcome: "completed",
    });
    db.prepare("UPDATE canonical_agent_items SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-08-09T20:00:10.000Z", "2026-08-09T20:00:11.000Z", reasoning.id);
    db.prepare("UPDATE canonical_agent_items SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-08-09T20:00:12.000Z", "2026-08-09T20:00:13.000Z", toolCall.id);
    db.prepare("UPDATE canonical_agent_items SET created_at = ?, updated_at = ? WHERE id = ?").run(
      "2026-08-09T20:00:14.000Z",
      "2026-08-09T20:00:15.000Z",
      toolResult.id,
    );
    sink.startCodexChildTurn({
      ...input,
      prompt: undefined,
      nativeThreadId: "native-projection",
      nativeTurnId: "native-turn-unrelated",
    });
    sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-unrelated",
      nativeItemId: "native-unrelated-reasoning",
      eventKey: "completed",
      kind: "reasoning",
      payload: { projection: "codexChildReasoning", content: "Unrelated turn" },
    });

    const projection = sink.loadConversationProjection(delegation.childThread.id, 10);
    const repeatedProjection = sink.loadConversationProjection(delegation.childThread.id, 10);

    expect(projection).toEqual(repeatedProjection);
    expect(projection.messages.map((message) => message.sequence)).toEqual([0, 1]);
    expect(projection.messages.every((message) => message.thread_id === delegation.childThread.id)).toBe(true);
    projection.messages.forEach((message) => MessageSchema().parse(message));
    expect(projection.messages[0]).toMatchObject({
      role: "user",
      content: "Child prompt",
      parentAgentProvenance: {
        parentThreadId: THREAD_ID,
        parentTurnId: TURN_ID,
        parentItemId: input.parentItemId,
      },
    });
    expect(projection.messages[1]).not.toHaveProperty("parentAgentProvenance");
    expect(JSON.stringify(projection.narrativeByMessage)).not.toContain("Unrelated turn");
    const childNarrative = projection.narrativeByMessage[projection.messages[1]!.id]!;
    childNarrative.tools.forEach((record) => ToolCallRecordSchema().parse(record));
    childNarrative.thoughts.forEach((record) => ThoughtSegmentRecordSchema().parse(record));
    expect(childNarrative.tools).toEqual([expect.objectContaining({
      tool_name: "Read",
      input_summary: JSON.stringify({ path: "src/app.ts" }),
      output_summary: "file contents",
      status: "completed",
      started_at: "2026-08-09T20:00:12.000Z",
      completed_at: "2026-08-09T20:00:15.000Z",
    })]);
    expect(childNarrative.thoughts).toEqual([expect.objectContaining({
      text: "Thinking",
      started_at: "2026-08-09T20:00:10.000Z",
      ended_at: "2026-08-09T20:00:11.000Z",
    })]);

    const newerPage = sink.loadConversationProjection(
      delegation.childThread.id,
      1,
      undefined,
      0,
    );
    expect(newerPage.messages.map((message) => message.id)).toEqual(["child-answer"]);
    expect(newerPage.narrativeByMessage["child-answer"]!.tools).toEqual(childNarrative.tools);
    expect(newerPage.narrativeByMessage["child-answer"]!.thoughts).toEqual(childNarrative.thoughts);

    const olderPage = sink.loadConversationProjection(
      delegation.childThread.id,
      1,
      1,
    );
    expect(olderPage.messages.map((message) => message.role)).toEqual(["user"]);
    expect(olderPage.narrativeByMessage[projection.messages[0]!.id]).toEqual({
      tools: [],
      thoughts: [],
      hooks: [],
    });
  });

  it("binds only registered receiver identity and rejects reassignment", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-structural",
      receiverThreadIds: ["native-child-a", "native-child-b"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const provisional = sink.startCodexChildDelegation(input);
    expect(() => sink.bindCodexChildIdentity({
      ...input,
      nativeThreadId: "native-child-c",
    })).toThrow("not a registered receiver");
    expect(sink.loadThread(provisional.childThread.id)?.providerIdentities).toEqual([]);

    const bound = sink.bindCodexChildIdentity({ ...input, nativeThreadId: "native-child-a" });
    expect(bound.collaborationAction.status).toBe("Acknowledged");
    expect(bound.childThread.providerIdentities).toEqual([{
      providerId: "codex",
      scope: "thread",
      value: "native-child-a",
      provenance: "native",
    }]);
    expect(() => sink.bindCodexChildIdentity({
      ...input,
      nativeThreadId: "native-child-b",
    })).toThrow("identity conflict");
    expect(sink.loadThread(provisional.childThread.id)?.providerIdentities).toEqual(bound.childThread.providerIdentities);
  });

  it("keeps one child thread across provider-started follow-up turns", () => {
    startCanonicalParent(sink, db);
    const delegationInput = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-multi-turn",
      receiverThreadIds: ["native-child-multi-turn"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(delegationInput);
    const firstTurn = sink.startCodexChildTurn({
      ...delegationInput,
      nativeThreadId: "native-child-multi-turn",
      nativeTurnId: "native-child-turn-1",
    });
    sink.finishCodexChildTurn({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-child-turn-1",
      outcome: "completed",
    });

    const followUp = sink.recordCollaborationAction({
      actionId: "collaboration:follow-up-1",
      kind: "follow-up",
      sourceThreadId: THREAD_ID,
      sourceTurnId: TURN_ID,
      sourceExecutionId: EXECUTION_ID,
      sourceItemId: "toolCall:follow-up-1",
      targetThreadId: delegation.childThread.id,
      status: "Dispatched",
      providerIdentities: [],
      payload: { prompt: "Inspect the next case." },
    });
    expect(followUp.target).toEqual({ threadId: delegation.childThread.id });

    const secondTurn = sink.startCodexChildTurn({
      ...delegationInput,
      nativeThreadId: "native-child-multi-turn",
      nativeTurnId: "native-child-turn-2",
      triggerActionId: followUp.id,
    });

    expect(secondTurn.id).not.toBe(firstTurn.id);
    expect(secondTurn.threadId).toBe(delegation.childThread.id);
    expect(secondTurn.trigger).toEqual({
      kind: "child",
      sourceThreadId: THREAD_ID,
      sourceTurnId: TURN_ID,
      sourceItemId: "toolCall:follow-up-1",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE thread_id = ?")
      .get(delegation.childThread.id)).toEqual({ count: 2 });
    expect(db.prepare("SELECT target_turn_id FROM canonical_collaboration_actions WHERE id = ?")
      .get(followUp.id)).toEqual({ target_turn_id: secondTurn.id });
    expect(sink.loadCodexChildDelegation(THREAD_ID, delegationInput.parentItemId)?.collaborationAction.target)
      .toEqual({ threadId: delegation.childThread.id, turnId: firstTurn.id });
  });

  it("links an injected message to the active child turn without creating a turn", () => {
    startCanonicalParent(sink, db);
    const delegationInput = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-active-message",
      receiverThreadIds: ["native-child-active-message"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(delegationInput);
    const childTurn = sink.startCodexChildTurn({
      ...delegationInput,
      nativeThreadId: "native-child-active-message",
      nativeTurnId: "native-child-active-turn",
    });

    const messageAction = sink.recordCollaborationAction({
      actionId: "collaboration:message-active",
      kind: "message",
      sourceThreadId: THREAD_ID,
      sourceTurnId: TURN_ID,
      sourceExecutionId: EXECUTION_ID,
      sourceItemId: "toolCall:message-active",
      targetThreadId: delegation.childThread.id,
      status: "Acknowledged",
      providerIdentities: [],
      payload: { prompt: "Use the existing turn." },
    });

    expect(messageAction.target).toEqual({
      threadId: delegation.childThread.id,
      turnId: childTurn.id,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE thread_id = ?")
      .get(delegation.childThread.id)).toEqual({ count: 1 });
  });

  it("starts a parent assistant turn only from a recorded child continuation action", () => {
    startCanonicalParent(sink, db);
    const delegationInput = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-parent-continuation",
      receiverThreadIds: ["native-child-parent-continuation"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(delegationInput);
    const childTurn = sink.startCodexChildTurn({
      ...delegationInput,
      nativeThreadId: "native-child-parent-continuation",
      nativeTurnId: "native-child-turn-parent-continuation",
    });
    const childExecutionId = sink.loadExecutionIdForTurn(childTurn.id);
    const action = sink.recordCollaborationAction({
      actionId: "collaboration:child-return-parent",
      kind: "return-result",
      sourceThreadId: delegation.childThread.id,
      sourceTurnId: childTurn.id,
      sourceExecutionId: childExecutionId,
      sourceItemId: "item:child-return-parent",
      targetThreadId: THREAD_ID,
      status: "Dispatched",
      providerIdentities: [{
        providerId: "codex",
        scope: "item",
        value: "native-return-parent",
        provenance: "native",
      }],
      payload: { projection: "codexCollaboration" },
    });
    const restoredSink = new CanonicalAgentEventSink(db, vi.fn());
    expect(restoredSink.loadCollaborationActionBySourceProviderIdentity(
      delegation.childThread.id,
      childTurn.id,
      {
        providerId: "codex",
        scope: "item",
        value: "native-return-parent",
        provenance: "native",
      },
    )?.id).toBe(action.id);
    restoredSink.recordCollaborationAction({
      actionId: "collaboration:child-return-parent-ambiguous",
      kind: "return-result",
      sourceThreadId: delegation.childThread.id,
      sourceTurnId: childTurn.id,
      sourceExecutionId: childExecutionId,
      sourceItemId: "item:child-return-parent-ambiguous",
      targetThreadId: THREAD_ID,
      status: "Dispatched",
      providerIdentities: [
        {
          providerId: "codex",
          scope: "item",
          value: "native-return-parent",
          provenance: "native",
        },
      ],
      payload: { projection: "codexCollaboration" },
    });
    expect(() => restoredSink.loadCollaborationActionBySourceProviderIdentity(
      delegation.childThread.id,
      childTurn.id,
      {
        providerId: "codex",
        scope: "item",
        value: "native-return-parent",
        provenance: "native",
      },
    )).toThrow("ambiguous");
    published.mockClear();

    const continuation = sink.startProviderContinuation({
      parentThreadId: THREAD_ID,
      turnId: "turn:provider-continuation",
      executionId: "00000000-0000-4000-8000-000000000002",
      permissionMode: "full",
      providerIdentities: [],
      triggerActionId: action.id,
    });

    expect(continuation.threadId).toBe(THREAD_ID);
    expect(continuation.trigger).toEqual({
      kind: "child",
      sourceThreadId: delegation.childThread.id,
      sourceTurnId: childTurn.id,
      sourceItemId: "item:child-return-parent",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE thread_id = ? AND kind = 'message'")
      .get(THREAD_ID)).toEqual({ count: 1 });
    expect(sink.loadCollaborationAction(action.id)?.target).toEqual({
      threadId: THREAD_ID,
      turnId: continuation.id,
    });
    expect(published).toHaveBeenCalledTimes(2);
    expect(published.mock.calls[0]![0].every((event) => (
      event.routing.threadId === delegation.childThread.id
    ))).toBe(true);
    expect(published.mock.calls[1]![0].every((event) => (
      event.routing.threadId === THREAD_ID
    ))).toBe(true);
  });

  it("rolls back continuation acknowledgement when parent turn creation fails", () => {
    startCanonicalParent(sink, db);
    const delegationInput = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-parent-continuation-rollback",
      receiverThreadIds: ["native-child-parent-continuation-rollback"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(delegationInput);
    const childTurn = sink.startCodexChildTurn({
      ...delegationInput,
      nativeThreadId: "native-child-parent-continuation-rollback",
      nativeTurnId: "native-child-turn-parent-continuation-rollback",
    });
    const action = sink.recordCollaborationAction({
      actionId: "collaboration:child-return-parent-rollback",
      kind: "return-result",
      sourceThreadId: delegation.childThread.id,
      sourceTurnId: childTurn.id,
      sourceExecutionId: sink.loadExecutionIdForTurn(childTurn.id),
      sourceItemId: "item:child-return-parent-rollback",
      targetThreadId: THREAD_ID,
      status: "Dispatched",
      providerIdentities: [],
      payload: { projection: "codexCollaboration" },
    });
    published.mockClear();
    db.exec(`
      CREATE TRIGGER reject_provider_continuation_turn
      BEFORE INSERT ON canonical_agent_turns
      WHEN NEW.id = 'turn:provider-continuation-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced provider continuation failure');
      END;
    `);

    expect(() => sink.startProviderContinuation({
      parentThreadId: THREAD_ID,
      turnId: "turn:provider-continuation-rollback",
      executionId: "00000000-0000-4000-8000-000000000003",
      permissionMode: "full",
      providerIdentities: [],
      triggerActionId: action.id,
    })).toThrow("forced provider continuation failure");

    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE id = ?")
      .get("turn:provider-continuation-rollback")).toEqual({ count: 0 });
    expect(sink.loadCollaborationAction(action.id)?.target).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(sink.loadCollaborationAction(action.id)?.status).toBe("Dispatched");
    expect(published).not.toHaveBeenCalled();
  });

  it("retains a bounded diagnostic when attributed child routing cannot persist", () => {
    startCanonicalParent(sink, db);
    sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-diagnostic",
      providerIdentities: [],
    });

    sink.recordCodexChildRoutingDiagnostic({
      threadId: THREAD_ID,
      parentItemId: "toolCall:spawn-diagnostic",
      executionId: EXECUTION_ID,
      event: { type: "toolUse", toolCallId: "child-tool" },
      reason: "identity conflict",
    });

    expect(sink.exportTurnDiagnostics(TURN_ID).entries).toContainEqual(
      expect.objectContaining({
        source: "provider",
        eventType: "codex-child-routing-failure",
      }),
    );
    const failureRows = db.prepare(`
      SELECT kind, payload_json
      FROM canonical_agent_items
      WHERE thread_id = ? AND kind = 'error'
    `).all(THREAD_ID) as Array<{ kind: string; payload_json: string }>;
    expect(failureRows).toHaveLength(1);
    expect(JSON.parse(failureRows[0]!.payload_json)).toMatchObject({
      projection: "codexChildRoutingFailure",
      status: "action-required",
      recovery: "retry-child-routing",
      reason: "identity conflict",
    });
  });

  it("updates one child assistant item as streamed content grows", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-stream",
      receiverThreadIds: ["native-child-stream"],
      prompt: "stream child output",
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(input);
    sink.startCodexChildTurn({ ...input, nativeThreadId: "native-child-stream", nativeTurnId: "native-turn-stream" });
    const first = sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-stream",
      nativeItemId: "native-message-stream",
      eventKey: "stream",
      kind: "message",
      payload: { projection: "message", content: "A" },
    });
    const second = sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-stream",
      nativeItemId: "native-message-stream",
      eventKey: "stream",
      kind: "message",
      payload: { projection: "message", content: "A" },
    });

    expect(second.id).toBe(first.id);
    expect(sink.loadItem(first.id)?.payload).toMatchObject({
      projection: "message",
      message: { content: "AA" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE thread_id = ? AND kind = 'message'")
      .get(delegation.childThread.id)).toEqual({ count: 2 });

    const completed = sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-stream",
      nativeItemId: "native-message-stream",
      eventKey: "stream-complete",
      kind: "message",
      payload: { projection: "message", content: "AA" },
    });

    expect(completed.id).toBe(first.id);
    expect(sink.loadItem(first.id)?.payload).toMatchObject({
      projection: "message",
      message: { content: "AA" },
    });

    sink.finishCodexChildTurn({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-stream",
      outcome: "completed",
    });
    const lateReplay = sink.recordCodexChildItem({
      childThreadId: delegation.childThread.id,
      nativeTurnId: "native-turn-stream",
      nativeItemId: "native-message-stream",
      eventKey: "stream",
      kind: "message",
      payload: { projection: "message", content: " Late replay." },
    });

    expect(lateReplay.id).toBe(first.id);
    expect(sink.loadItem(first.id)?.payload).toMatchObject({
      message: { content: "AA" },
    });
  });

  it("persists repeated child text deltas through the Codex adapter into one canonical item", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-adapter-stream",
      receiverThreadIds: ["native-child-adapter-stream"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const delegation = sink.startCodexChildDelegation(input);
    sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-child-adapter-stream",
      nativeTurnId: "native-turn-adapter-stream",
    });
    const durability = {
      loadCodexChildDelegationByReceiverThreadId: () => delegation,
      loadThread: (threadId: string) => sink.loadThread(threadId),
      loadTurn: (turnId: string) => sink.loadTurn(turnId),
      loadTurnByExecution: (executionId: string) => sink.loadTurnByExecution(executionId),
      loadExecutionIdForTurn: () => EXECUTION_ID,
      registerCodexReceiverThreadIds: (value: Parameters<typeof sink.registerCodexReceiverThreadIds>[0]) => (
        sink.registerCodexReceiverThreadIds(value)
      ),
      bindCodexChildIdentity: (value: Parameters<typeof sink.bindCodexChildIdentity>[0]) => (
        sink.bindCodexChildIdentity(value)
      ),
      recordCodexChildItem: (value: Parameters<typeof sink.recordCodexChildItem>[0]) => (
        sink.recordCodexChildItem(value)
      ),
    } as CodexCollaborationDurability;
    const adapter = new CodexCollaborationEventAdapter(durability);
    const extension: ProviderRuntimeExtension = {
      providerId: "codex",
      kind: "codex-collaboration",
      child: {
        nativeThreadId: "native-child-adapter-stream",
        nativeTurnId: "native-turn-adapter-stream",
        nativeItemId: "native-message-adapter-stream",
        itemEventKey: "stream",
        parentCollaborationItemId: "spawn-adapter-stream",
      },
    };
    for (const delta of ["A", "A"]) {
      expect(adapter.project({
        providerId: "codex",
        sourceKind: "provider-runtime",
        event: {
          type: AgentEventType.TextDelta,
          threadId: THREAD_ID,
          turnExecutionId: EXECUTION_ID,
          delta,
        },
        runtimeExtension: extension,
      })).toEqual({ status: "consumed" });
    }

    const childMessages = db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE thread_id = ? AND kind = 'message'
      ORDER BY created_at, id
    `).all(delegation.childThread.id) as Array<{ payload_json: string }>;
    expect(childMessages).toHaveLength(1);
    expect(JSON.parse(childMessages.at(-1)!.payload_json)).toMatchObject({
      projection: "message",
      message: { content: "AA" },
    });
  });

  it("keeps child content under one child turn and restores it in a fresh sink", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-content",
      receiverThreadIds: ["native-child-content"],
      prompt: "secret-child-prompt",
      providerIdentities: [] as ProviderIdentity[],
    };
    const provisional = sink.startCodexChildDelegation(input);
    const childTurn = sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-child-content",
      nativeTurnId: "native-turn-content",
    });
    expect(childTurn.status).toBe("Running");
    expect(sink.loadCodexChildDelegation(THREAD_ID, input.parentItemId)?.collaborationAction).toMatchObject({
      status: "Acknowledged",
      target: { threadId: provisional.childThread.id, turnId: childTurn.id },
    });

    const childItem = sink.recordCodexChildItem({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-content",
      nativeItemId: "native-message-1",
      eventKey: "completed",
      kind: "message",
      payload: { projection: "message", content: "child-only output" },
    });
    expect(sink.loadItem(childItem.id)?.threadId).toBe(provisional.childThread.id);
    expect(sink.recordCodexChildItem({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-content",
      nativeItemId: "native-message-1",
      eventKey: "completed",
      kind: "message",
      payload: { projection: "message", content: "child-only output" },
    }).id).toBe(childItem.id);
    expect(() => sink.recordCodexChildItem({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-content",
      nativeItemId: "native-message-1",
      eventKey: "completed",
      kind: "message",
      payload: { projection: "message", content: "conflicting output" },
    })).toThrow("item identity conflict");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE thread_id = ?")
      .get(THREAD_ID)).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_items
      WHERE thread_id = ? AND json_extract(payload_json, '$.projection') = 'codexSubagent'
    `).get(THREAD_ID)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE thread_id = ?")
      .get(provisional.childThread.id)).toEqual({ count: 2 });

    const finished = sink.finishCodexChildTurn({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-content",
      outcome: "completed",
    });
    expect(finished.status).toBe("Completed");
    expect(sink.finishCodexChildTurn({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-content",
      outcome: "errored",
    })).toMatchObject({ status: "Completed" });

    const restored = new CanonicalAgentEventSink(db, vi.fn());
    const recovered = restored.loadCodexChildDelegation(THREAD_ID, input.parentItemId);
    expect(recovered).toMatchObject({
      childThread: {
        id: provisional.childThread.id,
        parentThreadId: THREAD_ID,
        providerIdentities: [{
          providerId: "codex",
          scope: "thread",
          value: "native-child-content",
          provenance: "native",
        }],
      },
      collaborationAction: {
        status: "Acknowledged",
        message: "secret-child-prompt",
        target: { threadId: provisional.childThread.id, turnId: childTurn.id },
      },
    });
    expect(restored.loadTurn(childTurn.id)).toMatchObject({ status: "Completed" });
    expect(restored.loadItem(childItem.id)).toMatchObject({
      threadId: provisional.childThread.id,
      payload: { content: "child-only output" },
    });
    const restoredChildRows = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(provisional.childThread.id) as Array<{ payload_json: string }>;
    expect(JSON.stringify(restoredChildRows)).toContain("secret-child-prompt");
    expect(JSON.stringify(db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(THREAD_ID))).not.toContain("secret-child-prompt");
    const childRecovery = restored.recoverThread(provisional.childThread.id, {
      conversationRevision: 0,
      rosterRevision: 0,
    });
    expect(childRecovery.mode === "snapshot" ? childRecovery.snapshot.state.collaborationActions : {})
      .toHaveProperty(recovered!.collaborationAction.id);
  });

  it("commits child start and parent action target atomically", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-atomic",
      receiverThreadIds: ["native-child-atomic"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const provisional = sink.startCodexChildDelegation(input);
    sink.bindCodexChildIdentity({ ...input, nativeThreadId: "native-child-atomic" });
    published.mockClear();
    db.exec(`
      CREATE TRIGGER reject_child_action_target
      BEFORE UPDATE ON canonical_collaboration_actions
      WHEN NEW.target_turn_id IS NOT NULL AND OLD.target_turn_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced child action failure');
      END;
    `);

    expect(() => sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-child-atomic",
      nativeTurnId: "native-turn-atomic",
    })).toThrow("forced child action failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE thread_id = ?")
      .get(provisional.childThread.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT target_turn_id FROM canonical_collaboration_actions WHERE id = ?")
      .get(provisional.collaborationAction.id)).toEqual({ target_turn_id: null });
    expect(published).not.toHaveBeenCalled();
  });

  it("publishes child and parent events on their own channels after atomic child start", () => {
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-publication",
      receiverThreadIds: ["native-child-publication"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const provisional = sink.startCodexChildDelegation(input);
    sink.bindCodexChildIdentity({ ...input, nativeThreadId: "native-child-publication" });
    published.mockClear();

    const childTurn = sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-child-publication",
      nativeTurnId: "native-turn-publication",
    });

    expect(childTurn.status).toBe("Running");
    expect(published).toHaveBeenCalledTimes(2);
    expect(published.mock.calls[0]![0].every((event) => (
      event.routing.threadId === provisional.childThread.id
    ))).toBe(true);
    expect(published.mock.calls[1]![0].every((event) => (
      event.routing.threadId === THREAD_ID
    ))).toBe(true);
    expect(published.mock.calls.flatMap(([events]) => events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routing: expect.objectContaining({ threadId: provisional.childThread.id }),
          payload: expect.objectContaining({
            type: "turn.created",
            turn: expect.objectContaining({ id: childTurn.id }),
          }),
        }),
        expect.objectContaining({
          routing: expect.objectContaining({ threadId: THREAD_ID }),
          payload: expect.objectContaining({ type: "collaboration-action.recorded" }),
        }),
      ]),
    );
  });

  it("keeps child tool content out of the finalized parent projection", () => {
    const messageRepo = new MessageRepo(db);
    startCanonicalParent(sink, db);
    const input = {
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-ownership",
      receiverThreadIds: ["native-child-ownership"],
      providerIdentities: [] as ProviderIdentity[],
    };
    const provisional = sink.startCodexChildDelegation(input);
    const childTurn = sink.startCodexChildTurn({
      ...input,
      nativeThreadId: "native-child-ownership",
      nativeTurnId: "native-turn-ownership",
    });
    sink.recordCodexChildItem({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-ownership",
      nativeItemId: "native-tool-ownership",
      eventKey: "started",
      kind: "tool-call",
      payload: { projection: "codexChildToolCall", toolName: "Read", input: "secret-child-input" },
    });
    sink.recordCodexChildItem({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-ownership",
      nativeItemId: "native-tool-ownership",
      eventKey: "completed",
      kind: "tool-result",
      payload: { projection: "codexChildToolResult", output: "secret-child-output", isError: false },
    });
    sink.recordCodexChildItem({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-ownership",
      nativeItemId: "native-message-ownership",
      eventKey: "completed",
      kind: "message",
      payload: { projection: "message", content: "secret-child-message" },
    });
    sink.finishCodexChildTurn({
      childThreadId: provisional.childThread.id,
      nativeTurnId: "native-turn-ownership",
      outcome: "completed",
    });
    const parentMessage = messageRepo.create(THREAD_ID, "assistant", "parent answer", 2);
    sink.finishParentTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
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
            record: ({
              id: "spawn-ownership",
              message_id: parentMessage.id,
              parent_tool_call_id: null,
              tool_name: "Agent",
              tool_input: { codexCollabKind: "spawnAgent" },
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
            } as never),
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 1,
            record: {
              id: "native-tool-ownership",
              message_id: parentMessage.id,
              parent_tool_call_id: "spawn-ownership",
              tool_name: "Read",
              input_summary: "secret-child-input",
              output_summary: "secret-child-output",
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
              sort_order: 1,
            },
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 2,
            record: {
              id: "nested-tool-ownership",
              message_id: parentMessage.id,
              parent_tool_call_id: "native-tool-ownership",
              tool_name: "Write",
              input_summary: "nested-child-input",
              output_summary: "nested-child-output",
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
              sort_order: 2,
            },
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 3,
            record: {
              id: "parallel-coordinator",
              message_id: parentMessage.id,
              parent_tool_call_id: null,
              tool_name: "Read",
              input_summary: "parallel-input",
              output_summary: "parallel-output",
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
              sort_order: 3,
            },
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 4,
            record: {
              id: "parallel-coordinator-child",
              message_id: parentMessage.id,
              parent_tool_call_id: "parallel-coordinator",
              tool_name: "Read",
              input_summary: "parallel-child-input",
              output_summary: "parallel-child-output",
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
              sort_order: 4,
            },
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 5,
            record: {
              id: "cycle-spawn",
              message_id: parentMessage.id,
              parent_tool_call_id: "cycle-b",
              tool_name: "Agent",
              tool_input: { codexCollabKind: "spawnAgent" },
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
              sort_order: 5,
            } as never,
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 6,
            record: {
              id: "cycle-a",
              message_id: parentMessage.id,
              parent_tool_call_id: "cycle-spawn",
              tool_name: "Read",
              input_summary: "cycle-a-input",
              output_summary: "cycle-a-output",
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
              sort_order: 6,
            },
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 7,
            record: {
              id: "cycle-b",
              message_id: parentMessage.id,
              parent_tool_call_id: "cycle-a",
              tool_name: "Read",
              input_summary: "cycle-b-input",
              output_summary: "cycle-b-output",
              started_at: NOW,
              completed_at: NOW,
              status: "completed",
              sort_order: 7,
            },
          },
          {
            kind: "narrationSegment",
            sequence: 2,
            sortOrder: 8,
            record: {
              id: "parent-narration-ownership",
              message_id: parentMessage.id,
              text: "parent-only narration",
              started_at: NOW,
              ended_at: NOW,
              sort_order: 8,
            },
          },
          {
            kind: "hook",
            sequence: 2,
            sortOrder: 9,
            record: {
              id: "parent-hook-ownership",
              message_id: parentMessage.id,
              hook_name: "PostToolUse",
              tool_name: "Read",
              phase: "post",
              payload: "parent-only hook",
              duration_ms: 1,
              did_block: false,
              started_at: NOW,
              ended_at: NOW,
              sort_order: 9,
            },
          },
        ],
      }),
    });

    const parentRows = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(THREAD_ID) as Array<{ payload_json: string }>;
    expect(JSON.stringify(parentRows)).not.toContain("secret-child");
    const parentItemIds = (db.prepare(
      "SELECT id FROM canonical_agent_items WHERE thread_id = ? ORDER BY id",
    ).all(THREAD_ID) as Array<{ id: string }>).map((row) => row.id);
    expect(parentItemIds).toEqual(expect.arrayContaining([
      "toolCall:parallel-coordinator",
      "toolCall:parallel-coordinator-child",
      "narrationSegment:parent-narration-ownership",
      "hook:parent-hook-ownership",
    ]));
    expect(parentItemIds).not.toEqual(expect.arrayContaining([
      "toolCall:native-tool-ownership",
      "toolCall:nested-tool-ownership",
      "toolCall:cycle-spawn",
      "toolCall:cycle-a",
      "toolCall:cycle-b",
    ]));
    expect(sink.loadItem(`message:${parentMessage.id}`)?.payload).toMatchObject({
      projection: "message",
    });
    const childRows = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(provisional.childThread.id) as Array<{ payload_json: string }>;
    expect(JSON.stringify(childRows)).toContain("secret-child-output");
    expect(JSON.stringify(childRows)).toContain("secret-child-message");
    expect(sink.loadTurn(childTurn.id)).toMatchObject({ status: "Completed" });
  });

  it("hides the compatibility child from normal thread listings", () => {
    startCanonicalParent(sink, db);
    const delegation = sink.startCodexChildDelegation({
      parentThreadId: THREAD_ID,
      parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID,
      parentItemId: "toolCall:spawn-hidden",
      providerIdentities: [],
    });
    const threadRepo = new ThreadRepo(db);
    expect(threadRepo.findById(delegation.childThread.id)?.id).toBe(delegation.childThread.id);
    expect(threadRepo.listByWorkspace("workspace-1").map((thread) => thread.id))
      .not.toContain(delegation.childThread.id);
    expect(threadRepo.listRecent(100).map((thread) => thread.id))
      .not.toContain(delegation.childThread.id);
    expect(threadRepo.search({ query: "Sub-agent" }).threads.map((thread) => thread.id))
      .not.toContain(delegation.childThread.id);
    expect(threadRepo.countActiveByWorkspaceIds(["workspace-1"]).get("workspace-1"))
      .toBe(1);
    expect(db.prepare("SELECT deleted_at FROM threads WHERE id = ?")
      .get(delegation.childThread.id)).toMatchObject({ deleted_at: null });
  });
});
