import "reflect-metadata";
import * as NodePerfHooks from "node:perf_hooks";
import type { Database } from "bun:sqlite";
import { CONVERSATION_HISTORY_PAGE_MAX_BYTES } from "@mcode/contracts";
import { openMemoryDatabase } from "../src/runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../src/features/agents/conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../src/features/agents/tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../src/features/agents/conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../src/features/agents/events/persistence/hook-execution-repo.js";
import { PlanQuestionAnswersRepo } from "../src/features/agents/planning/persistence/plan-question-answers-repo.js";
import { NarrativeStore } from "../src/features/agents/conversation/narrative/narrative-store.js";
import {
  loadConversationPage,
  loadNewerConversationPage,
  loadOlderConversationPage,
} from "../src/features/agents/conversation/read-model/conversation-page.js";

const assistantCount = Number(process.argv[2] ?? 100);
const iterations = Number(process.argv[3] ?? 50);
const threadId = "bench-thread";
const directionalPageSize = Math.min(100, assistantCount);
const midpointSequence = assistantCount;

function seedThread(db: Database): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("bench-ws", "Bench", "/tmp/mcode-bench", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(threadId, "bench-ws", "Bench thread", "main", now, now);
}

function seedMessages(db: Database): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertMany = db.transaction(() => {
    for (let i = 1; i <= assistantCount; i++) {
      insert.run(`u-${i}`, threadId, "user", `User message ${i}`, now, i * 2 - 1);
      insert.run(`a-${i}`, threadId, "assistant", `Assistant answer ${i}`, now, i * 2);
    }
  });
  insertMany();
}

function seedNarrative(db: Database): void {
  const tools = new ToolCallRecordRepo(db);
  const thoughts = new ThoughtSegmentRepo(db);
  const hooks = new HookExecutionRepo(db);
  tools.bulkCreate(
    Array.from({ length: assistantCount }, (_, i) => ({
      messageId: `a-${i + 1}`,
      toolName: "Read",
      inputSummary: `src/file-${i + 1}.ts`,
      outputSummary: "ok",
      status: "completed" as const,
      sortOrder: 1,
    })),
  );
  thoughts.bulkCreate(
    Array.from({ length: assistantCount }, (_, i) => ({
      messageId: `a-${i + 1}`,
      text: `Thinking ${i + 1}`,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      sortOrder: 0,
    })),
  );
  hooks.bulkCreate(
    Array.from({ length: assistantCount }, (_, i) => ({
      messageId: `a-${i + 1}`,
      hookName: `PreToolUse-${i + 1}`,
      toolName: "Read",
      phase: "pre",
      payload: "{}",
      durationMs: 1,
      didBlock: false,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      sortOrder: 2,
    })),
  );
}

const db = openMemoryDatabase();
seedThread(db);
seedMessages(db);
seedNarrative(db);

const messageRepo = new MessageRepo(db);
const deps = {
  messageRepo,
  narrativeStore: new NarrativeStore(
    messageRepo,
    new ToolCallRecordRepo(db),
    new ThoughtSegmentRepo(db),
    new HookExecutionRepo(db),
  ),
  planQuestionAnswersRepo: new PlanQuestionAnswersRepo(db),
};

let prepareCount = 0;
const originalPrepare = db.prepare.bind(db);
(db as unknown as { prepare: typeof db.prepare }).prepare = ((source: string) => {
  prepareCount++;
  return originalPrepare(source);
}) as typeof db.prepare;

loadConversationPage(deps, { threadId, limit: assistantCount * 2 });
prepareCount = 0;

const started = NodePerfHooks.performance.now();
let lastRows = 0;
for (let i = 0; i < iterations; i++) {
  const page = loadConversationPage(deps, { threadId, limit: assistantCount * 2 });
  lastRows = Object.values(page.narrativeByMessage)
    .reduce((sum, item) => sum + item.tools.length + item.thoughts.length + item.hooks.length, 0);
}
const elapsedMs = NodePerfHooks.performance.now() - started;
const prepareCallsPerLoad = Number((prepareCount / iterations).toFixed(1));

const olderRequest = {
  threadId,
  cursor: { version: 1 as const, beforeSequence: midpointSequence + 1 },
  direction: "older" as const,
  generation: 1,
  conversationRevision: 1,
  limit: directionalPageSize,
  maxBytes: CONVERSATION_HISTORY_PAGE_MAX_BYTES,
};
const newerRequest = {
  threadId,
  cursor: { version: 1 as const, afterSequence: midpointSequence },
  direction: "newer" as const,
  generation: 1,
  conversationRevision: 1,
  limit: directionalPageSize,
  maxBytes: CONVERSATION_HISTORY_PAGE_MAX_BYTES,
};

loadOlderConversationPage(deps, olderRequest);
const olderStarted = NodePerfHooks.performance.now();
let olderRows = 0;
for (let i = 0; i < iterations; i++) {
  olderRows = loadOlderConversationPage(deps, olderRequest).messages.length;
}
const olderElapsedMs = NodePerfHooks.performance.now() - olderStarted;

loadNewerConversationPage(deps, newerRequest);
const newerStarted = NodePerfHooks.performance.now();
let newerRows = 0;
for (let i = 0; i < iterations; i++) {
  newerRows = loadNewerConversationPage(deps, newerRequest).messages.length;
}
const newerElapsedMs = NodePerfHooks.performance.now() - newerStarted;

console.log(JSON.stringify({
  assistantMessages: assistantCount,
  iterations,
  avgMs: Number((elapsedMs / iterations).toFixed(3)),
  prepareCallsPerLoad,
  narrativeRows: lastRows,
  directionalPageSize,
  olderRows,
  olderAvgMs: Number((olderElapsedMs / iterations).toFixed(3)),
  newerRows,
  newerAvgMs: Number((newerElapsedMs / iterations).toFixed(3)),
}));
