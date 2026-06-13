import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MessageRepo } from "../repositories/message-repo.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      files_changed TEXT,
      cost_usd REAL,
      tokens_used INTEGER,
      timestamp TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      attachments TEXT,
      reply_to_message_id TEXT,
      quoted_text TEXT,
      model TEXT,
      is_internal INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tool_call_records (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      name TEXT,
      arguments TEXT,
      result TEXT
    );
    CREATE INDEX idx_tool_call_records_message ON tool_call_records(message_id);
  `);
  return db;
}

describe("MessageRepo", () => {
  let db: Database.Database;
  let repo: MessageRepo;

  beforeEach(() => {
    db = createTestDb();
    repo = new MessageRepo(db);
  });

  describe("listByThread", () => {
    it("returns tool_call_count per message via indexed lookup", () => {
      const m1 = repo.create("thread-1", "user", "a", 1);
      const m2 = repo.create("thread-1", "assistant", "b", 2);
      db.prepare(
        "INSERT INTO tool_call_records (id, message_id, name) VALUES (?, ?, ?)",
      ).run("tc1", m2.id, "Bash");
      db.prepare(
        "INSERT INTO tool_call_records (id, message_id, name) VALUES (?, ?, ?)",
      ).run("tc2", m2.id, "Read");

      const { messages } = repo.listByThread("thread-1", 10);
      expect(messages).toHaveLength(2);
      expect(messages[0].tool_call_count).toBeUndefined();
      expect(messages[1].tool_call_count).toBe(2);
    });

    it("EXPLAIN avoids full-table scan on tool_call_records", () => {
      repo.create("thread-1", "user", "x", 1);
      const stmt = db.prepare(
        `EXPLAIN QUERY PLAN
WITH page AS (
  SELECT m.id, m.thread_id, m.role, m.content, m.tool_calls, m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence, m.attachments, m.reply_to_message_id, m.quoted_text, m.model
  FROM messages m
  WHERE m.thread_id = ? AND m.is_internal = 0
  ORDER BY m.sequence DESC
  LIMIT ?
),
tool_counts AS (
  SELECT message_id, COUNT(*) AS tool_call_count
  FROM tool_call_records
  WHERE message_id IN (SELECT id FROM page)
  GROUP BY message_id
)
SELECT page.*, COALESCE(tool_counts.tool_call_count, 0) AS tool_call_count
FROM page
LEFT JOIN tool_counts ON tool_counts.message_id = page.id
ORDER BY page.sequence ASC`,
      );
      const plan = stmt.all("thread-1", 11) as Array<{ detail?: string }>;
      const text = plan.map((r) => r.detail ?? "").join("\n").toUpperCase();
      expect(text).not.toContain("SCAN TOOL_CALL_RECORDS");
      expect(text).not.toContain("CORRELATED");
    });
  });

  describe("listByThreadUpToSequence", () => {
    it("returns all messages with sequence <= maxSequence", () => {
      for (let i = 1; i <= 5; i++) {
        repo.create("thread-1", "user", `msg-${i}`, i);
      }

      const result = repo.listByThreadUpToSequence("thread-1", 3);
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.sequence)).toEqual([1, 2, 3]);
    });

    it("returns empty array when no messages match", () => {
      repo.create("thread-1", "user", "msg-1", 10);

      const result = repo.listByThreadUpToSequence("thread-1", 5);
      expect(result).toHaveLength(0);
    });

    it("does not clamp at 1000 rows", () => {
      // Insert 1200 messages
      const insert = db.prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertMany = db.transaction(() => {
        for (let i = 1; i <= 1200; i++) {
          insert.run(`id-${i}`, "thread-1", "user", `msg-${i}`, "2026-01-01T00:00:00Z", i);
        }
      });
      insertMany();

      const result = repo.listByThreadUpToSequence("thread-1", 1200);
      expect(result).toHaveLength(1200);
    });

    it("only returns messages for the specified thread", () => {
      repo.create("thread-1", "user", "t1-msg", 1);
      repo.create("thread-2", "user", "t2-msg", 1);

      const result = repo.listByThreadUpToSequence("thread-1", 10);
      expect(result).toHaveLength(1);
      expect(result[0].thread_id).toBe("thread-1");
    });
  });

  describe("create with reply fields", () => {
    it("persists replyToMessageId and quotedText", () => {
      const original = repo.create("thread-1", "assistant", "hello", 1);
      const reply = repo.create("thread-1", "user", "reply text", 2, undefined, original.id, "quoted excerpt");

      expect(reply.reply_to_message_id).toBe(original.id);
      expect(reply.quoted_text).toBe("quoted excerpt");
    });

    it("stores null when reply fields are omitted", () => {
      const msg = repo.create("thread-1", "user", "no reply", 1);

      expect(msg.reply_to_message_id).toBeNull();
      expect(msg.quoted_text).toBeNull();
    });

    it("round-trips reply fields through findByIdInThread", () => {
      const original = repo.create("thread-1", "user", "original", 1);
      const reply = repo.create("thread-1", "assistant", "response", 2, undefined, original.id, "some quote");

      const found = repo.findByIdInThread("thread-1", reply.id);
      expect(found).not.toBeNull();
      expect(found!.reply_to_message_id).toBe(original.id);
      expect(found!.quoted_text).toBe("some quote");
    });
  });

  describe("createAssistantIdempotent", () => {
    it("inserts the assistant row with the supplied deterministic id", () => {
      const msg = repo.createAssistantIdempotent({
        id: "det-1",
        threadId: "thread-1",
        content: "answer",
        sequence: 2,
        model: "claude-sonnet-4-6",
      });

      expect(msg.id).toBe("det-1");
      expect(msg.role).toBe("assistant");
      const found = repo.findByIdInThread("thread-1", "det-1");
      expect(found?.content).toBe("answer");
      expect(found?.model).toBe("claude-sonnet-4-6");
    });

    it("is a no-op on a second write for the same id (insert-or-ignore)", () => {
      repo.createAssistantIdempotent({
        id: "det-1",
        threadId: "thread-1",
        content: "first",
        sequence: 2,
        model: null,
      });
      repo.createAssistantIdempotent({
        id: "det-1",
        threadId: "thread-1",
        content: "second",
        sequence: 3,
        model: null,
      });

      const { messages } = repo.listByThread("thread-1", 10);
      const assistantRows = messages.filter((m) => m.role === "assistant");
      expect(assistantRows).toHaveLength(1);
      // The original row wins; the ignored write does not overwrite it.
      expect(assistantRows[0].content).toBe("first");
      expect(assistantRows[0].sequence).toBe(2);
    });
  });

  describe("findByIdInThread", () => {
    it("returns the message matching the given id and thread", () => {
      repo.create("thread-1", "user", "first", 1);
      const second = repo.create("thread-1", "assistant", "second", 2);

      const found = repo.findByIdInThread("thread-1", second.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(second.id);
      expect(found!.content).toBe("second");
    });

    it("returns null when message does not exist", () => {
      const found = repo.findByIdInThread("thread-1", "nonexistent");
      expect(found).toBeNull();
    });

    it("returns null when message belongs to a different thread", () => {
      const msg = repo.create("thread-2", "user", "other thread", 1);

      const found = repo.findByIdInThread("thread-1", msg.id);
      expect(found).toBeNull();
    });
  });
});
