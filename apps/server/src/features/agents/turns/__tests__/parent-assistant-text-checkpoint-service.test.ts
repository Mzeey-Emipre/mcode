import "reflect-metadata";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { CanonicalAgentEventSink } from "../../canonical/canonical-agent-event-sink.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import {
  ParentAssistantTextCheckpointQueue,
  ParentAssistantTextCheckpointService,
  type ParentAssistantTextCheckpointQueueScheduler,
} from "../parent-assistant-text-checkpoint-service.js";

const EXECUTION_ID = "00000000-0000-4000-8000-000000001522";
const THREAD_ID = "thread-1522";
const TURN_ID = "turn-1522";
const NOW = "2026-08-24T10:00:00.000Z";

function input(sequence: number, text: string) {
  return { executionId: EXECUTION_ID, threadId: THREAD_ID, turnId: TURN_ID, sequence, text };
}

function seedParentAssistantTurn(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("workspace-1522", "Workspace", "C:/workspace", NOW, NOW);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(THREAD_ID, "workspace-1522", "Durability", "main", "claude", "active", NOW, NOW);
  const messages = new MessageRepo(db);
  new CanonicalAgentEventSink(db, () => {}).startParentTurn({
    thread: { id: THREAD_ID, workspaceId: "workspace-1522", providerId: "claude", createdAt: NOW },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "full",
    providerIdentities: [],
    projectUserMessage: () => messages.create(THREAD_ID, "user", "start", 1),
  });
}

describe("ParentAssistantTextCheckpointService", () => {
  let db: Database.Database;
  let service: ParentAssistantTextCheckpointService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedParentAssistantTurn(db);
    service = new ParentAssistantTextCheckpointService(db);
  });

  afterEach(() => db.close());

  it("stores adjacent deltas as one chunk and restores their accepted order", () => {
    expect(service.appendChunk([input(1, "first "), input(2, "second")])).toMatchObject({
      outcome: "committed",
      durableThrough: 2,
      committedItems: 2,
      committedBytes: 12,
    });

    expect(service.restore(EXECUTION_ID)).toBe("first second");
    expect(db.prepare(
      "SELECT first_sequence, last_sequence, text, byte_length FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?",
    ).all(EXECUTION_ID)).toEqual([{
      first_sequence: 1,
      last_sequence: 2,
      text: "first second",
      byte_length: 12,
    }]);
  });

  it("accepts an exact chunk retry but rejects conflicting text and sequence gaps", () => {
    service.appendChunk([input(1, "same")]);

    expect(service.appendChunk([input(1, "same")])).toMatchObject({
      outcome: "duplicate",
      durableThrough: 1,
    });
    expect(() => service.appendChunk([input(1, "changed")])).toThrow(/conflicts/);
    expect(() => service.appendChunk([input(3, "gap")])).toThrow(/expected 2, received 3/);
    expect(service.restore(EXECUTION_ID)).toBe("same");
  });

  it("stops before retained byte or chunk limits are exceeded", () => {
    const byteLimited = new ParentAssistantTextCheckpointService(db, { maxBytes: 4, maxChunks: 4 });
    expect(byteLimited.appendChunk([input(1, "12345")])).toMatchObject({ outcome: "overflow" });
    expect(byteLimited.restore(EXECUTION_ID)).toBe("");

    const chunkLimited = new ParentAssistantTextCheckpointService(db, { maxBytes: 100, maxChunks: 1 });
    expect(chunkLimited.appendChunk([input(1, "one")])).toMatchObject({ outcome: "committed" });
    expect(chunkLimited.appendChunk([input(2, "two")])).toMatchObject({ outcome: "overflow" });
    expect(chunkLimited.restore(EXECUTION_ID)).toBe("one");
  });

  it("resets unfinished text and retires text only after a canonical terminal outcome", () => {
    service.appendChunk([input(1, "retry me")]);
    expect(service.retire(EXECUTION_ID)).toBe(false);
    expect(service.restore(EXECUTION_ID)).toBe("retry me");
    expect(service.reset(EXECUTION_ID)).toBe(true);
    expect(service.restore(EXECUTION_ID)).toBe("");

    service.appendChunk([input(1, "finished")]);
    db.prepare(`
      UPDATE canonical_agent_ingest_checkpoints
      SET terminal_outcome = 'completed'
      WHERE execution_id = ?
    `).run(EXECUTION_ID);
    expect(service.reset(EXECUTION_ID)).toBe(false);
    expect(service.retire(EXECUTION_ID)).toBe(true);
    expect(service.restore(EXECUTION_ID)).toBe("");
  });

  it("resets an unfinished retry even when its checkpoint rows are already absent", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-retry-"));
    const retryService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const recovered = [];
    try {
      retryService.recoveryJournal.append([input(1, "journaled")]);

      expect(retryService.resetForRetry(EXECUTION_ID)).toBe(true);
      retryService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));

      expect(recovered).toEqual([]);
      expect(retryService.restore(EXECUTION_ID)).toBe("");
    } finally {
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("removes a recovery journal after its equivalent canonical projection commits", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-retire-"));
    const journalService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const recovered = [];
    try {
      journalService.recoveryJournal.append([input(1, "journaled")]);
      journalService.discardRecoveryJournal(EXECUTION_ID);

      journalService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));
      expect(recovered).toEqual([]);
    } finally {
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("removes journal-only provisional text after the canonical execution is terminal", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-terminal-journal-"));
    const journalService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const recovered = [];
    try {
      journalService.recoveryJournal.append([input(1, "journaled")]);
      db.prepare(`
        UPDATE canonical_agent_ingest_checkpoints
        SET terminal_outcome = 'completed'
        WHERE execution_id = ?
      `).run(EXECUTION_ID);

      expect(journalService.retire(EXECUTION_ID)).toBe(true);
      journalService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));

      expect(recovered).toEqual([]);
    } finally {
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a recovery journal when SQLite has no retained capacity for its next chunk", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-overflow-"));
    const journalService = new ParentAssistantTextCheckpointService(
      db,
      { maxBytes: 4, maxChunks: 4 },
      { directory: journalDirectory },
    );
    const recovered = [];
    try {
      expect(journalService.appendChunk([input(1, "full")]).outcome).toBe("committed");
      journalService.recoveryJournal.append([input(2, "tail")]);

      expect(() => journalService.importRecoveryJournals())
        .toThrow("Assistant text recovery journal exceeds the retained checkpoint capacity");
      expect(journalService.restore(EXECUTION_ID)).toBe("full");

      journalService.recoveryJournal.drain(EXECUTION_ID, (record) => recovered.push(record));
      expect(recovered).toEqual([
        expect.objectContaining({ firstSequence: 2, lastSequence: 2, text: "tail" }),
      ]);
    } finally {
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("keeps an incomplete journal tail for later recovery instead of unlinking it", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-incomplete-"));
    const journalService = new ParentAssistantTextCheckpointService(db, undefined, { directory: journalDirectory });
    const journalPath = join(journalDirectory, `${EXECUTION_ID}.journal`);
    try {
      writeFileSync(journalPath, "{\"version\":1", "utf8");

      expect(() => journalService.recoveryJournal.drain(EXECUTION_ID, expect.unreachable))
        .toThrow("Assistant text recovery journal has an incomplete final record");
      expect(existsSync(journalPath)).toBe(true);
    } finally {
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("does not disable journaling when a persistent database path cannot be resolved", () => {
    const persistentDatabase = {
      name: "",
    } as unknown as Database.Database;

    expect(() => new ParentAssistantTextCheckpointService(persistentDatabase))
      .toThrow("Assistant text recovery journal database path is unavailable");
  });
});

describe("ParentAssistantTextCheckpointQueue", () => {
  function scheduler() {
    let now = 0;
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    const seam: ParentAssistantTextCheckpointQueueScheduler = {
      now: () => now,
      schedule: (callback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancel: (handle) => callbacks.delete(handle as number),
    };
    return {
      seam,
      advance(ms: number) {
        now += ms;
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback();
      },
      pending: () => callbacks.size,
    };
  }

  it("flushes by size and publishes original events after one commit", () => {
    const order: string[] = [];
    const commits: string[][] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: (entries) => {
        commits.push(entries.map((entry) => entry.text));
        order.push("commit");
        return { outcome: "committed", durableThrough: 2, committedItems: 2, committedBytes: 5 };
      },
    }, { maxChunkBytes: 5, maxQueuedEvents: 4, maxAgeMs: 250 }, clock.seam);

    queue.enqueue({ input: input(1, "ab"), publish: () => order.push("publish-1"), fail: expect.unreachable });
    expect(clock.pending()).toBe(1);
    queue.enqueue({ input: input(2, "cde"), publish: () => order.push("publish-2"), fail: expect.unreachable });

    expect(commits).toEqual([["ab", "cde"]]);
    expect(order).toEqual(["commit", "publish-1", "publish-2"]);
    expect(clock.pending()).toBe(0);
  });

  it("commits one delta larger than the size trigger without splitting its text", () => {
    const committed: string[] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: (entries) => {
        committed.push(entries[0]!.text);
        return { outcome: "committed", durableThrough: 1, committedItems: 1, committedBytes: 6 };
      },
    }, { maxChunkBytes: 4, maxQueuedEvents: 4, maxAgeMs: 250 }, clock.seam);

    expect(queue.enqueue({ input: input(1, "larger"), publish: () => {}, fail: expect.unreachable }))
      .toBe(true);
    expect(committed).toEqual(["larger"]);
  });

  it("uses the maximum age as a backstop only while text is pending", () => {
    const published: string[] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: () => ({
        outcome: "committed",
        durableThrough: 1,
        committedItems: 1,
        committedBytes: 4,
      }),
    }, { maxChunkBytes: 32, maxQueuedEvents: 4, maxAgeMs: 250 }, clock.seam);

    queue.enqueue({ input: input(1, "slow"), publish: () => published.push("slow"), fail: expect.unreachable });
    expect(published).toEqual([]);
    clock.advance(250);
    expect(published).toEqual(["slow"]);
    expect(clock.pending()).toBe(0);
  });

  it("does not publish when durable storage reaches its bound", () => {
    const published: string[] = [];
    const failures: string[] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: () => ({
        outcome: "overflow",
        durableThrough: 0,
        committedItems: 0,
        committedBytes: 0,
      }),
    }, { maxChunkBytes: 32, maxQueuedEvents: 4, maxAgeMs: 250 }, clock.seam);

    queue.enqueue({
      input: input(1, "blocked"),
      publish: () => published.push("blocked"),
      fail: (reason) => failures.push(reason),
    });
    expect(queue.flush(EXECUTION_ID)).toBe(false);
    expect(published).toEqual([]);
    expect(failures).toEqual(["Parent assistant text recovery capacity reached"]);
  });

  it("publishes after a fsynced journal record and imports that record when SQLite recovers", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-"));
    const journalDb = openMemoryDatabase();
    seedParentAssistantTurn(journalDb);
    const journalService = new ParentAssistantTextCheckpointService(journalDb, undefined, { directory: journalDirectory });
    const appendChunk = vi.spyOn(journalService, "appendChunk")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      });
    const published: string[] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue(
      journalService,
      { maxChunkBytes: 32, maxQueuedEvents: 4, maxAgeMs: 250 },
      clock.seam,
    );

    try {
      queue.enqueue({ input: input(1, "first "), publish: () => published.push("first "), fail: expect.unreachable });
      expect(queue.flush(EXECUTION_ID)).toBe(true);
      expect(published).toEqual(["first "]);
      expect(journalService.restore(EXECUTION_ID)).toBe("");

      clock.advance(250);
      expect(journalService.restore(EXECUTION_ID)).toBe("first ");

      queue.enqueue({ input: input(2, "second"), publish: () => published.push("second"), fail: expect.unreachable });
      expect(queue.flush(EXECUTION_ID)).toBe(true);

      expect(appendChunk).toHaveBeenCalledTimes(2);
      expect(published).toEqual(["first ", "second"]);
      expect(journalService.restore(EXECUTION_ID)).toBe("first second");
      expect(journalService.recoveryJournal.drain(EXECUTION_ID, () => expect.unreachable())).toBe(true);
    } finally {
      journalDb.close();
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("stops safely when the final persistence check cannot import the journal", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-finalize-"));
    const journalDb = openMemoryDatabase();
    seedParentAssistantTurn(journalDb);
    const journalService = new ParentAssistantTextCheckpointService(journalDb, undefined, { directory: journalDirectory });
    vi.spyOn(journalService, "appendChunk").mockImplementation(() => {
      throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
    });
    vi.spyOn(journalService, "appendRecoveredChunk").mockImplementation(() => {
      throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
    });
    const published: string[] = [];
    const failures: string[] = [];
    const queue = new ParentAssistantTextCheckpointQueue(
      journalService,
      { maxChunkBytes: 32, maxQueuedEvents: 4, maxAgeMs: 250 },
      scheduler().seam,
    );

    try {
      queue.enqueue({
        input: input(1, "journaled"),
        publish: () => published.push("journaled"),
        fail: (reason) => failures.push(reason),
      });
      expect(queue.flush(EXECUTION_ID)).toBe(true);
      expect(published).toEqual(["journaled"]);
      expect(queue.finish(EXECUTION_ID)).toBe(false);
      expect(queue.hasStoppedForStorageFailure(EXECUTION_ID)).toBe(true);
      expect(failures).toEqual(["Assistant text recovery remained unavailable at turn finalization"]);
    } finally {
      journalDb.close();
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("holds text in bounded memory until SQLite recovers and reports the saving state", () => {
    let sqliteAvailable = false;
    const published: string[] = [];
    const modes: string[] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: () => {
        if (!sqliteAvailable) throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        return { outcome: "committed" as const, durableThrough: 1, committedItems: 1, committedBytes: 4 };
      },
    }, { maxChunkBytes: 32, maxQueuedEvents: 4, maxAgeMs: 250 }, clock.seam, {
      onDurabilityChange: ({ mode }) => modes.push(mode),
    });

    queue.enqueue({ input: input(1, "held"), publish: () => published.push("held"), fail: expect.unreachable });
    expect(queue.flush(EXECUTION_ID)).toBe(true);
    expect(published).toEqual([]);
    expect(modes).toEqual(["saving-delayed"]);
    expect(queue.prepareSemanticBoundary(THREAD_ID)).toBe(false);

    sqliteAvailable = true;
    expect(queue.prepareSemanticBoundary(THREAD_ID)).toBe(true);

    expect(published).toEqual(["held"]);
    expect(modes).toEqual(["saving-delayed", "durable"]);
  });

  it("writes held memory to the recovery journal when SQLite stays unavailable", () => {
    let journalAvailable = false;
    const journaled: string[] = [];
    const published: string[] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: () => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      },
      recoveryJournal: {
        isAvailable: () => journalAvailable,
        append: (entries) => journaled.push(...entries.map((entry) => entry.text)),
      },
    } as unknown as ParentAssistantTextCheckpointService, {
      maxChunkBytes: 32,
      maxQueuedEvents: 4,
      maxAgeMs: 250,
    }, clock.seam);

    queue.enqueue({ input: input(1, "held"), publish: () => published.push("held"), fail: expect.unreachable });
    expect(queue.flush(EXECUTION_ID)).toBe(true);
    expect(published).toEqual([]);

    journalAvailable = true;
    clock.advance(250);

    expect(journaled).toEqual(["held"]);
    expect(published).toEqual(["held"]);
    expect(queue.durabilityMode(EXECUTION_ID)).toBe("durable");
  });

  it("does not republish memory text that committed before a later retryable failure", () => {
    let sqliteAvailable = false;
    let failSecondChunkOnce = true;
    const published: string[] = [];
    const clock = scheduler();
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: (entries) => {
        if (!sqliteAvailable) throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        if (entries[0]?.text === "b" && failSecondChunkOnce) {
          failSecondChunkOnce = false;
          throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        }
        return {
          outcome: "committed" as const,
          durableThrough: entries.at(-1)!.sequence,
          committedItems: entries.length,
          committedBytes: entries.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0),
        };
      },
    }, { maxChunkBytes: 1, maxQueuedEvents: 1, maxAgeMs: 250 }, clock.seam);

    queue.enqueue({ input: input(1, "a"), publish: () => published.push("a"), fail: expect.unreachable });
    queue.enqueue({ input: input(2, "b"), publish: () => published.push("b"), fail: expect.unreachable });
    expect(published).toEqual([]);

    sqliteAvailable = true;
    clock.advance(250);
    expect(published).toEqual(["a"]);

    clock.advance(250);
    expect(published).toEqual(["a", "b"]);
  });

  it("publishes held text only after the user explicitly continues without saving", () => {
    const published: string[] = [];
    const modes: string[] = [];
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: () => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      },
    }, { maxChunkBytes: 32, maxQueuedEvents: 4, maxAgeMs: 250 }, scheduler().seam, {
      onDurabilityChange: ({ mode }) => modes.push(mode),
    });

    queue.enqueue({ input: input(1, "held"), publish: () => published.push("held"), fail: expect.unreachable });
    expect(queue.flush(EXECUTION_ID)).toBe(true);
    expect(queue.requiresDecision(EXECUTION_ID)).toBe(true);
    expect(published).toEqual([]);

    expect(queue.continueWithoutSaving(EXECUTION_ID)).toBe(true);
    expect(published).toEqual(["held"]);
    expect(modes).toEqual(["saving-delayed", "unsaved"]);
  });

  it("continues past a journal-blocked boundary only after the explicit unsaved choice", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-unsaved-"));
    const journalDb = openMemoryDatabase();
    seedParentAssistantTurn(journalDb);
    const journalService = new ParentAssistantTextCheckpointService(journalDb, undefined, { directory: journalDirectory });
    const appendJournal = journalService.recoveryJournal.append.bind(journalService.recoveryJournal);
    let journalWrites = 0;
    const published: string[] = [];
    vi.spyOn(journalService, "appendChunk").mockImplementation(() => {
      throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
    });
    vi.spyOn(journalService, "appendRecoveredChunk").mockImplementation(() => {
      throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
    });
    vi.spyOn(journalService.recoveryJournal, "append").mockImplementation((entries) => {
      journalWrites += 1;
      if (journalWrites > 1) throw Object.assign(new Error("journal unavailable"), { code: "EIO" });
      appendJournal(entries);
    });
    const queue = new ParentAssistantTextCheckpointQueue(
      journalService,
      { maxChunkBytes: 1, maxQueuedEvents: 1, maxAgeMs: 250 },
      scheduler().seam,
    );

    try {
      queue.enqueue({ input: input(1, "a"), publish: () => published.push("a"), fail: expect.unreachable });
      queue.enqueue({ input: input(2, "b"), publish: () => published.push("b"), fail: expect.unreachable });

      expect(published).toEqual(["a"]);
      expect(queue.prepareSemanticBoundary(THREAD_ID)).toBe(false);

      expect(queue.continueWithoutSaving(EXECUTION_ID)).toBe(true);
      expect(queue.prepareSemanticBoundary(THREAD_ID)).toBe(true);
      expect(published).toEqual(["a", "b"]);
    } finally {
      journalDb.close();
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the stop state after a non-recoverable journal drain failure", () => {
    const journalDirectory = mkdtempSync(join(tmpdir(), "mcode-parent-text-stop-"));
    const journalDb = openMemoryDatabase();
    seedParentAssistantTurn(journalDb);
    const journalService = new ParentAssistantTextCheckpointService(journalDb, undefined, { directory: journalDirectory });
    const appendJournal = journalService.recoveryJournal.append.bind(journalService.recoveryJournal);
    let journalWrites = 0;
    let journalCorrupt = false;
    const failures: string[] = [];
    vi.spyOn(journalService, "appendChunk").mockImplementation(() => {
      throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
    });
    vi.spyOn(journalService, "appendRecoveredChunk").mockImplementation(() => {
      if (journalCorrupt) throw new Error("journal corruption");
      throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
    });
    vi.spyOn(journalService.recoveryJournal, "append").mockImplementation((entries) => {
      journalWrites += 1;
      if (journalWrites > 1) throw Object.assign(new Error("journal unavailable"), { code: "EIO" });
      appendJournal(entries);
    });
    const queue = new ParentAssistantTextCheckpointQueue(
      journalService,
      { maxChunkBytes: 1, maxQueuedEvents: 1, maxAgeMs: 250 },
      scheduler().seam,
    );

    try {
      queue.enqueue({ input: input(1, "a"), publish: () => {}, fail: (reason) => failures.push(reason) });
      queue.enqueue({ input: input(2, "b"), publish: () => {}, fail: (reason) => failures.push(reason) });
      journalCorrupt = true;

      expect(queue.prepareSemanticBoundary(THREAD_ID)).toBe(false);
      expect(queue.durabilityMode(EXECUTION_ID)).toBe("stopping");
      expect(failures).toEqual(["journal corruption"]);
    } finally {
      journalDb.close();
      rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("stops before another unsaved chunk exceeds the bounded memory fallback", () => {
    const published: string[] = [];
    const failures: string[] = [];
    const queue = new ParentAssistantTextCheckpointQueue({
      appendChunk: () => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      },
    }, { maxChunkBytes: 32, maxQueuedEvents: 4, maxAgeMs: 250 }, scheduler().seam, {
      limits: { maxBytes: 4, maxChunks: 4 },
    });

    queue.enqueue({ input: input(1, "four"), publish: () => published.push("four"), fail: (reason) => failures.push(reason) });
    expect(queue.flush(EXECUTION_ID)).toBe(true);
    queue.enqueue({ input: input(2, "more"), publish: () => published.push("more"), fail: (reason) => failures.push(reason) });

    expect(queue.flush(EXECUTION_ID)).toBe(false);
    expect(published).toEqual([]);
    expect(failures).toEqual(["Parent assistant text recovery capacity reached"]);
  });
});
