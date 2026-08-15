import "reflect-metadata";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../store/database.js";
import { CanonicalAgentEventSink } from "../canonical-agent-event-sink.js";
import {
  LEGACY_CONVERSATION_MIGRATION_MAX_BYTES,
  LEGACY_CONVERSATION_MIGRATION_VERSION,
  LegacyConversationMigration,
} from "../legacy-conversation-migration.js";

const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "legacy-conversations",
);

function applyFixture(db: Database.Database, name: string): void {
  db.exec(readFileSync(join(fixtureDirectory, name), "utf8"));
}

describe("LegacyConversationMigration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it("migrates the versioned parent-pair fixture with native and source provenance", async () => {
    applyFixture(db, "v1-parent-pair.sql");
    const migration = new LegacyConversationMigration(db);

    const result = await migration.runToCompletion();

    expect(result).toEqual({
      processedMessages: 0,
      migratedMessages: 2,
      ambiguousMessages: 0,
      completed: true,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT status, permission_mode, provider_identities_json
      FROM canonical_agent_turns
      WHERE id = 'legacy-turn:user-v1'
    `).get()).toEqual({
      status: "Completed",
      permission_mode: "full",
      provider_identities_json: JSON.stringify([{
        providerId: "codex",
        scope: "thread",
        value: "native-thread-v1",
        provenance: "native",
      }]),
    });
    const projection = new CanonicalAgentEventSink(db, vi.fn())
      .loadConversationProjection("thread-v1", 10);
    expect(projection.messages).toEqual([
      expect.objectContaining({
        id: "user-v1",
        content: "Question",
        legacyProvenance: {
          source: "messages",
          migrationVersion: LEGACY_CONVERSATION_MIGRATION_VERSION,
          mapping: "canonical",
        },
      }),
      expect.objectContaining({ id: "assistant-v1", content: "Answer" }),
    ]);
    expect(projection.narrativeByMessage["assistant-v1"]?.thoughts).toEqual([
      expect.objectContaining({ id: "thought-v1", text: "Reasoned" }),
    ]);
  });

  it("migrates a structurally linked legacy child turn into the canonical child thread", async () => {
    // Regression: legacy migration previously filtered out every thread with a parent_thread_id,
    // losing child messages and narrative items during canonical cutover.
    applyFixture(db, "v1-child-pair.sql");
    const migration = new LegacyConversationMigration(db);

    const result = await migration.runToCompletion();

    expect(result).toMatchObject({ migratedMessages: 6, ambiguousMessages: 0, completed: true });
    expect(db.prepare(`
      SELECT parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_identities_json, activity_state
      FROM canonical_agent_threads
      WHERE id = 'thread-child-v1'
    `).get()).toEqual({
      parent_thread_id: "thread-child-parent-v1",
      root_thread_id: "thread-child-parent-v1",
      owning_parent_thread_id: "thread-child-parent-v1",
      provider_identities_json: JSON.stringify([{
        providerId: "codex",
        scope: "thread",
        value: "native-child-v1",
        provenance: "native",
      }]),
      activity_state: "Idle",
    });
    expect(db.prepare(`
      SELECT status, provider_identities_json
      FROM canonical_agent_turns
      WHERE thread_id = 'thread-child-v1'
    `).get()).toEqual({
      status: "Completed",
      provider_identities_json: JSON.stringify([{
        providerId: "codex",
        scope: "thread",
        value: "native-child-v1",
        provenance: "native",
      }]),
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_items
      WHERE thread_id = 'thread-child-v1'
    `).get()).toEqual({ count: 5 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_turns
      WHERE thread_id = 'thread-child-v1'
    `).get()).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT conversation_revision
      FROM canonical_agent_threads
      WHERE id = 'thread-child-v1'
    `).get()).toEqual({ conversation_revision: 2 });
    expect(db.prepare(`
      SELECT roster_revision
      FROM canonical_agent_threads
      WHERE id = 'thread-child-parent-v1'
    `).get()).toEqual({ roster_revision: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_items
      WHERE thread_id = 'thread-child-v1'
        AND json_extract(payload_json, '$.projection') = 'toolCall'
    `).get()).toEqual({ count: 1 });
    const restoredSink = new CanonicalAgentEventSink(db, vi.fn());
    expect(restoredSink.loadThread("thread-child-v1")).toMatchObject({
      parentThreadId: "thread-child-parent-v1",
      rootThreadId: "thread-child-parent-v1",
      providerIdentities: [{
        providerId: "codex",
        scope: "thread",
        value: "native-child-v1",
        provenance: "native",
      }],
    });
    expect(restoredSink.loadSubagentRoster({
      owningParentThreadId: "thread-child-parent-v1",
      limit: 10,
    })).toMatchObject({
      rosterRevision: 1,
      active: [],
      done: [expect.objectContaining({
        id: "thread-child-v1",
        providerIdentities: expect.arrayContaining([expect.objectContaining({
          value: "native-child-v1",
        })]),
      })],
    });
  });

  it("migrates nested children by structural depth before lexical child order", async () => {
    // Regression: lexical ordering can process a grandchild before its canonical parent.
    applyFixture(db, "v1-nested-child-pair.sql");
    const migration = new LegacyConversationMigration(db);

    const result = await migration.runToCompletion();

    expect(result).toMatchObject({ migratedMessages: 6, ambiguousMessages: 0, completed: true });
    expect(db.prepare(`
      SELECT parent_thread_id, root_thread_id, owning_parent_thread_id, conversation_revision
      FROM canonical_agent_threads
      WHERE id = 'thread-a-grandchild'
    `).get()).toEqual({
      parent_thread_id: "thread-z-child",
      root_thread_id: "thread-nested-parent",
      owning_parent_thread_id: "thread-nested-parent",
      conversation_revision: 1,
    });
  });

  it("keeps an ambiguous fixture on the legacy projection with explicit provenance", async () => {
    applyFixture(db, "v1-ambiguous.sql");
    const migration = new LegacyConversationMigration(db);

    await migration.runToCompletion();

    expect(db.prepare(`
      SELECT mapping_status, canonical_item_id, reason
      FROM canonical_legacy_message_provenance
      WHERE message_id = 'assistant-ambiguous'
    `).get()).toEqual({
      mapping_status: "ambiguous",
      canonical_item_id: null,
      reason: "The message is not part of an adjacent user and assistant pair.",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual({ count: 0 });
  });

  it("rolls back a crash before the checkpoint and resumes without duplicates", async () => {
    applyFixture(db, "v1-parent-pair.sql");
    const migration = new LegacyConversationMigration(db);

    expect(() => migration.runBatch({
      beforeCheckpoint: () => {
        throw new Error("checkpoint crash");
      },
    })).toThrow("checkpoint crash");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_legacy_message_provenance").get())
      .toEqual({ count: 0 });

    await migration.runToCompletion();
    await migration.runToCompletion();

    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_legacy_message_provenance").get())
      .toEqual({ count: 2 });
  });

  it("resumes after a crash that occurs after a durable checkpoint", async () => {
    applyFixture(db, "v1-parent-pair.sql");
    db.prepare(`
      INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
      VALUES
        ('user-v1-2', 'thread-v1', 'user', 'Second question', '2026-01-01T00:03:00.000Z', 3),
        ('assistant-v1-2', 'thread-v1', 'assistant', 'Second answer', '2026-01-01T00:04:00.000Z', 4)
    `).run();
    const migration = new LegacyConversationMigration(db);

    expect(() => migration.runBatch({
      afterCheckpoint: () => {
        throw new Error("post-checkpoint crash");
      },
    })).toThrow("post-checkpoint crash");

    const result = await migration.runToCompletion();
    expect(result).toMatchObject({ migratedMessages: 4, ambiguousMessages: 0, completed: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns").get()).toEqual({ count: 2 });
  });

  it("resumes child checkpoints before and after commit without duplicate history", async () => {
    // Regression: a crash at either side of a child checkpoint must preserve all
    // child turns and leave the repeat-safe migration cursor at one outcome.
    applyFixture(db, "v1-child-pair.sql");
    const migration = new LegacyConversationMigration(db);

    expect(() => migration.runBatch({
      beforeCheckpoint: () => {
        throw new Error("child checkpoint crash");
      },
    })).toThrow("child checkpoint crash");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual({ count: 0 });

    expect(() => migration.runBatch({
      afterCheckpoint: () => {
        throw new Error("child post-checkpoint crash");
      },
    })).toThrow("child post-checkpoint crash");

    await migration.runToCompletion();
    await migration.runToCompletion();

    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_turns
      WHERE thread_id = 'thread-child-v1'
    `).get()).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_legacy_message_provenance
      WHERE mapping_status = 'migrated'
    `).get()).toEqual({ count: 6 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_agent_items
      WHERE thread_id = 'thread-child-v1'
    `).get()).toEqual({ count: 5 });
  });

  it("leaves an oversized legacy pair readable instead of exceeding the byte bound", async () => {
    applyFixture(db, "v1-parent-pair.sql");
    db.prepare("UPDATE messages SET content = ? WHERE id = 'assistant-v1'")
      .run("x".repeat(LEGACY_CONVERSATION_MIGRATION_MAX_BYTES));
    const migration = new LegacyConversationMigration(db);

    const result = await migration.runToCompletion();

    expect(result).toMatchObject({ migratedMessages: 0, ambiguousMessages: 2, completed: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM canonical_legacy_message_provenance
      WHERE reason = ?
    `).get(`The legacy turn exceeds ${LEGACY_CONVERSATION_MIGRATION_MAX_BYTES} bytes.`))
      .toEqual({ count: 2 });
  });
});
