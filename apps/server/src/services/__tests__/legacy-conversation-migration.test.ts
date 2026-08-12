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
