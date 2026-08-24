import "reflect-metadata";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("ParentAssistantTextCheckpointService", () => {
  let db: Database.Database;
  let service: ParentAssistantTextCheckpointService;

  beforeEach(() => {
    db = openMemoryDatabase();
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
});
