import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../store/database";
import { MessageRepo } from "../../repositories/message-repo";
import { ToolCallRecordRepo } from "../../repositories/tool-call-record-repo";
import { ThoughtSegmentRepo } from "../../repositories/thought-segment-repo";
import { HookExecutionRepo } from "../../repositories/hook-execution-repo";
import { NarrativeStore } from "../narrative-store";
import { TurnFinalizer, deriveTurnAssistantMessageId } from "../turn-finalizer";
import type { ThreadRepo } from "../../repositories/thread-repo";
import type { SnapshotService } from "../snapshot-service";
import type { TurnSnapshotRepo } from "../../repositories/turn-snapshot-repo";
import type { TurnOutcome } from "../turn-outcome";
import { broadcast } from "../../transport/push";

vi.mock("../../transport/push.js", () => ({ broadcast: vi.fn() }));

const THREAD = "thread-1";
const IDEMPOTENT_SQL =
  "UPDATE threads SET has_file_changes = 1 WHERE id = ? AND has_file_changes = 0";

/** Seed a workspace + thread so message/record foreign keys are satisfied. */
function seedThread(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(THREAD, "ws-1", "Test thread", "main", now, now);
}

function insertMessage(
  db: Database.Database,
  id: string,
  role: string,
  content: string,
  sequence: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, THREAD, role, content, now, sequence);
}

/**
 * Real-DB harness: the finalize seam exercised end to end over an in-memory
 * SQLite database so the persisted tool-call statuses can be read back. No git
 * ref is recorded, so the snapshot step is skipped (covered separately below).
 */
describe("TurnFinalizer.finalize — turn outcome → tool-call status", () => {
  let db: Database.Database;
  let toolRepo: ToolCallRecordRepo;
  let narrativeStore: NarrativeStore;
  let finalizer: TurnFinalizer;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openMemoryDatabase();
    seedThread(db);
    const messageRepo = new MessageRepo(db);
    toolRepo = new ToolCallRecordRepo(db);
    narrativeStore = new NarrativeStore(
      messageRepo,
      toolRepo,
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
    );
    const threadRepo = {
      findById: vi.fn(() => ({ id: THREAD, model: "claude-sonnet-4-6" })),
    } as unknown as ThreadRepo;
    const snapshotService = {
      captureRef: vi.fn(),
      getFilesChanged: vi.fn(),
    } as unknown as SnapshotService;
    const turnSnapshotRepo = { create: vi.fn() } as unknown as TurnSnapshotRepo;
    finalizer = new TurnFinalizer(
      messageRepo,
      threadRepo,
      narrativeStore,
      snapshotService,
      turnSnapshotRepo,
      db,
    );
  });

  /** Seed an assistant message + one running tool call buffered for the turn. */
  function seedRunningToolCall(): void {
    insertMessage(db, "m1", "assistant", "final body", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });
  }

  const cases: Array<{ outcome: TurnOutcome; expected: string }> = [
    { outcome: "completed", expected: "completed" },
    { outcome: "errored", expected: "failed" },
    { outcome: "cancelled", expected: "cancelled" },
  ];

  for (const { outcome, expected } of cases) {
    it(`maps a still-running tool call to "${expected}" on a ${outcome} turn`, async () => {
      seedRunningToolCall();

      await finalizer.finalize(THREAD, outcome);

      const tools = toolRepo.listByMessage("m1");
      expect(tools).toHaveLength(1);
      expect(tools[0].status).toBe(expected);
    });
  }

  it("broadcasts turn.persisted against the assistant message with the tool-call count", async () => {
    seedRunningToolCall();

    await finalizer.finalize(THREAD, "completed");

    expect(broadcast).toHaveBeenCalledWith("turn.persisted", {
      threadId: THREAD,
      messageId: "m1",
      toolCallCount: 1,
      filesChanged: [],
    });
  });

  it("distinguishes a crash from a user stop on the same buffered tool call", async () => {
    // The whole point of the outcome enum: errored and cancelled no longer collapse.
    insertMessage(db, "m1", "assistant", "", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "a", toolName: "Bash", toolInput: {} });
    await finalizer.finalize(THREAD, "errored");
    expect(toolRepo.listByMessage("m1")[0].status).toBe("failed");

    // A second, independent turn that the user cancels.
    insertMessage(db, "m2", "assistant", "", 2);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "b", toolName: "Bash", toolInput: {} });
    await finalizer.finalize(THREAD, "cancelled");
    expect(toolRepo.listByMessage("m2")[0].status).toBe("cancelled");
  });

  it("materializes an assistant row for a buffered tool call when no Message event fired", async () => {
    // A turn that buffered a tool call but never emitted a provider Message
    // (interrupted before the final body). hasRecordableActivity holds on the
    // tool call, so finalize synthesizes the assistant row the tool attaches to
    // rather than discarding the turn.
    insertMessage(db, "u1", "user", "do the thing", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });

    await finalizer.finalize(THREAD, "errored");

    const { messages } = new MessageRepo(db).listByThread(THREAD, 10);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const tools = toolRepo.listByMessage(assistant!.id);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("failed");
  });

  it("leaves no assistant row and broadcasts nothing for a fully empty turn", async () => {
    // The genuine pre-turn / no-output case: no tool, body, narration, or hook.
    // hasRecordableActivity is false, so finalize writes nothing.
    insertMessage(db, "u1", "user", "do the thing", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);

    await finalizer.finalize(THREAD, "errored");

    const { messages } = new MessageRepo(db).listByThread(THREAD, 10);
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.anything());
  });

  it("clears the last-persisted message id on an empty turn so a late hook can't attach to the prior turn", async () => {
    // Turn 1 produces a body and records a persisted id late hooks attach to.
    insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    finalizer.bufferAssistantBody(THREAD, "the answer", "claude-sonnet-4-6");
    await finalizer.finalize(THREAD, "completed");
    expect(finalizer.getLastPersistedMessageId(THREAD)).toBeDefined();

    // Turn 2 is fully empty. Its finalize must drop turn 1's id so a late hook
    // for turn 2 is discarded rather than mis-attached to turn 1's message.
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    await finalizer.finalize(THREAD, "completed");

    expect(finalizer.getLastPersistedMessageId(THREAD)).toBeUndefined();
  });

  it("materializes the buffered provider body into exactly one assistant row", async () => {
    // The normal completed path: the provider body is buffered (not written on
    // the Message event), then materialized once at finalize.
    insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    const expectedId = finalizer.bufferAssistantBody(THREAD, "the final answer", "claude-sonnet-4-6");

    await finalizer.finalize(THREAD, "completed");

    const { messages } = new MessageRepo(db).listByThread(THREAD, 10);
    const assistantRows = messages.filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].id).toBe(expectedId);
    expect(assistantRows[0].content).toBe("the final answer");
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: THREAD,
      messageId: expectedId,
    }));
  });

  it("flushes interrupted streaming text into a new assistant row that tool calls attach to", async () => {
    // A user stop arrives mid-stream: streamed text accumulated but the
    // provider never emitted a Message row. The flush must create the
    // assistant row so the buffered tool call has somewhere to land.
    insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });
    finalizer.appendStreamingText(THREAD, "partial answer before stop");

    await finalizer.finalize(THREAD, "cancelled");

    const messageRepo = new MessageRepo(db);
    const { messages } = messageRepo.listByThread(THREAD, 10);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("partial answer before stop");
    const tools = toolRepo.listByMessage(assistant!.id);
    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("cancelled");
  });

  it("synthesizes the interrupted assistant row under a deterministic per-turn id", async () => {
    // The flushed row's identity must derive from the turn's anchor (the
    // preceding user message), not a fresh random id — so a replayed flush
    // collapses onto the same row.
    insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    finalizer.appendStreamingText(THREAD, "partial answer before stop");

    await finalizer.finalize(THREAD, "cancelled");

    const { messages } = new MessageRepo(db).listByThread(THREAD, 10);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.id).toBe(deriveTurnAssistantMessageId(THREAD, "u1"));
  });

  it("produces exactly one assistant row when finalize runs twice for one turn", async () => {
    // Reconnect replay: the streamed deltas are re-accumulated and finalize is
    // called a second time. Here the second flush is short-circuited by the
    // existing "last row is already assistant" guard, so it never reaches the
    // insert — this asserts the end-to-end "twice → one row" outcome. The
    // deterministic-id + INSERT OR IGNORE collapse that backs this up at the DB
    // layer is covered directly in message-repo.test.ts.
    insertMessage(db, "u1", "user", "go", 1);
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
    finalizer.appendStreamingText(THREAD, "partial answer before stop");

    await finalizer.finalize(THREAD, "cancelled");
    // A replay re-buffers the same streamed text before the second finalize.
    finalizer.appendStreamingText(THREAD, "partial answer before stop");
    await finalizer.finalize(THREAD, "cancelled");

    const { messages } = new MessageRepo(db).listByThread(THREAD, 10);
    const assistantRows = messages.filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
  });

  it("is a no-op when a finalize is already in flight (re-entrancy guard)", async () => {
    seedRunningToolCall();

    // Fire a second finalize before the first settles. The guard, held across
    // the snapshot await, must make the second call a no-op so the tool row is
    // written exactly once rather than duplicated.
    const first = finalizer.finalize(THREAD, "completed");
    const second = finalizer.finalize(THREAD, "completed");
    await Promise.all([first, second]);

    expect(toolRepo.listByMessage("m1")).toHaveLength(1);
  });
});

/**
 * TurnSubstance predicate: hasRecordableActivity decides whether a turn is
 * worth a persisted assistant row. Each contributor is exercised in isolation
 * over the real-DB harness so the buffers are seeded the same way a live turn
 * seeds them.
 */
describe("TurnFinalizer.hasRecordableActivity — TurnSubstance predicate", () => {
  let db: Database.Database;
  let narrativeStore: NarrativeStore;
  let finalizer: TurnFinalizer;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openMemoryDatabase();
    seedThread(db);
    const messageRepo = new MessageRepo(db);
    narrativeStore = new NarrativeStore(
      messageRepo,
      new ToolCallRecordRepo(db),
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
    );
    const threadRepo = {
      findById: vi.fn(() => ({ id: THREAD, model: "claude-sonnet-4-6" })),
    } as unknown as ThreadRepo;
    const snapshotService = {
      captureRef: vi.fn(),
      getFilesChanged: vi.fn(),
    } as unknown as SnapshotService;
    const turnSnapshotRepo = { create: vi.fn() } as unknown as TurnSnapshotRepo;
    finalizer = new TurnFinalizer(
      messageRepo,
      threadRepo,
      narrativeStore,
      snapshotService,
      turnSnapshotRepo,
      db,
    );
    narrativeStore.beginTurn(THREAD);
    narrativeStore.resetTurnCounters(THREAD);
  });

  it("is true when only a tool call is buffered", () => {
    narrativeStore.bufferToolCall(THREAD, { toolCallId: "tc-1", toolName: "Read", toolInput: {} });

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is true when only a non-empty assistant body is buffered", () => {
    finalizer.bufferAssistantBody(THREAD, "here is the answer", "claude-sonnet-4-6");

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is true when only a narration segment is buffered", () => {
    narrativeStore.openOrExtendThought(THREAD, "let me think about this");

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is true when only a hook is buffered", () => {
    narrativeStore.openHook(THREAD, {
      hookName: "PreToolUse",
      toolName: "Bash",
      phase: "pre",
      payload: "{}",
      sortOrder: 0,
    });

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(true);
  });

  it("is false for a fully empty turn (no tool, body, narration, or hook)", () => {
    expect(finalizer.hasRecordableActivity(THREAD)).toBe(false);
  });

  it("treats a whitespace-only assistant body as no body", () => {
    finalizer.bufferAssistantBody(THREAD, "   \n  ", null);

    expect(finalizer.hasRecordableActivity(THREAD)).toBe(false);
  });
});

/**
 * Snapshot-write seam, retargeted from the former AgentService.persistTurn
 * tests onto the public finalize interface. Uses spies on db / snapshotService
 * / turnSnapshotRepo to assert the git turn_snapshot write and the
 * has_file_changes flag update.
 */
describe("TurnFinalizer.finalize — git snapshot write", () => {
  function build(filesChanged: string[]) {
    const runSpy = vi.fn();
    const messageRepo = {
      listByThread: vi.fn(() => ({
        messages: [{ id: "msg-1", role: "assistant", sequence: 2, content: "" }],
      })),
      create: vi.fn(),
    } as unknown as MessageRepo;
    const threadRepo = { findById: vi.fn(() => ({ model: null })) } as unknown as ThreadRepo;
    const narrativeStore = {
      getBufferedToolCalls: vi.fn(() => []),
      hasBufferedNarrative: vi.fn(() => true),
      persistNarrative: vi.fn(() => ({ toolCallCount: 0 })),
      clearTurn: vi.fn(),
    } as unknown as NarrativeStore;
    const snapshotService = {
      captureRef: vi.fn(() => Promise.resolve("def222")),
      getFilesChanged: vi.fn(() => Promise.resolve(filesChanged)),
    } as unknown as SnapshotService;
    const turnSnapshotRepo = { create: vi.fn() } as unknown as TurnSnapshotRepo;
    const db = {
      transaction: vi.fn((fn: (files: string[]) => void) => fn),
      prepare: vi.fn(() => ({ run: runSpy })),
    } as unknown as Database.Database;
    const finalizer = new TurnFinalizer(
      messageRepo,
      threadRepo,
      narrativeStore,
      snapshotService,
      turnSnapshotRepo,
      db,
    );
    return { finalizer, db, turnSnapshotRepo, runSpy };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the snapshot inside a transaction when the ref changed", async () => {
    const { finalizer, db } = build([]);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");

    await finalizer.finalize(THREAD, "completed");

    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it("creates the turn snapshot row with the correct args", async () => {
    const { finalizer, turnSnapshotRepo } = build(["src/index.ts"]);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");

    await finalizer.finalize(THREAD, "completed");

    expect(turnSnapshotRepo.create).toHaveBeenCalledWith({
      messageId: "msg-1",
      threadId: THREAD,
      refBefore: "abc111",
      refAfter: "def222",
      filesChanged: ["src/index.ts"],
      worktreePath: null,
    });
  });

  it("runs the idempotent has_file_changes update when files changed", async () => {
    const { finalizer, db, runSpy } = build(["src/index.ts"]);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");

    await finalizer.finalize(THREAD, "completed");

    expect(db.prepare).toHaveBeenCalledWith(IDEMPOTENT_SQL);
    expect(runSpy).toHaveBeenCalledWith(THREAD);
  });

  it("does not touch the has_file_changes flag when nothing changed", async () => {
    const { finalizer, db } = build([]);
    finalizer.recordTurnRef(THREAD, "abc111", "/workspace");

    await finalizer.finalize(THREAD, "completed");

    expect(db.prepare).not.toHaveBeenCalled();
  });
});
