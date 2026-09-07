import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "bun:sqlite";
import { MessageRepo } from "../message-repo.js";
import { openBunMemoryDatabase } from "../../../../../runtime/persistence/sqlite/__tests__/bun-sqlite.js";

function createTestDb(): Database {
  const db = openBunMemoryDatabase();
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
      preview_annotations TEXT,
      mentions TEXT,
      selected_text_comments TEXT,
      reply_to_message_id TEXT,
      quoted_text TEXT,
      model TEXT,
      provider TEXT,
      origin_type TEXT NOT NULL DEFAULT 'legacy',
      source_thread_id TEXT,
      source_turn_id TEXT,
      source_provider_id TEXT,
      is_internal INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      outcome_execution_id TEXT
      ,system_notice TEXT
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
  let db: Database;
  let repo: MessageRepo;

  beforeEach(() => {
    db = createTestDb();
    repo = new MessageRepo(db);
  });

  it("prepares each active write statement lazily and only once", () => {
    const localDb = createTestDb();
    const preparedSql: string[] = [];
    const originalPrepare = localDb.prepare.bind(localDb);
    (localDb as unknown as { prepare: Database["prepare"] }).prepare = ((sql: string) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    }) as Database["prepare"];
    const localRepo = new MessageRepo(localDb);

    localRepo.listByThread("thread-1", 10);
    expect(preparedSql.some((sql) => sql.startsWith("INSERT"))).toBe(false);

    localRepo.create("thread-1", "user", "one", 1);
    localRepo.create("thread-1", "user", "two", 2);
    localRepo.createAssistantIdempotent({
      id: "assistant-1",
      threadId: "thread-1",
      content: "three",
      sequence: 3,
      isInternal: true,
    });
    localRepo.createAssistantIdempotent({
      id: "assistant-1",
      threadId: "thread-1",
      content: "three",
      sequence: 3,
      isInternal: true,
    });
    localRepo.publishAssistant("assistant-1");
    localRepo.publishAssistant("assistant-1");

    expect(preparedSql.filter((sql) => sql.startsWith("INSERT INTO messages")).length).toBe(1);
    expect(preparedSql.filter((sql) => sql.startsWith("INSERT OR IGNORE INTO messages")).length).toBe(1);
    expect(preparedSql.filter((sql) => sql.startsWith("UPDATE messages SET is_internal")).length).toBe(1);
    localDb.close();
  });

  it("persists a supplied user message ID", () => {
    const messageId = "550e8400-e29b-41d4-a716-446655440000";

    const message = repo.create(
      "thread-1",
      "user",
      "follow-up",
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      messageId,
    );
    const persisted = db
      .prepare("SELECT id FROM messages WHERE thread_id = ? AND sequence = ?")
      .get("thread-1", 1) as { id: string } | undefined;

    expect(message.id).toBe(messageId);
    expect(persisted?.id).toBe(messageId);
  });

  it("round-trips typed system notice metadata with the transcript message", () => {
    const message = repo.create(
      "thread-1",
      "system",
      "Codex rerouted this turn.",
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: "model-rerouted", presentation: "toast" },
    );

    expect(repo.listByThread("thread-1", 10).messages).toMatchObject([{
      id: message.id,
      systemNotice: { kind: "model-rerouted", presentation: "toast" },
    }]);
  });

  it("keeps legacy NULL outcomes unchanged and writes terminal outcome identity explicitly", () => {
    const legacy = repo.create("thread-1", "assistant", "old", 1);
    expect(repo.listByThread("thread-1", 10).messages[0]).toMatchObject({
      id: legacy.id,
      outcome: null,
      outcomeExecutionId: null,
    });

    repo.setAssistantOutcome(legacy.id, "interrupted", "550e8400-e29b-41d4-a716-446655440000");
    expect(repo.listByThread("thread-1", 10).messages[0]).toMatchObject({
      outcome: "interrupted",
      outcomeExecutionId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  describe("listByThread", () => {
    it("returns tool_call_count per message via indexed lookup", () => {
      repo.create("thread-1", "user", "a", 1);
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
  SELECT m.id, m.thread_id, m.role, m.content, m.tool_calls, m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence, m.attachments, m.preview_annotations, m.mentions, m.reply_to_message_id, m.quoted_text, m.model, m.is_internal
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

  describe("listByThreadUpToSequenceBudgeted", () => {
    it("keeps newest messages within the byte budget and reports older elision", () => {
      for (let i = 1; i <= 4; i++) {
        repo.create("thread-1", "user", `msg-${i}`, i);
      }

      const result = repo.listByThreadUpToSequenceBudgeted("thread-1", 4, {
        maxBytes: 10,
        pageSize: 2,
      });

      expect(result.messages.map((m) => m.sequence)).toEqual([3, 4]);
      expect(result.budget.omittedBeforeCount).toBe(2);
      expect(result.budget.retainedBytes).toBe(10);
      expect(result.budget.truncatedMessages).toEqual([]);
    });

    it("truncates the fork anchor when one message exceeds the byte budget", () => {
      repo.create("thread-1", "user", "older", 1);
      const anchor = repo.create("thread-1", "assistant", "abcdef", 2);

      const result = repo.listByThreadUpToSequenceBudgeted("thread-1", 2, {
        maxBytes: 3,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe(anchor.id);
      expect(result.messages[0].content).toBe("abc");
      expect(result.budget.omittedBeforeCount).toBe(1);
      expect(result.budget.truncatedMessages).toEqual([
        { id: anchor.id, originalBytes: 6, retainedBytes: 3 },
      ]);
    });

    it("preserves assistant outcome identity for full and truncated fork history", () => {
      const full = repo.create("thread-1", "assistant", "complete", 1);
      repo.setAssistantOutcome(full.id, "errored", "execution-full");

      const fullResult = repo.listByThreadUpToSequenceBudgeted("thread-1", 1, {
        maxBytes: 100,
      });

      expect(fullResult.messages).toHaveLength(1);
      expect(fullResult.messages[0]).toMatchObject({
        id: full.id,
        outcome: "errored",
        outcomeExecutionId: "execution-full",
      });

      const truncated = repo.create("thread-1", "assistant", "abcdef", 2);
      repo.setAssistantOutcome(truncated.id, "interrupted", "execution-truncated");

      const truncatedResult = repo.listByThreadUpToSequenceBudgeted("thread-1", 2, {
        maxBytes: 3,
      });

      expect(truncatedResult.messages).toHaveLength(1);
      expect(truncatedResult.messages[0]).toMatchObject({
        id: truncated.id,
        content: "abc",
        outcome: "interrupted",
        outcomeExecutionId: "execution-truncated",
      });
    });

    it("caps retained history by row count as well as bytes", () => {
      for (let i = 1; i <= 10; i++) {
        repo.create("thread-1", "user", "x", i);
      }

      const result = repo.listByThreadUpToSequenceBudgeted("thread-1", 10, {
        maxBytes: 100,
        maxRows: 3,
      });

      expect(result.messages.map((m) => m.sequence)).toEqual([8, 9, 10]);
      expect(result.budget.omittedBeforeCount).toBe(7);
      expect(result.budget.retainedBytes).toBe(3);
      expect(result.budget.truncatedMessages).toEqual([]);
    });

    it("reports retained bytes after trimming to valid utf8 boundaries", () => {
      const anchor = repo.create("thread-1", "assistant", "ééé", 1);

      const result = repo.listByThreadUpToSequenceBudgeted("thread-1", 1, {
        maxBytes: 5,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("éé");
      expect(result.budget.retainedBytes).toBe(4);
      expect(result.budget.truncatedMessages).toEqual([
        { id: anchor.id, originalBytes: 6, retainedBytes: 4 },
      ]);
    });
  });

  describe("listByThreadForThreadControl", () => {
    it("excludes session diagnostics from transcript rows and pagination", () => {
      repo.create("thread-1", "assistant", "Reply", 1);
      repo.createSystemNotice("thread-1", "Configuration warning", 2, { kind: "configuration", presentation: "timeline", scope: "session", sessionId: "session-1", noticeKey: "config-1" });
      const result = repo.listByThreadForThreadControl("thread-1", 1, 100);
      expect(result.messages.map((message) => message.content)).toEqual(["Reply"]);
      expect(result.hasMore).toBe(false);
    });

    it("keeps newest rows in chronological order under the UTF-8 byte cap", () => {
      repo.create("thread-1", "user", "older", 1);
      repo.create("thread-1", "assistant", "éé", 2);
      repo.create("thread-1", "user", "newest", 3);

      const result = repo.listByThreadForThreadControl("thread-1", 3, 6);

      expect(result.messages.map((message) => message.content)).toEqual(["newest"]);
      expect(Buffer.byteLength(result.messages[0]!.content, "utf8")).toBeLessThanOrEqual(6);
      expect(result.hasMore).toBe(true);
    });

    it("truncates one oversized message at a valid UTF-8 boundary", () => {
      repo.create("thread-1", "assistant", "😀😀", 1);

      const result = repo.listByThreadForThreadControl("thread-1", 1, 5);

      expect(result.messages.map((message) => message.content)).toEqual(["😀"]);
      expect(Buffer.byteLength(result.messages[0]!.content, "utf8")).toBe(4);
      expect(result.hasMore).toBe(true);
    });
  });

  describe("create with reply fields", () => {
    it("persists authenticated cross-thread provenance", () => {
      const message = repo.create(
        "thread-1",
        "user",
        "delegated request",
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          type: "thread",
          sourceThreadId: "source-thread",
          sourceTurnId: "source-turn",
          sourceProviderId: "codex",
        },
      );

      expect(db.prepare("SELECT origin_type, source_thread_id, source_turn_id, source_provider_id FROM messages WHERE id = ?").get(message.id)).toEqual({
        origin_type: "thread",
        source_thread_id: "source-thread",
        source_turn_id: "source-turn",
        source_provider_id: "codex",
      });
    });

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

  describe("create with mention metadata", () => {
    it("round-trips selected typed mentions", () => {
      const mentions = [{
        id: "mention-1",
        kind: "file" as const,
        label: "src/app.ts",
        path: "src/app.ts",
        range: { start: 6, end: 17 },
      }];

      const created = repo.create(
        "thread-1",
        "user",
        "check @src/app.ts",
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mentions,
      );
      const fetched = repo.findByIdInThread("thread-1", created.id);

      expect(created.mentions).toEqual(mentions);
      expect(fetched?.mentions).toEqual(mentions);
    });
  });

  describe("create with selected-text comments", () => {
    it("round-trips several comments with exact source ranges and typed mentions", () => {
      const selectedTextComments = [{
        id: "76da3c6e-6b42-4c01-aaf2-3ad0b29a4756",
        displayNumber: 1,
        source: {
          threadId: "thread-1",
          messageId: "source-message",
          sourceRole: "assistant" as const,
          start: 2,
          end: 9,
          quote: "const x",
        },
        note: "Explain this branch.",
        mentions: [{
          id: "file:src/index.ts",
          kind: "file" as const,
          label: "src/index.ts",
          path: "src/index.ts",
          range: { start: 0, end: 12 },
        }],
      }, {
        id: "b102c9ae-598d-4f7d-a9aa-58e2d28ee952",
        displayNumber: 2,
        source: {
          threadId: "thread-1",
          messageId: "user-source-message-2",
          sourceRole: "user" as const,
          start: 1,
          end: 3,
          quote: "😀",
        },
        note: "Explain this user-selected follow-up.",
        mentions: [],
      }];

      const created = repo.create(
        "thread-1",
        "user",
        "Please clarify this.",
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        selectedTextComments,
      );
      const fetched = repo.findByIdInThread("thread-1", created.id);

      expect(created.selectedTextComments).toEqual(selectedTextComments);
      expect(fetched?.selectedTextComments).toEqual(selectedTextComments);
    });
  });

  describe("create with preview annotations", () => {
    it("round-trips preview annotations through persisted message listing", () => {
      const bundle = {
        schemaVersion: 1 as const,
        annotations: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            displayNumber: 1,
            pageIdentity: "http://localhost:3000/settings",
            pageContext: {
              schemaVersion: 2 as const,
              pageUrl: "http://localhost:3000/settings",
              pageTitle: "Settings",
              capturedAt: "2026-07-01T00:00:00.000Z",
              bounds: { x: 0, y: 0, width: 800, height: 600 },
            },
            targetContext: {
              label: "Save button",
              selectorHint: "button[type='submit']",
              bounds: { x: 12, y: 24, width: 120, height: 40 },
            },
            note: "Make this button easier to scan.",
            changeSummary: "Increase contrast.",
            snapshot: {
              id: "snapshot-1",
              name: "settings.png",
              mimeType: "image/png" as const,
              sizeBytes: 1234,
              sourcePath: "C:\\temp\\settings.png",
              capture: {
                schemaVersion: 2 as const,
                pageUrl: "http://localhost:3000/settings",
                pageTitle: "Settings",
                capturedAt: "2026-07-01T00:00:00.000Z",
                bounds: { x: 0, y: 0, width: 800, height: 600 },
              },
            },
          },
        ],
      };

      repo.create(
        "thread-1",
        "user",
        "",
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        bundle,
      );

      const { messages } = repo.listByThread("thread-1", 10);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("");
      expect(messages[0].previewAnnotations).toEqual(bundle);
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
