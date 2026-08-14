import "reflect-metadata";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_AGENT_EVENT_BATCH_MAX,
  type CanonicalAgentEventEnvelope,
  MAX_TURN_RECOVERIES,
  type ProviderIdentity,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../../store/database.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../store/bounded-write-batches.js";
import {
  CANONICAL_AGENT_CONTROL_EVENT_RESERVE,
  CanonicalAgentEventSink,
  type CanonicalAgentEventDraft,
} from "../canonical-agent-event-sink.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-09T20:00:00.000Z";

function seedThread(db: Database.Database): void {
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
  db: Database.Database,
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

describe("CanonicalAgentEventSink", () => {
  let db: Database.Database;
  let published: ReturnType<typeof vi.fn<(events: readonly CanonicalAgentEventEnvelope[]) => void>>;
  let sink: CanonicalAgentEventSink;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    published = vi.fn();
    sink = new CanonicalAgentEventSink(db, published);
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

  it("returns only retained contiguous canonical deltas after known revisions", () => {
    sink.commit({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: initialDrafts(),
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
    (db as unknown as { prepare: Database.Database["prepare"] }).prepare = ((sql: string) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    }) as Database.Database["prepare"];
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
      terminalOutcome: "cancelled",
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

  it("resumes bounded terminal batches without gaps and confirms visibility last", async () => {
    const messageRepo = new MessageRepo(db);
    let interruptPublication = false;
    let interrupted = false;
    const batches: number[] = [];
    sink = new CanonicalAgentEventSink(db, (events) => {
      batches.push(events.length);
      if (interruptPublication && !interrupted) {
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
    const input = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed" as const,
      projectTurn: () => ({ message: { ...message, is_internal: false }, narrative }),
      finalizeCompatibility: () => messageRepo.publishAssistant(message.id),
    };

    await expect(sink.finishParentTurnBatched(input)).rejects.toThrow("simulated interruption");
    expect(sink.loadCheckpoint(EXECUTION_ID)?.terminalOutcome).toBeNull();
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toHaveLength(1);
    expect(sink.loadConversationProjection(THREAD_ID, 10).messages).toHaveLength(1);

    const result = await sink.finishParentTurnBatched(input);

    expect(result.outcome).toBe("committed");
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({
      terminalOutcome: "completed",
      lastAcceptedSequence: 106,
      lastDurableSequence: 106,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 106 });
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toHaveLength(2);
    expect(sink.loadConversationProjection(THREAD_ID, 10).messages).toHaveLength(2);
    const maximumItemEventsPerBatch = Math.floor(
      (ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 3) / 2,
    );
    expect(Math.max(...batches)).toBeLessThanOrEqual(maximumItemEventsPerBatch);
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

    expect(late).toMatchObject({ outcome: "terminal-outcome-confirmed", conversationRevision: 2 });
    expect(sink.loadTurn(TURN_ID)).toMatchObject({ status: "Completed" });
    expect(sink.loadCheckpoint(EXECUTION_ID)).toMatchObject({ terminalOutcome: "completed" });
    expect(published).not.toHaveBeenCalled();
  });

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
});
