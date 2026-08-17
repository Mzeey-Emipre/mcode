import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../../events/persistence/hook-execution-repo.js";
import { PlanQuestionAnswersRepo } from "../../../planning/persistence/plan-question-answers-repo.js";
import { NarrativeStore } from "../../narrative/narrative-store.js";
import {
  loadConversationPage,
  loadConversationTail,
  loadNewerConversationPage,
  loadOlderConversationPage,
} from "../conversation-page.js";

function seedThread(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/conversation-page", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "ws-1", "Thread", "main", now, now);
}

function insertMessage(
  db: Database.Database,
  id: string,
  role: string,
  content: string,
  sequence: number,
  isInternal = false,
): void {
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, is_internal) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "thread-1", role, content, new Date().toISOString(), sequence, isInternal ? 1 : 0);
}

function createDeps(db: Database.Database) {
  const messageRepo = new MessageRepo(db);
  const narrativeStore = new NarrativeStore(
    messageRepo,
    new ToolCallRecordRepo(db),
    new ThoughtSegmentRepo(db),
    new HookExecutionRepo(db),
  );
  return {
    messageRepo,
    narrativeStore,
    planQuestionAnswersRepo: new PlanQuestionAnswersRepo(db),
  };
}

describe("loadConversationPage", () => {
  it("prefers canonical messages and narrative while retaining older compatibility history", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    insertMessage(db, "legacy", "assistant", "older turn", 1);
    insertMessage(db, "canonical-user", "user", "stale user projection", 2);
    insertMessage(db, "canonical-assistant", "assistant", "stale assistant projection", 3);
    const deps = createDeps(db);
    const canonicalSink = {
      loadConversationProjection: vi.fn(() => ({
        messages: [
          { ...deps.messageRepo.findById("canonical-user")!, content: "canonical user" },
          { ...deps.messageRepo.findById("canonical-assistant")!, content: "canonical assistant" },
        ],
        narrativeByMessage: {
          "canonical-user": { tools: [], thoughts: [], hooks: [] },
          "canonical-assistant": {
            tools: [{
              id: "canonical-tool",
              message_id: "canonical-assistant",
              parent_tool_call_id: null,
              tool_name: "Read",
              input_summary: "canonical input",
              output_summary: "canonical output",
              status: "completed" as const,
              started_at: "2026-01-01T00:00:00Z",
              completed_at: "2026-01-01T00:00:01Z",
              sort_order: 0,
            }],
            thoughts: [],
            hooks: [],
          },
        },
        hasMore: false,
      })),
    };

    const page = loadConversationPage({ ...deps, canonicalSink } as Parameters<typeof loadConversationPage>[0], {
      threadId: "thread-1",
      limit: 10,
    });

    expect(page.messages.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: "legacy", content: "older turn" },
      { id: "canonical-user", content: "canonical user" },
      { id: "canonical-assistant", content: "canonical assistant" },
    ]);
    expect(page.narrativeByMessage["canonical-assistant"].tools).toEqual([
      expect.objectContaining({ id: "canonical-tool" }),
    ]);
  });

  it("returns a paginated message page with grouped narrative payloads", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    insertMessage(db, "u1", "user", "start", 1);
    insertMessage(db, "a1", "assistant", "answer one", 2);
    insertMessage(db, "u2", "user", "continue", 3);
    insertMessage(db, "a2", "assistant", "answer two", 4);
    insertMessage(db, "internal-a", "assistant", "hidden", 5, true);

    new ToolCallRecordRepo(db).bulkCreate([
      {
        messageId: "a1",
        toolName: "Read",
        inputSummary: "src/a.ts",
        outputSummary: "ok",
        status: "completed",
        sortOrder: 1,
      },
    ]);
    new ThoughtSegmentRepo(db).bulkCreate([
      {
        messageId: "a1",
        text: "checking",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
        sortOrder: 0,
      },
    ]);
    new HookExecutionRepo(db).bulkCreate([
      {
        messageId: "a1",
        hookName: "PreToolUse",
        toolName: "Read",
        phase: "pre",
        payload: "{}",
        durationMs: 1,
        didBlock: false,
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
        sortOrder: 2,
      },
    ]);

    const page = loadConversationPage(createDeps(db), {
      threadId: "thread-1",
      limit: 10,
    });

    expect(page.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(page.messages.find((m) => m.id === "a1")?.tool_call_count).toBe(1);
    expect(page.narrativeByMessage.a1.tools).toHaveLength(1);
    expect(page.narrativeByMessage.a1.thoughts).toHaveLength(1);
    expect(page.narrativeByMessage.a1.hooks).toHaveLength(1);
    expect(page.narrativeByMessage.a2).toEqual({ tools: [], thoughts: [], hooks: [] });
    expect(page.narrativeByMessage["internal-a"]).toBeUndefined();
  });

  it("uses a fixed set of page and child-table statements for many assistant messages", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    for (let i = 1; i <= 8; i++) {
      insertMessage(db, `a${i}`, "assistant", `answer ${i}`, i);
    }
    const deps = createDeps(db);
    const prepareSpy = vi.spyOn(db, "prepare");

    loadConversationPage(deps, { threadId: "thread-1", limit: 8 });

    const sql = prepareSpy.mock.calls.map((call) => String(call[0]));
    expect(sql.filter((s) => s.includes("FROM tool_call_records WHERE message_id IN"))).toHaveLength(1);
    expect(sql.filter((s) => s.includes("FROM thought_segments WHERE message_id IN"))).toHaveLength(1);
    expect(sql.filter((s) => s.includes("FROM hook_executions WHERE message_id IN"))).toHaveLength(1);
    expect(sql.join("\n")).not.toContain("WHERE message_id = ?");
  });

  it("paginates through the same interface", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    for (let i = 1; i <= 5; i++) {
      insertMessage(db, `m${i}`, i % 2 === 0 ? "assistant" : "user", `msg ${i}`, i);
    }

    const page = loadConversationPage(createDeps(db), {
      threadId: "thread-1",
      limit: 2,
      before: 5,
    });

    expect(page.messages.map((m) => m.sequence)).toEqual([3, 4]);
    expect(page.hasMore).toBe(true);
    expect(page.narrativeByMessage.m4).toEqual({ tools: [], thoughts: [], hooks: [] });
  });
});

describe("loadConversationTail", () => {
  it("returns the newest visible messages and bypasses narrative and plan queries", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    insertMessage(db, "u1", "user", "start", 1);
    insertMessage(db, "a1", "assistant", "answer", 2);
    insertMessage(db, "internal", "assistant", "hidden", 3, true);
    insertMessage(db, "u2", "user", "latest", 4);
    const deps = createDeps(db);
    const narrativeSpy = vi.spyOn(deps.narrativeStore, "loadForMessages");
    const planSpy = vi.spyOn(deps.planQuestionAnswersRepo, "listAnsweredForThread");

    const tail = loadConversationTail(deps, {
      threadId: "thread-1",
      limit: 2,
    });

    expect(tail).toEqual({
      messages: [
        expect.objectContaining({ id: "a1", sequence: 2 }),
        expect.objectContaining({ id: "u2", sequence: 4 }),
      ],
      hasMore: true,
      nextBefore: 2,
    });
    expect(narrativeSpy).not.toHaveBeenCalled();
    expect(planSpy).not.toHaveBeenCalled();
  });
});

describe("loadOlderConversationPage", () => {
  it("echoes request identity and returns the nearest sequence window within its byte budget", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    insertMessage(db, "m1", "user", "a".repeat(40_000), 1);
    insertMessage(db, "m2", "assistant", "b".repeat(40_000), 2);
    insertMessage(db, "m3", "user", "c".repeat(40_000), 3);

    const request = {
      threadId: "thread-1",
      cursor: { version: 1 as const, beforeSequence: 4 },
      direction: "older" as const,
      generation: 5,
      conversationRevision: 9,
      limit: 3,
      maxBytes: 65_536,
    };
    const page = loadOlderConversationPage(createDeps(db), request);

    expect(page.identity).toEqual({
      threadId: request.threadId,
      cursor: request.cursor,
      direction: request.direction,
      generation: request.generation,
      conversationRevision: request.conversationRevision,
    });
    expect(page.messages.map((message) => message.sequence)).toEqual([3]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ version: 1, beforeSequence: 3 });
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(request.maxBytes);
  });

  it("fails closed when the nearest message cannot fit in the response budget", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    insertMessage(db, "m1", "user", "x".repeat(70_000), 1);

    expect(() => loadOlderConversationPage(createDeps(db), {
      threadId: "thread-1",
      cursor: { version: 1, beforeSequence: 2 },
      direction: "older",
      generation: 1,
      conversationRevision: 1,
      limit: 1,
      maxBytes: 65_536,
    })).toThrow("cannot fit within 65536 bytes");
  });
});

describe("loadNewerConversationPage", () => {
  it("returns the nearest newer sequence window within the shared byte budget", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    insertMessage(db, "m1", "user", "old", 1);
    insertMessage(db, "m2", "assistant", "b".repeat(40_000), 2);
    insertMessage(db, "m3", "user", "c".repeat(40_000), 3);
    insertMessage(db, "m4", "assistant", "d".repeat(40_000), 4);

    const request = {
      threadId: "thread-1",
      cursor: { version: 1 as const, afterSequence: 1 },
      direction: "newer" as const,
      generation: 5,
      conversationRevision: 9,
      limit: 3,
      maxBytes: 65_536,
    };
    const page = loadNewerConversationPage(createDeps(db), request);

    expect(page.identity).toEqual({
      threadId: request.threadId,
      cursor: request.cursor,
      direction: request.direction,
      generation: request.generation,
      conversationRevision: request.conversationRevision,
    });
    expect(page.messages.map((message) => message.sequence)).toEqual([2]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ version: 1, afterSequence: 2 });
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(request.maxBytes);
  });

  it("traverses forward without gaps or duplicate boundary rows", () => {
    const db = openMemoryDatabase();
    seedThread(db);
    for (let sequence = 1; sequence <= 8; sequence++) {
      insertMessage(db, `m${sequence}`, sequence % 2 === 0 ? "assistant" : "user", `message ${sequence}`, sequence);
    }
    const deps = createDeps(db);
    const sequences: number[] = [];
    let afterSequence = 0;

    for (;;) {
      const page = loadNewerConversationPage(deps, {
        threadId: "thread-1",
        cursor: { version: 1, afterSequence },
        direction: "newer",
        generation: 1,
        conversationRevision: 1,
        limit: 3,
        maxBytes: 65_536,
      });
      sequences.push(...page.messages.map((message) => message.sequence));
      if (!page.nextCursor) break;
      afterSequence = page.nextCursor.afterSequence;
    }

    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
