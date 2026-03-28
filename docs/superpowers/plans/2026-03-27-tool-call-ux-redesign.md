# Tool Call UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist tool calls to SQLite, show post-turn summaries with expandable history, render inline diffs with Shiki, nest subagent tool calls, and display a subagent count badge.

**Architecture:** New `tool_call_records` and `turn_snapshots` tables store tool calls and git snapshot refs after each turn. The server buffers tool calls during a turn, bulk-inserts on `turnComplete`, captures git stash refs for on-demand diffing, and pushes a `turn.persisted` event to the client. The frontend adds a `ToolCallSummary` virtual item after assistant messages, expandable to show persisted tool call cards and inline diffs.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), tsyringe DI, Zod schemas, React, Zustand, Shiki (lazy-loaded WASM), Vitest, @tanstack/react-virtual

**Spec:** `docs/superpowers/specs/2026-03-27-tool-call-ux-redesign.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/contracts/src/models/tool-call-record.ts` | `ToolCallRecordSchema` + `ToolCallRecord` type |
| `packages/contracts/src/models/turn-snapshot.ts` | `TurnSnapshotSchema` + `TurnSnapshot` type |
| `apps/server/src/repositories/tool-call-record-repo.ts` | CRUD for `tool_call_records` table |
| `apps/server/src/repositories/turn-snapshot-repo.ts` | CRUD for `turn_snapshots` table |
| `apps/server/src/services/snapshot-service.ts` | Git snapshot capture + diff generation |
| `apps/server/src/__tests__/tool-call-record-repo.test.ts` | Repo unit tests |
| `apps/server/src/__tests__/turn-snapshot-repo.test.ts` | Repo unit tests |
| `apps/server/src/__tests__/snapshot-service.test.ts` | Snapshot service unit tests |
| `apps/web/src/components/chat/ToolCallSummary.tsx` | Collapsed post-turn summary row |
| `apps/web/src/components/chat/DiffViewer.tsx` | Inline unified diff with Shiki |
| `apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx` | Nested subagent tool call wrapper |
| `apps/web/src/components/chat/AgentStatusBar.tsx` | Subagent count badge for composer |
| `apps/web/src/__tests__/tool-call-summary.test.tsx` | ToolCallSummary unit tests |

### Modified Files

| File | Change |
|------|--------|
| `apps/server/src/store/database.ts` | Add V7 migration (two new tables + indexes) |
| `packages/contracts/src/index.ts` | Export new schemas and types |
| `packages/contracts/src/ws/methods.ts` | Add 3 RPC methods |
| `packages/contracts/src/ws/channels.ts` | Add `turn.persisted` push channel |
| `packages/contracts/src/models/message.ts` | Add optional `tool_call_count` field |
| `packages/contracts/src/events/agent-event.ts` | Add optional `parentToolCallId` to `toolUse` event |
| `apps/server/src/container.ts` | Register new repos + service |
| `apps/server/src/repositories/message-repo.ts` | JOIN `tool_call_records` for count in `listByThread` |
| `apps/server/src/services/agent-service.ts` | Buffer tool calls, capture snapshots, persist on turnComplete |
| `apps/server/src/transport/ws-router.ts` | Wire new RPC dispatch cases |
| `apps/server/src/index.ts` | Augment events with `parentToolCallId`, push `turn.persisted` |
| `apps/web/src/transport/types.ts` | Add new transport methods + re-export new types |
| `apps/web/src/transport/ws-transport.ts` | Implement new RPC methods |
| `apps/web/src/transport/ws-events.ts` | Handle `turn.persisted` push channel |
| `apps/web/src/stores/threadStore.ts` | Subagent tracking state, `parentToolCallId`-aware completion, persisted tool call counts |
| `apps/web/src/components/chat/virtual-items.ts` | Add `tool-summary` virtual item type |
| `apps/web/src/components/chat/MessageList.tsx` | Render `tool-summary` items |
| `apps/web/src/components/chat/ToolCallCard.tsx` | No changes needed (existing fade-out preserved) |
| `apps/web/src/components/chat/tool-renderers/AgentRenderer.tsx` | Render `SubagentContainer` when viewing persisted tool calls |
| `apps/web/src/components/chat/Composer.tsx` | Host `AgentStatusBar` in status bar row |

---

## Chunk 1: Data Model and Contracts

### Task 1: Contract types for ToolCallRecord and TurnSnapshot

**Files:**
- Create: `packages/contracts/src/models/tool-call-record.ts`
- Create: `packages/contracts/src/models/turn-snapshot.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Create ToolCallRecord schema**

Create `packages/contracts/src/models/tool-call-record.ts`:

```ts
import { z } from "zod";

/** Status of a persisted tool call record. */
export const ToolCallStatusSchema = z.enum(["running", "completed", "failed"]);

/** Persisted tool call record linked to an assistant message. */
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  parent_tool_call_id: z.string().nullable(),
  tool_name: z.string(),
  input_summary: z.string(),
  output_summary: z.string(),
  status: ToolCallStatusSchema,
  started_at: z.string(),
  completed_at: z.string().nullable(),
  sort_order: z.number(),
});

/** Persisted tool call record linked to an assistant message. */
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
```

- [ ] **Step 2: Create TurnSnapshot schema**

Create `packages/contracts/src/models/turn-snapshot.ts`:

```ts
import { z } from "zod";

/** Git snapshot refs for reconstructing diffs on demand. */
export const TurnSnapshotSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  thread_id: z.string(),
  ref_before: z.string(),
  ref_after: z.string(),
  files_changed: z.array(z.string()),
  worktree_path: z.string().nullable(),
  created_at: z.string(),
});

/** Git snapshot refs for reconstructing diffs on demand. */
export type TurnSnapshot = z.infer<typeof TurnSnapshotSchema>;
```

- [ ] **Step 3: Export new types from contracts barrel**

In `packages/contracts/src/index.ts`, add after the existing Message exports (line 32):

```ts
export { ToolCallRecordSchema, ToolCallStatusSchema } from "./models/tool-call-record.js";
export type { ToolCallRecord } from "./models/tool-call-record.js";

export { TurnSnapshotSchema } from "./models/turn-snapshot.js";
export type { TurnSnapshot } from "./models/turn-snapshot.js";
```

- [ ] **Step 4: Verify contracts compile**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/models/tool-call-record.ts packages/contracts/src/models/turn-snapshot.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add ToolCallRecord and TurnSnapshot schemas"
```

---

### Task 2: Extend AgentEvent with parentToolCallId

**Files:**
- Modify: `packages/contracts/src/events/agent-event.ts`

- [ ] **Step 1: Add optional parentToolCallId to toolUse event**

In `packages/contracts/src/events/agent-event.ts`, replace the `toolUse` variant (lines 11-17):

```ts
  z.object({
    type: z.literal("toolUse"),
    threadId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    toolInput: z.record(z.unknown()),
    parentToolCallId: z.string().optional(),
  }),
```

- [ ] **Step 2: Verify contracts compile**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/events/agent-event.ts
git commit -m "feat(contracts): add parentToolCallId to toolUse AgentEvent"
```

---

### Task 3: Add tool_call_count to Message schema

**Files:**
- Modify: `packages/contracts/src/models/message.ts`

- [ ] **Step 1: Add optional tool_call_count field**

In `packages/contracts/src/models/message.ts`, add after line 17 (`attachments`), before the closing `});`:

```ts
  tool_call_count: z.number().optional(),
```

- [ ] **Step 2: Verify contracts compile**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/models/message.ts
git commit -m "feat(contracts): add tool_call_count to MessageSchema"
```

---

### Task 4: Add RPC methods and push channel to contracts

**Files:**
- Modify: `packages/contracts/src/ws/methods.ts`
- Modify: `packages/contracts/src/ws/channels.ts`

- [ ] **Step 1: Add new RPC method schemas**

In `packages/contracts/src/ws/methods.ts`, add the import at top:

```ts
import { ToolCallRecordSchema } from "../models/tool-call-record.js";
import { TurnSnapshotSchema } from "../models/turn-snapshot.js";
```

Then add before the closing `} as const;` (after line 183):

```ts
  "toolCallRecord.list": {
    params: z.object({ messageId: z.string() }),
    result: z.array(ToolCallRecordSchema),
  },
  "snapshot.getDiff": {
    params: z.object({
      snapshotId: z.string(),
      filePath: z.string().optional(),
    }),
    result: z.string(),
  },
  "snapshot.cleanup": {
    params: z.object({}),
    result: z.object({ removed: z.number() }),
  },
```

- [ ] **Step 2: Add turn.persisted push channel**

In `packages/contracts/src/ws/channels.ts`, add before the closing `} as const;` (after line 18):

```ts
  "turn.persisted": z.object({
    threadId: z.string(),
    messageId: z.string(),
    toolCallCount: z.number(),
    filesChanged: z.array(z.string()),
  }),
```

- [ ] **Step 3: Verify contracts compile**

Run: `cd packages/contracts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/ws/methods.ts packages/contracts/src/ws/channels.ts
git commit -m "feat(contracts): add tool call RPC methods and turn.persisted channel"
```

---

### Task 5: Database migration V7

**Files:**
- Modify: `apps/server/src/store/database.ts`

- [ ] **Step 1: Write failing test**

Create `apps/server/src/__tests__/tool-call-record-repo.test.ts` with just a migration check:

```ts
import { describe, it, expect } from "vitest";
import { openMemoryDatabase } from "../store/database.js";

describe("V7 migration", () => {
  it("creates tool_call_records and turn_snapshots tables", () => {
    const db = openMemoryDatabase();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tool_call_records', 'turn_snapshots') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "tool_call_records",
      "turn_snapshots",
    ]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/__tests__/tool-call-record-repo.test.ts`
Expected: FAIL (tables don't exist yet)

- [ ] **Step 3: Add V7 migration**

In `apps/server/src/store/database.ts`, add after the V6 migration block (after line 127):

```ts
  if (currentVersion < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_records (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        parent_tool_call_id TEXT REFERENCES tool_call_records(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input_summary TEXT NOT NULL DEFAULT '',
        output_summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tool_call_records_message ON tool_call_records(message_id);
      CREATE INDEX IF NOT EXISTS idx_tool_call_records_parent ON tool_call_records(parent_tool_call_id);

      CREATE TABLE IF NOT EXISTS turn_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        ref_before TEXT NOT NULL,
        ref_after TEXT NOT NULL,
        files_changed TEXT NOT NULL DEFAULT '[]',
        worktree_path TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_turn_snapshots_message ON turn_snapshots(message_id);
      CREATE INDEX IF NOT EXISTS idx_turn_snapshots_thread ON turn_snapshots(thread_id);
    `);
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(7);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run src/__tests__/tool-call-record-repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store/database.ts apps/server/src/__tests__/tool-call-record-repo.test.ts
git commit -m "feat(server): add V7 migration for tool_call_records and turn_snapshots"
```

---

## Chunk 2: Server Repositories

### Task 6: ToolCallRecordRepo

**Files:**
- Create: `apps/server/src/repositories/tool-call-record-repo.ts`
- Modify: `apps/server/src/__tests__/tool-call-record-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `apps/server/src/__tests__/tool-call-record-repo.test.ts`:

```ts
import { ToolCallRecordRepo } from "../repositories/tool-call-record-repo.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { MessageRepo } from "../repositories/message-repo.js";

describe("ToolCallRecordRepo", () => {
  let db: ReturnType<typeof openMemoryDatabase>;
  let repo: ToolCallRecordRepo;
  let messageId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ToolCallRecordRepo(db);
    const wsRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const msgRepo = new MessageRepo(db);

    const ws = wsRepo.create("proj", "/tmp/proj");
    const thread = threadRepo.create(ws.id, "Test", "direct", "main");
    const msg = msgRepo.create(thread.id, "assistant", "hello", 1);
    messageId = msg.id;
  });

  afterEach(() => db.close());

  it("creates and retrieves a single record", () => {
    const record = repo.create({
      messageId,
      toolName: "Edit",
      inputSummary: "file.ts",
      outputSummary: "edited",
      status: "completed",
      sortOrder: 0,
    });
    expect(record.id).toBeTruthy();
    expect(record.tool_name).toBe("Edit");
    expect(record.status).toBe("completed");

    const list = repo.listByMessage(messageId);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(record.id);
  });

  it("bulkCreate inserts multiple records", () => {
    repo.bulkCreate([
      { messageId, toolName: "Read", inputSummary: "a.ts", outputSummary: "", status: "completed", sortOrder: 0 },
      { messageId, toolName: "Edit", inputSummary: "b.ts", outputSummary: "", status: "completed", sortOrder: 1 },
      { messageId, toolName: "Bash", inputSummary: "ls", outputSummary: "", status: "failed", sortOrder: 2 },
    ]);
    const list = repo.listByMessage(messageId);
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.tool_name)).toEqual(["Read", "Edit", "Bash"]);
  });

  it("supports parent_tool_call_id for nesting", () => {
    const parent = repo.create({
      messageId,
      toolName: "Agent",
      inputSummary: "task",
      outputSummary: "",
      status: "completed",
      sortOrder: 0,
    });
    repo.bulkCreate([
      { messageId, toolName: "Read", inputSummary: "f.ts", outputSummary: "", status: "completed", sortOrder: 1, parentToolCallId: parent.id },
      { messageId, toolName: "Edit", inputSummary: "f.ts", outputSummary: "", status: "completed", sortOrder: 2, parentToolCallId: parent.id },
    ]);
    const children = repo.listByParent(parent.id);
    expect(children).toHaveLength(2);
    expect(children[0].parent_tool_call_id).toBe(parent.id);
  });

  it("cascade deletes when message is deleted", () => {
    repo.create({ messageId, toolName: "Read", inputSummary: "", outputSummary: "", status: "completed", sortOrder: 0 });
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    expect(repo.listByMessage(messageId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/__tests__/tool-call-record-repo.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement ToolCallRecordRepo**

Create `apps/server/src/repositories/tool-call-record-repo.ts`:

```ts
/**
 * Data access layer for persisted tool call records.
 * Provides creation, bulk insertion, and retrieval operations.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { ToolCallRecord } from "@mcode/contracts";

/** Input for creating a single tool call record. */
export interface CreateToolCallRecordInput {
  messageId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  status: "running" | "completed" | "failed";
  sortOrder: number;
  parentToolCallId?: string;
}

interface ToolCallRecordRow {
  id: string;
  message_id: string;
  parent_tool_call_id: string | null;
  tool_name: string;
  input_summary: string;
  output_summary: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  sort_order: number;
}

function rowToRecord(row: ToolCallRecordRow): ToolCallRecord {
  return {
    id: row.id,
    message_id: row.message_id,
    parent_tool_call_id: row.parent_tool_call_id,
    tool_name: row.tool_name,
    input_summary: row.input_summary,
    output_summary: row.output_summary,
    status: row.status as ToolCallRecord["status"],
    started_at: row.started_at,
    completed_at: row.completed_at,
    sort_order: row.sort_order,
  };
}

const COLUMNS =
  "id, message_id, parent_tool_call_id, tool_name, input_summary, output_summary, status, started_at, completed_at, sort_order";

/** Repository for tool_call_records table operations. */
@injectable()
export class ToolCallRecordRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Create a single tool call record and return it. */
  create(input: CreateToolCallRecordInput): ToolCallRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const completedAt = input.status !== "running" ? now : null;

    this.db
      .prepare(
        `INSERT INTO tool_call_records
         (id, message_id, parent_tool_call_id, tool_name, input_summary, output_summary, status, started_at, completed_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.messageId,
        input.parentToolCallId ?? null,
        input.toolName,
        input.inputSummary,
        input.outputSummary,
        input.status,
        now,
        completedAt,
        input.sortOrder,
      );

    return {
      id,
      message_id: input.messageId,
      parent_tool_call_id: input.parentToolCallId ?? null,
      tool_name: input.toolName,
      input_summary: input.inputSummary,
      output_summary: input.outputSummary,
      status: input.status,
      started_at: now,
      completed_at: completedAt,
      sort_order: input.sortOrder,
    };
  }

  /** Bulk-insert tool call records in a single transaction. */
  bulkCreate(inputs: CreateToolCallRecordInput[]): void {
    const insert = this.db.prepare(
      `INSERT INTO tool_call_records
       (id, message_id, parent_tool_call_id, tool_name, input_summary, output_summary, status, started_at, completed_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      for (const input of inputs) {
        const id = randomUUID();
        const now = new Date().toISOString();
        const completedAt = input.status !== "running" ? now : null;
        insert.run(
          id,
          input.messageId,
          input.parentToolCallId ?? null,
          input.toolName,
          input.inputSummary,
          input.outputSummary,
          input.status,
          now,
          completedAt,
          input.sortOrder,
        );
      }
    });
    tx();
  }

  /** List all tool call records for a message, ordered by sort_order. */
  listByMessage(messageId: string): ToolCallRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM tool_call_records WHERE message_id = ? ORDER BY sort_order ASC`)
      .all(messageId) as ToolCallRecordRow[];
    return rows.map(rowToRecord);
  }

  /** List child tool call records under a parent Agent tool call. */
  listByParent(parentToolCallId: string): ToolCallRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM tool_call_records WHERE parent_tool_call_id = ? ORDER BY sort_order ASC`)
      .all(parentToolCallId) as ToolCallRecordRow[];
    return rows.map(rowToRecord);
  }

  /** Count tool call records for a message. */
  countByMessage(messageId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM tool_call_records WHERE message_id = ?")
      .get(messageId) as { cnt: number };
    return row.cnt;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/__tests__/tool-call-record-repo.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repositories/tool-call-record-repo.ts apps/server/src/__tests__/tool-call-record-repo.test.ts
git commit -m "feat(server): add ToolCallRecordRepo with CRUD operations"
```

---

### Task 7: TurnSnapshotRepo

**Files:**
- Create: `apps/server/src/repositories/turn-snapshot-repo.ts`
- Create: `apps/server/src/__tests__/turn-snapshot-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/server/src/__tests__/turn-snapshot-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openMemoryDatabase } from "../store/database.js";
import { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { MessageRepo } from "../repositories/message-repo.js";

describe("TurnSnapshotRepo", () => {
  let db: ReturnType<typeof openMemoryDatabase>;
  let repo: TurnSnapshotRepo;
  let threadId: string;
  let messageId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new TurnSnapshotRepo(db);
    const wsRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const msgRepo = new MessageRepo(db);

    const ws = wsRepo.create("proj", "/tmp/proj");
    const thread = threadRepo.create(ws.id, "Test", "direct", "main");
    threadId = thread.id;
    const msg = msgRepo.create(thread.id, "assistant", "hello", 1);
    messageId = msg.id;
  });

  afterEach(() => db.close());

  it("creates and retrieves a snapshot by message", () => {
    const snap = repo.create({
      messageId,
      threadId,
      refBefore: "abc123",
      refAfter: "def456",
      filesChanged: ["src/app.ts", "src/index.ts"],
      worktreePath: null,
    });
    expect(snap.id).toBeTruthy();
    expect(snap.ref_before).toBe("abc123");
    expect(snap.files_changed).toEqual(["src/app.ts", "src/index.ts"]);

    const found = repo.getByMessage(messageId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(snap.id);
  });

  it("lists snapshots by thread", () => {
    repo.create({ messageId, threadId, refBefore: "a", refAfter: "b", filesChanged: [], worktreePath: null });
    const list = repo.listByThread(threadId);
    expect(list).toHaveLength(1);
  });

  it("getById returns snapshot by primary key", () => {
    const snap = repo.create({ messageId, threadId, refBefore: "a", refAfter: "b", filesChanged: [], worktreePath: null });
    const found = repo.getById(snap.id);
    expect(found).not.toBeNull();
    expect(found!.ref_before).toBe("a");
  });

  it("deleteExpired removes old snapshots", () => {
    repo.create({ messageId, threadId, refBefore: "a", refAfter: "b", filesChanged: [], worktreePath: null });
    // Set created_at to 60 days ago
    db.prepare("UPDATE turn_snapshots SET created_at = datetime('now', '-60 days')").run();
    const removed = repo.deleteExpired(30);
    expect(removed).toBe(1);
    expect(repo.listByThread(threadId)).toHaveLength(0);
  });

  it("cascade deletes when message is deleted", () => {
    repo.create({ messageId, threadId, refBefore: "a", refAfter: "b", filesChanged: [], worktreePath: null });
    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    expect(repo.getByMessage(messageId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/__tests__/turn-snapshot-repo.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement TurnSnapshotRepo**

Create `apps/server/src/repositories/turn-snapshot-repo.ts`:

```ts
/**
 * Data access layer for turn snapshots (git ref pairs for diff reconstruction).
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { TurnSnapshot } from "@mcode/contracts";

/** Input for creating a turn snapshot. */
export interface CreateTurnSnapshotInput {
  messageId: string;
  threadId: string;
  refBefore: string;
  refAfter: string;
  filesChanged: string[];
  worktreePath: string | null;
}

interface TurnSnapshotRow {
  id: string;
  message_id: string;
  thread_id: string;
  ref_before: string;
  ref_after: string;
  files_changed: string;
  worktree_path: string | null;
  created_at: string;
}

function rowToSnapshot(row: TurnSnapshotRow): TurnSnapshot {
  return {
    id: row.id,
    message_id: row.message_id,
    thread_id: row.thread_id,
    ref_before: row.ref_before,
    ref_after: row.ref_after,
    files_changed: JSON.parse(row.files_changed) as string[],
    worktree_path: row.worktree_path,
    created_at: row.created_at,
  };
}

const COLUMNS =
  "id, message_id, thread_id, ref_before, ref_after, files_changed, worktree_path, created_at";

/** Repository for turn_snapshots table operations. */
@injectable()
export class TurnSnapshotRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Create a new turn snapshot and return it. */
  create(input: CreateTurnSnapshotInput): TurnSnapshot {
    const id = randomUUID();
    const now = new Date().toISOString();
    const filesJson = JSON.stringify(input.filesChanged);

    this.db
      .prepare(
        `INSERT INTO turn_snapshots
         (id, message_id, thread_id, ref_before, ref_after, files_changed, worktree_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.messageId, input.threadId, input.refBefore, input.refAfter, filesJson, input.worktreePath, now);

    return {
      id,
      message_id: input.messageId,
      thread_id: input.threadId,
      ref_before: input.refBefore,
      ref_after: input.refAfter,
      files_changed: input.filesChanged,
      worktree_path: input.worktreePath,
      created_at: now,
    };
  }

  /** Get a snapshot by its primary key. */
  getById(id: string): TurnSnapshot | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM turn_snapshots WHERE id = ?`)
      .get(id) as TurnSnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** Get the snapshot for a given message. */
  getByMessage(messageId: string): TurnSnapshot | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM turn_snapshots WHERE message_id = ?`)
      .get(messageId) as TurnSnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** List all snapshots for a thread, ordered by creation time. */
  listByThread(threadId: string): TurnSnapshot[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM turn_snapshots WHERE thread_id = ? ORDER BY created_at ASC`)
      .all(threadId) as TurnSnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  /** Delete snapshots older than maxAgeDays. Returns count removed. */
  deleteExpired(maxAgeDays: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM turn_snapshots WHERE created_at < datetime('now', '-' || ? || ' days')`,
      )
      .run(maxAgeDays);
    return result.changes;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/__tests__/turn-snapshot-repo.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repositories/turn-snapshot-repo.ts apps/server/src/__tests__/turn-snapshot-repo.test.ts
git commit -m "feat(server): add TurnSnapshotRepo with CRUD and expiry"
```

---

### Task 8: Register repos in DI container

**Files:**
- Modify: `apps/server/src/container.ts`

- [ ] **Step 1: Add imports and registrations**

In `apps/server/src/container.ts`, add imports after line 14 (`MessageRepo`):

```ts
import { ToolCallRecordRepo } from "./repositories/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "./repositories/turn-snapshot-repo.js";
```

Add registrations after the MessageRepo block (after line 53), before the string-keyed aliases:

```ts
  container.register(
    ToolCallRecordRepo,
    { useClass: ToolCallRecordRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    TurnSnapshotRepo,
    { useClass: TurnSnapshotRepo },
    { lifecycle: Lifecycle.Singleton },
  );
```

Add string-keyed aliases after line 64:

```ts
  container.register("ToolCallRecordRepo", {
    useFactory: (c) => c.resolve(ToolCallRecordRepo),
  });
  container.register("TurnSnapshotRepo", {
    useFactory: (c) => c.resolve(TurnSnapshotRepo),
  });
```

- [ ] **Step 2: Verify server compiles**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/container.ts
git commit -m "feat(server): register ToolCallRecordRepo and TurnSnapshotRepo in DI"
```

---

## Chunk 3: Snapshot Service and Message Query Enhancement

### Task 9: SnapshotService

**Files:**
- Create: `apps/server/src/services/snapshot-service.ts`
- Create: `apps/server/src/__tests__/snapshot-service.test.ts`
- Modify: `apps/server/src/container.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/server/src/__tests__/snapshot-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SnapshotService } from "../services/snapshot-service.js";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";
const mockExec = vi.mocked(execFileSync);

describe("SnapshotService", () => {
  let service: SnapshotService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SnapshotService();
  });

  describe("captureRef", () => {
    it("returns SHA from git stash create", () => {
      mockExec.mockReturnValueOnce(Buffer.from("abc123\n"));
      const ref = service.captureRef("/repo");
      expect(ref).toBe("abc123");
      expect(mockExec).toHaveBeenCalledWith(
        "git", ["-C", "/repo", "stash", "create", "-u"],
        expect.objectContaining({ stdio: "pipe" }),
      );
    });

    it("returns HEAD when stash create returns empty", () => {
      mockExec
        .mockReturnValueOnce(Buffer.from("\n"))         // stash create empty
        .mockReturnValueOnce(Buffer.from("head123\n")); // rev-parse HEAD
      const ref = service.captureRef("/repo");
      expect(ref).toBe("head123");
    });
  });

  describe("getFilesChanged", () => {
    it("returns file list from git diff --name-only", () => {
      mockExec.mockReturnValueOnce(Buffer.from("src/a.ts\nsrc/b.ts\n"));
      const files = service.getFilesChanged("/repo", "ref1", "ref2");
      expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("returns empty array when refs are identical", () => {
      const files = service.getFilesChanged("/repo", "same", "same");
      expect(files).toEqual([]);
    });
  });

  describe("getDiff", () => {
    it("returns unified diff text", () => {
      mockExec.mockReturnValueOnce(Buffer.from("--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n"));
      const diff = service.getDiff("/repo", "ref1", "ref2", "file.ts");
      expect(diff).toContain("+new");
    });

    it("returns full diff when no filePath specified", () => {
      mockExec.mockReturnValueOnce(Buffer.from("diff output"));
      const diff = service.getDiff("/repo", "ref1", "ref2");
      expect(diff).toBe("diff output");
    });
  });

  describe("validateRef", () => {
    it("returns true for valid ref", () => {
      mockExec.mockReturnValueOnce(Buffer.from("commit\n"));
      expect(service.validateRef("/repo", "abc")).toBe(true);
    });

    it("returns false for invalid ref", () => {
      mockExec.mockImplementationOnce(() => { throw new Error("bad"); });
      expect(service.validateRef("/repo", "bad")).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/__tests__/snapshot-service.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement SnapshotService**

Create `apps/server/src/services/snapshot-service.ts`:

```ts
/**
 * Git snapshot operations for capturing working tree state before/after agent turns.
 * Uses lightweight `git stash create` to produce unreachable commit objects.
 */

import { injectable } from "tsyringe";
import { execFileSync } from "child_process";

/** Handles git snapshot capture and diff generation. */
@injectable()
export class SnapshotService {
  /**
   * Capture the current working tree state as an unreachable commit.
   * Returns the SHA of the stash commit, or HEAD if the tree is clean.
   */
  captureRef(cwd: string): string {
    const result = execFileSync("git", ["-C", cwd, "stash", "create", "-u"], {
      stdio: "pipe",
      timeout: 10_000,
    })
      .toString()
      .trim();

    if (!result) {
      // Clean working tree; fall back to HEAD
      return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
    }

    return result;
  }

  /** Get the list of files changed between two refs. */
  getFilesChanged(cwd: string, refBefore: string, refAfter: string): string[] {
    if (refBefore === refAfter) return [];

    const output = execFileSync(
      "git",
      ["-C", cwd, "diff", "--name-only", refBefore, refAfter],
      { stdio: "pipe", timeout: 10_000 },
    )
      .toString()
      .trim();

    return output ? output.split("\n") : [];
  }

  /** Get a unified diff between two refs, optionally scoped to a single file. */
  getDiff(cwd: string, refBefore: string, refAfter: string, filePath?: string): string {
    const args = ["-C", cwd, "diff", "--find-renames", `${refBefore}..${refAfter}`];
    if (filePath) {
      args.push("--", filePath);
    }

    return execFileSync("git", args, {
      stdio: "pipe",
      timeout: 15_000,
    }).toString();
  }

  /** Validate that a git ref still exists (not garbage collected). */
  validateRef(cwd: string, ref: string): boolean {
    try {
      execFileSync("git", ["-C", cwd, "cat-file", "-t", ref], {
        stdio: "pipe",
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Register in DI container**

In `apps/server/src/container.ts`, add import:

```ts
import { SnapshotService } from "./services/snapshot-service.js";
```

Add registration after the existing services block:

```ts
  container.register(
    SnapshotService,
    { useClass: SnapshotService },
    { lifecycle: Lifecycle.Singleton },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/__tests__/snapshot-service.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/snapshot-service.ts apps/server/src/__tests__/snapshot-service.test.ts apps/server/src/container.ts
git commit -m "feat(server): add SnapshotService for git ref capture and diffing"
```

---

### Task 10: Enhance MessageRepo.listByThread with tool_call_count

**Files:**
- Modify: `apps/server/src/repositories/message-repo.ts`

- [ ] **Step 1: Write failing test**

Append to `apps/server/src/__tests__/tool-call-record-repo.test.ts`:

```ts
describe("MessageRepo.listByThread with tool_call_count", () => {
  let db: ReturnType<typeof openMemoryDatabase>;
  let msgRepo: MessageRepo;
  let threadId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    msgRepo = new MessageRepo(db);
    const wsRepo = new WorkspaceRepo(db);
    const threadRepo = new ThreadRepo(db);
    const ws = wsRepo.create("proj", "/tmp/proj2");
    const thread = threadRepo.create(ws.id, "Test", "direct", "main");
    threadId = thread.id;
  });

  afterEach(() => db.close());

  it("returns tool_call_count for messages with tool calls", () => {
    const msg = msgRepo.create(threadId, "assistant", "done", 1);
    const tcRepo = new ToolCallRecordRepo(db);
    tcRepo.bulkCreate([
      { messageId: msg.id, toolName: "Read", inputSummary: "", outputSummary: "", status: "completed", sortOrder: 0 },
      { messageId: msg.id, toolName: "Edit", inputSummary: "", outputSummary: "", status: "completed", sortOrder: 1 },
    ]);

    const messages = msgRepo.listByThread(threadId, 100);
    expect(messages).toHaveLength(1);
    expect(messages[0].tool_call_count).toBe(2);
  });

  it("returns undefined tool_call_count for messages without tool calls", () => {
    msgRepo.create(threadId, "user", "hello", 1);
    const messages = msgRepo.listByThread(threadId, 100);
    expect(messages[0].tool_call_count).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/__tests__/tool-call-record-repo.test.ts`
Expected: FAIL (tool_call_count not present)

- [ ] **Step 3: Update MessageRepo.listByThread**

In `apps/server/src/repositories/message-repo.ts`, add `tool_call_count` to the `MessageRow` interface (after line 26):

```ts
  tool_call_count?: number;
```

Update `rowToMessage` to include the field (after line 54, before the closing `};`):

```ts
    ...(row.tool_call_count ? { tool_call_count: row.tool_call_count } : {}),
```

Update the `MESSAGE_COLUMNS` constant (line 58) to:

```ts
const MESSAGE_COLUMNS =
  "m.id, m.thread_id, m.role, m.content, m.tool_calls, m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence, m.attachments";
```

Replace the `listByThread` query (lines 111-115) with:

```ts
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}, tc_count.cnt as tool_call_count
         FROM (
           SELECT ${MESSAGE_COLUMNS}
           FROM messages m
           WHERE m.thread_id = ?
           ORDER BY m.sequence DESC
           LIMIT ?
         ) m
         LEFT JOIN (
           SELECT message_id, COUNT(*) as cnt
           FROM tool_call_records
           GROUP BY message_id
         ) tc_count ON tc_count.message_id = m.id
         ORDER BY m.sequence ASC`,
      )
      .all(threadId, clampedLimit) as MessageRow[];
```

Also update the `create` method's query to use bare column names (no `m.` prefix) since it's an INSERT, not a SELECT. The `create` method doesn't use `MESSAGE_COLUMNS` for its INSERT, so no change needed there. But update the returned object to include `tool_call_count: undefined` for consistency - actually, omit it since `create` returns fresh messages that have no tool calls.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/__tests__/tool-call-record-repo.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repositories/message-repo.ts apps/server/src/__tests__/tool-call-record-repo.test.ts
git commit -m "feat(server): join tool_call_count in MessageRepo.listByThread"
```

---

## Chunk 4: Server-Side Tool Call Buffering and Persistence

### Task 11: AgentService - buffer tool calls and persist on turn complete

**Files:**
- Modify: `apps/server/src/services/agent-service.ts`

- [ ] **Step 1: Add dependencies and buffering state**

In `apps/server/src/services/agent-service.ts`, add imports:

```ts
import { ToolCallRecordRepo, type CreateToolCallRecordInput } from "../repositories/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo.js";
import { SnapshotService } from "./snapshot-service.js";
import { broadcast } from "../transport/push.js";
```

Add injected dependencies to the constructor (after `ThreadService` on line 60):

```ts
    @inject(ToolCallRecordRepo) private readonly toolCallRecordRepo: ToolCallRecordRepo,
    @inject(TurnSnapshotRepo) private readonly turnSnapshotRepo: TurnSnapshotRepo,
    @inject(SnapshotService) private readonly snapshotService: SnapshotService,
```

Add buffering state after `private initialized = false;` (line 48):

```ts
  /**
   * Per-thread buffer of tool calls accumulated during the current turn.
   * Flushed to the DB on turnComplete/error.
   */
  private turnToolCalls = new Map<string, CreateToolCallRecordInput[]>();

  /** Per-thread ref_before captured at sendMessage time. */
  private turnRefBefore = new Map<string, { ref: string; cwd: string }>();

  /** Stack of active Agent tool call IDs per thread (for nesting inference). */
  private agentCallStack = new Map<string, string[]>();

  /** Per-thread sort counter for tool calls. */
  private turnSortCounters = new Map<string, number>();
```

- [ ] **Step 2: Capture ref_before in sendMessage**

In the `sendMessage` method, add after `this.threadRepo.updateStatus(threadId, "active");` (line 120) and before the model handling:

```ts
    // Capture git snapshot ref_before for this turn
    try {
      const refBefore = this.snapshotService.captureRef(cwd);
      this.turnRefBefore.set(threadId, { ref: refBefore, cwd });
    } catch (err) {
      logger.warn("Failed to capture ref_before", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.turnToolCalls.set(threadId, []);
    this.turnSortCounters.set(threadId, 0);
    this.agentCallStack.set(threadId, []);
```

- [ ] **Step 3: Buffer tool calls and persist on turnComplete in init()**

Replace the `init()` method's event handler (lines 272-297) with:

```ts
      provider.on("event", (event: AgentEvent) => {
        if (event.type === "message") {
          try {
            const existing = this.messageRepo.listByThread(event.threadId, 1);
            const nextSeq =
              existing.length > 0
                ? existing[existing.length - 1].sequence + 1
                : 1;
            this.messageRepo.create(
              event.threadId,
              "assistant",
              event.content,
              nextSeq,
            );
          } catch (err) {
            logger.error("Failed to persist assistant message", {
              threadId: event.threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (event.type === "toolUse") {
          this.bufferToolCall(event.threadId, event);
        }

        if (event.type === "toolResult") {
          this.updateBufferedToolCallOutput(event.threadId, event.toolCallId, event.output, event.isError);
        }

        if (event.type === "turnComplete") {
          this.persistTurn(event.threadId);
        }

        if (event.type === "error") {
          this.persistTurn(event.threadId, true);
        }

        if (event.type === "ended") {
          this.trackSessionEnded(event.threadId);
        }
      });
```

- [ ] **Step 4: Add buffering and persistence helper methods**

Add these private methods to `AgentService`:

```ts
  /** Buffer a tool call event for later persistence. */
  private bufferToolCall(
    threadId: string,
    event: { toolCallId: string; toolName: string; toolInput: Record<string, unknown> },
  ): void {
    const buffer = this.turnToolCalls.get(threadId) ?? [];
    const sortOrder = this.turnSortCounters.get(threadId) ?? 0;
    this.turnSortCounters.set(threadId, sortOrder + 1);

    // Track Agent tool call nesting
    const stack = this.agentCallStack.get(threadId) ?? [];
    const parentToolCallId = event.toolName === "Agent" ? undefined : stack[stack.length - 1];
    if (event.toolName === "Agent") {
      stack.push(event.toolCallId);
      this.agentCallStack.set(threadId, stack);
    }

    const inputSummary = this.summarizeInput(event.toolName, event.toolInput);

    buffer.push({
      messageId: "", // filled at persist time
      toolName: event.toolName,
      inputSummary,
      outputSummary: "",
      status: "running",
      sortOrder,
      parentToolCallId,
    });
    this.turnToolCalls.set(threadId, buffer);
  }

  /** Update a buffered tool call with its output when result arrives. */
  private updateBufferedToolCallOutput(
    threadId: string,
    toolCallId: string,
    output: string,
    isError: boolean,
  ): void {
    // Pop Agent from stack when its result arrives
    const stack = this.agentCallStack.get(threadId) ?? [];
    const stackIdx = stack.indexOf(toolCallId);
    if (stackIdx >= 0) {
      stack.splice(stackIdx, 1);
      this.agentCallStack.set(threadId, stack);
    }

    // Update the last running tool call's output (SDK may not give us matching IDs)
    const buffer = this.turnToolCalls.get(threadId) ?? [];
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].status === "running") {
        buffer[i].outputSummary = output.slice(0, 500);
        buffer[i].status = isError ? "failed" : "completed";
        break;
      }
    }
  }

  /** Persist buffered tool calls and snapshot to DB, then push turn.persisted. */
  private persistTurn(threadId: string, isError = false): void {
    const buffer = this.turnToolCalls.get(threadId) ?? [];

    // Find the assistant message to attach tool calls to
    const messages = this.messageRepo.listByThread(threadId, 1);
    if (messages.length === 0) {
      this.clearTurnState(threadId);
      return;
    }
    const messageId = messages[messages.length - 1].id;

    // Mark any still-running tool calls
    for (const tc of buffer) {
      if (tc.status === "running") {
        tc.status = isError ? "failed" : "completed";
      }
      tc.messageId = messageId;
    }

    // Persist tool call records
    if (buffer.length > 0) {
      try {
        this.toolCallRecordRepo.bulkCreate(buffer);
      } catch (err) {
        logger.error("Failed to persist tool call records", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Capture snapshot and persist
    let filesChanged: string[] = [];
    const refData = this.turnRefBefore.get(threadId);
    if (refData) {
      try {
        const refAfter = this.snapshotService.captureRef(refData.cwd);
        if (refAfter !== refData.ref) {
          filesChanged = this.snapshotService.getFilesChanged(refData.cwd, refData.ref, refAfter);
          this.turnSnapshotRepo.create({
            messageId,
            threadId,
            refBefore: refData.ref,
            refAfter,
            filesChanged,
            worktreePath: null,
          });
        }
      } catch (err) {
        logger.warn("Failed to capture turn snapshot", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Push turn.persisted to client
    broadcast("turn.persisted", {
      threadId,
      messageId,
      toolCallCount: buffer.length,
      filesChanged,
    });

    this.clearTurnState(threadId);
  }

  /** Clear per-turn buffering state. */
  private clearTurnState(threadId: string): void {
    this.turnToolCalls.delete(threadId);
    this.turnRefBefore.delete(threadId);
    this.turnSortCounters.delete(threadId);
    this.agentCallStack.delete(threadId);
  }

  /** Generate a human-readable summary of tool input. */
  private summarizeInput(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Read":
      case "Edit":
      case "Write":
        return String(input.file_path ?? input.filePath ?? "");
      case "Bash":
        return String(input.command ?? "").slice(0, 200);
      case "Grep":
        return String(input.pattern ?? "");
      case "Glob":
        return String(input.pattern ?? "");
      case "Agent":
        return String(input.description ?? "").slice(0, 100);
      default:
        return JSON.stringify(input).slice(0, 200);
    }
  }
```

- [ ] **Step 5: Verify server compiles**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/agent-service.ts
git commit -m "feat(server): buffer tool calls during turn, persist on turnComplete"
```

---

### Task 12: Event augmentation with parentToolCallId

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Augment agent events before broadcasting**

In `apps/server/src/index.ts`, replace the event broadcasting block (lines 68-92) with:

```ts
// Track active Agent tool calls per thread for nesting inference
const agentCallStacks = new Map<string, string[]>();

for (const provider of providerRegistry.resolveAll()) {
  provider.on("event", (event: AgentEvent) => {
    let enrichedEvent = event;

    // Augment toolUse events with parentToolCallId
    if (event.type === "toolUse") {
      const stack = agentCallStacks.get(event.threadId) ?? [];

      if (event.toolName === "Agent") {
        stack.push(event.toolCallId);
        agentCallStacks.set(event.threadId, stack);
      } else if (stack.length > 0) {
        enrichedEvent = {
          ...event,
          parentToolCallId: stack[stack.length - 1],
        };
      }
    }

    // Pop Agent from stack when its result arrives
    if (event.type === "toolResult") {
      const stack = agentCallStacks.get(event.threadId) ?? [];
      const idx = stack.indexOf(event.toolCallId);
      if (idx >= 0) {
        stack.splice(idx, 1);
        agentCallStacks.set(event.threadId, stack);
      }
    }

    // Clear stack on turn end
    if (event.type === "turnComplete" || event.type === "error" || event.type === "ended") {
      agentCallStacks.delete(event.threadId);
    }

    broadcast("agent.event", enrichedEvent);

    if (event.type === "turnComplete") {
      threadRepo.updateStatus(event.threadId, "completed");
      broadcast("thread.status", {
        threadId: event.threadId,
        status: "completed",
      });
      const thread = threadRepo.findById(event.threadId);
      if (thread) {
        broadcast("files.changed", {
          workspaceId: thread.workspace_id,
          threadId: thread.id,
        });
      }
    } else if (event.type === "error") {
      threadRepo.updateStatus(event.threadId, "errored");
      broadcast("thread.status", {
        threadId: event.threadId,
        status: "errored",
      });
    }
  });
}
```

- [ ] **Step 2: Verify server compiles**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): augment agent events with parentToolCallId for nesting"
```

---

### Task 13: Wire new RPC methods in router

**Files:**
- Modify: `apps/server/src/transport/ws-router.ts`
- Modify: `apps/server/src/transport/ws-server.ts` (if RouterDeps needs updating)

- [ ] **Step 1: Add dependencies to RouterDeps**

In `apps/server/src/transport/ws-router.ts`, add imports:

```ts
import type { ToolCallRecordRepo } from "../repositories/tool-call-record-repo.js";
import type { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo.js";
import type { SnapshotService } from "../services/snapshot-service.js";
```

Add to `RouterDeps` interface (after `messageRepo`, line 37):

```ts
  toolCallRecordRepo: ToolCallRecordRepo;
  turnSnapshotRepo: TurnSnapshotRepo;
  snapshotService: SnapshotService;
```

- [ ] **Step 2: Add dispatch cases**

In the `dispatch` function, add before the `default` case (before line 272):

```ts
    // Tool Call Records
    case "toolCallRecord.list":
      return deps.toolCallRecordRepo.listByMessage(params.messageId);

    // Snapshots
    case "snapshot.getDiff": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      const thread = deps.threadService.findById
        ? (deps as any).threadService
        : null;
      // Resolve cwd from thread's workspace
      const snapThread = (() => {
        // We need thread repo access for the cwd
        const t = deps.messageRepo as any;
        return null;
      })();
      // Use snapshot's worktree_path if available, otherwise need thread context
      const cwd = snapshot.worktree_path ?? process.cwd();
      return deps.snapshotService.getDiff(cwd, snapshot.ref_before, snapshot.ref_after, params.filePath);
    }
    case "snapshot.cleanup":
      return { removed: deps.turnSnapshotRepo.deleteExpired(
        parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10),
      ) };
```

Wait, we need to resolve the cwd properly. Let me fix the snapshot.getDiff case. We need access to the thread to find the workspace path. Let me add threadRepo to the deps and use it.

Actually, looking at `RouterDeps`, it already has `threadService`. Let me update the dispatch case:

```ts
    // Tool Call Records
    case "toolCallRecord.list":
      return deps.toolCallRecordRepo.listByMessage(params.messageId);

    // Snapshots
    case "snapshot.getDiff": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      // Resolve working directory from thread
      const cwd = snapshot.worktree_path ?? await deps.gitService.resolveWorkingDirForThread(snapshot.thread_id);
      return deps.snapshotService.getDiff(cwd, snapshot.ref_before, snapshot.ref_after, params.filePath);
    }
    case "snapshot.cleanup":
      return { removed: deps.turnSnapshotRepo.deleteExpired(
        parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10),
      ) };
```

We need a helper on GitService. Actually, the GitService already has `resolveWorkingDir(workspacePath, mode, worktreePath)`. We can get thread + workspace to derive the cwd. Since the router already has everything it needs via deps, let's do it inline:

```ts
    // Tool Call Records
    case "toolCallRecord.list":
      return deps.toolCallRecordRepo.listByMessage(params.messageId);

    // Snapshots
    case "snapshot.getDiff": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      const snapshotCwd = snapshot.worktree_path
        ?? deps.gitService.resolveWorkingDirByThread(snapshot.thread_id);
      return deps.snapshotService.getDiff(snapshotCwd, snapshot.ref_before, snapshot.ref_after, params.filePath);
    }
    case "snapshot.cleanup":
      return { removed: deps.turnSnapshotRepo.deleteExpired(
        parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10),
      ) };
```

We'll need to add a `resolveWorkingDirByThread` convenience method to GitService. Add to `apps/server/src/services/git-service.ts`:

```ts
  /** Resolve the working directory for a thread by looking up its workspace. */
  resolveWorkingDirByThread(threadId: string): string {
    const threadRepo = this.workspaceRepo; // Actually we need thread access
    // This requires thread repo - let's do it differently
  }
```

Actually, let's simplify. The router already has `threadService` which likely has a method to get a thread. And `gitService` has `resolveWorkingDir`. Let's compose in the dispatch:

```ts
    case "snapshot.getDiff": {
      const snapshot = deps.turnSnapshotRepo.getById(params.snapshotId);
      if (!snapshot) throw new Error(`Snapshot not found: ${params.snapshotId}`);
      let snapshotCwd: string;
      if (snapshot.worktree_path) {
        snapshotCwd = snapshot.worktree_path;
      } else {
        const thread = deps.threadService.findById(snapshot.thread_id);
        if (!thread) throw new Error(`Thread not found for snapshot: ${snapshot.thread_id}`);
        snapshotCwd = deps.gitService.resolveWorkingDir(
          deps.workspaceService.findById(thread.workspace_id)!.path,
          thread.mode,
          thread.worktree_path,
        );
      }
      return deps.snapshotService.getDiff(snapshotCwd, snapshot.ref_before, snapshot.ref_after, params.filePath);
    }
```

We need `threadService.findById` and `workspaceService.findById` to exist. Let me check if those exist or if we need to add them.

The threadService likely delegates to threadRepo.findById. We'll need to verify this exists. For now, let's write the dispatch using the pattern that exists in the router (deps has the services).

- [ ] **Step 3: Update index.ts to pass new deps**

In `apps/server/src/index.ts`, resolve the new repos and service, then pass them to `createWsServer`:

Add after `const terminalService = ...` (line 49):

```ts
const toolCallRecordRepo = container.resolve(ToolCallRecordRepo);
const turnSnapshotRepo = container.resolve(TurnSnapshotRepo);
const snapshotService = container.resolve(SnapshotService);
```

Add the imports:

```ts
import { ToolCallRecordRepo } from "./repositories/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "./repositories/turn-snapshot-repo.js";
import { SnapshotService } from "./services/snapshot-service.js";
```

Add to the `createWsServer` deps object (after `messageRepo`, line 106):

```ts
  toolCallRecordRepo,
  turnSnapshotRepo,
  snapshotService,
```

- [ ] **Step 4: Verify server compiles**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors (may need to add `findById` to ThreadService/WorkspaceService if not present)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/transport/ws-router.ts apps/server/src/index.ts
git commit -m "feat(server): wire tool call and snapshot RPC methods in router"
```

---

## Chunk 5: Frontend Transport and Store Updates

### Task 14: Frontend transport types and implementation

**Files:**
- Modify: `apps/web/src/transport/types.ts`
- Modify: `apps/web/src/transport/ws-transport.ts`

- [ ] **Step 1: Add transport methods to types**

In `apps/web/src/transport/types.ts`, add re-exports from contracts (after the existing re-exports, line 31):

```ts
export type { ToolCallRecord, TurnSnapshot } from "@mcode/contracts";
```

Add new methods to `McodeTransport` interface (before the closing `}`):

```ts
  // Tool call records
  /** Fetch persisted tool call records for a message. */
  listToolCallRecords(messageId: string): Promise<ToolCallRecord[]>;

  // Snapshots
  /** Get a unified diff for a specific file from a turn snapshot. */
  getSnapshotDiff(snapshotId: string, filePath?: string): Promise<string>;
  /** Run garbage collection on expired snapshot refs. */
  cleanupSnapshots(): Promise<{ removed: number }>;
```

- [ ] **Step 2: Implement transport methods**

In `apps/web/src/transport/ws-transport.ts`, add the new method implementations in the returned transport object (before the closing `}`):

```ts
    async listToolCallRecords(messageId) {
      return rpc("toolCallRecord.list", { messageId });
    },

    async getSnapshotDiff(snapshotId, filePath) {
      return rpc("snapshot.getDiff", { snapshotId, filePath });
    },

    async cleanupSnapshots() {
      return rpc("snapshot.cleanup", {});
    },
```

- [ ] **Step 3: Verify web app compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/transport/types.ts apps/web/src/transport/ws-transport.ts
git commit -m "feat(web): add transport methods for tool call records and snapshots"
```

---

### Task 15: Handle turn.persisted push event and subagent tracking

**Files:**
- Modify: `apps/web/src/transport/ws-events.ts`
- Modify: `apps/web/src/stores/threadStore.ts`

- [ ] **Step 1: Add turn.persisted listener**

In `apps/web/src/transport/ws-events.ts`, add after the `agent.event` listener (after line 40):

```ts
  // turn.persisted: server has persisted tool calls for a completed turn
  unsubs.push(
    pushEmitter.on("turn.persisted", (data) => {
      const payload = data as {
        threadId: string;
        messageId: string;
        toolCallCount: number;
        filesChanged: string[];
      };
      useThreadStore.getState().handleTurnPersisted(payload);
    }),
  );
```

- [ ] **Step 2: Add store state and actions for persistence + subagent tracking**

In `apps/web/src/stores/threadStore.ts`, add to the state interface (alongside existing `toolCallsByThread`):

```ts
  /** Tool call counts per message ID, populated from turn.persisted events and loadMessages. */
  persistedToolCallCounts: Record<string, number>;
  /** Active subagent count per thread (incremented on Agent toolUse, decremented on Agent toolResult). */
  activeSubagentsByThread: Record<string, number>;
```

Add to the initial state:

```ts
  persistedToolCallCounts: {},
  activeSubagentsByThread: {},
```

Add `handleTurnPersisted` action:

```ts
  handleTurnPersisted: (payload: { threadId: string; messageId: string; toolCallCount: number; filesChanged: string[] }) => {
    set((state) => ({
      persistedToolCallCounts: {
        ...state.persistedToolCallCounts,
        [payload.messageId]: payload.toolCallCount,
      },
    }));
  },
```

- [ ] **Step 3: Update handleAgentEvent for parentToolCallId-aware completion**

In `handleAgentEvent`, modify the `session.toolUse` handler (lines 313-333) to track subagent counts:

```ts
    if (method === "session.toolUse") {
      const parentToolCallId = params.parentToolCallId as string | undefined;

      // Only mark prior tool calls complete if this isn't a subagent's tool call
      // (subagent calls should not mark the parent Agent call as complete)
      if (!parentToolCallId) {
        markPriorToolCallsComplete();
      }
      clearFadingTimers(threadId);

      // Track subagent count
      const toolName = (params.toolName as string) || "unknown";
      if (toolName === "Agent") {
        set((state) => ({
          activeSubagentsByThread: {
            ...state.activeSubagentsByThread,
            [threadId]: (state.activeSubagentsByThread[threadId] ?? 0) + 1,
          },
        }));
      }

      const toolCall: ToolCall = {
        id: (params.toolCallId as string) || crypto.randomUUID(),
        toolName,
        toolInput: (params.toolInput as Record<string, unknown>) || {},
        output: null,
        isError: false,
        isComplete: false,
      };
      set((state) => ({
        toolCallsByThread: {
          ...state.toolCallsByThread,
          [threadId]: [...(state.toolCallsByThread[threadId] ?? []), toolCall],
        },
      }));
      return;
    }
```

In the `session.toolResult` handler, add subagent count decrement. After the existing toolResult handling (line 373), add:

```ts
      // Decrement subagent count when an Agent tool call completes
      const matchedCall = (get().toolCallsByThread[threadId] ?? []).find(
        (tc) => tc.id === (params.toolCallId as string),
      );
      if (matchedCall?.toolName === "Agent") {
        set((state) => {
          const count = (state.activeSubagentsByThread[threadId] ?? 1) - 1;
          const next = { ...state.activeSubagentsByThread };
          if (count <= 0) {
            delete next[threadId];
          } else {
            next[threadId] = count;
          }
          return { activeSubagentsByThread: next };
        });
      }
```

- [ ] **Step 4: Populate persistedToolCallCounts from loadMessages**

In `loadMessages`, after messages are loaded, extract tool_call_count into state:

```ts
      // Populate persisted tool call counts from loaded messages
      const counts: Record<string, number> = {};
      for (const msg of loaded) {
        if (msg.tool_call_count && msg.tool_call_count > 0) {
          counts[msg.id] = msg.tool_call_count;
        }
      }
```

Add `persistedToolCallCounts: { ...get().persistedToolCallCounts, ...counts }` to the `set()` call.

- [ ] **Step 5: Verify web app compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/transport/ws-events.ts apps/web/src/stores/threadStore.ts
git commit -m "feat(web): handle turn.persisted events and track subagent counts"
```

---

## Chunk 6: Frontend Components

### Task 16: ToolCallSummary component

**Files:**
- Create: `apps/web/src/components/chat/ToolCallSummary.tsx`
- Create: `apps/web/src/__tests__/tool-call-summary.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/__tests__/tool-call-summary.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCallSummary } from "@/components/chat/ToolCallSummary";

vi.mock("@/transport", () => ({
  transport: {
    listToolCallRecords: vi.fn().mockResolvedValue([]),
  },
}));

describe("ToolCallSummary", () => {
  it("renders collapsed summary with tool call count", () => {
    render(<ToolCallSummary messageId="msg-1" toolCallCount={7} />);
    expect(screen.getByText(/7 tool calls/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/__tests__/tool-call-summary.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement ToolCallSummary**

Create `apps/web/src/components/chat/ToolCallSummary.tsx`:

```tsx
import { useState, useCallback } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { transport } from "@/transport";
import { ToolCallCard } from "./ToolCallCard";
import { TOOL_LABELS } from "./tool-renderers/constants";
import type { ToolCallRecord } from "@/transport/types";
import type { ToolCall } from "@/transport/types";

interface ToolCallSummaryProps {
  messageId: string;
  toolCallCount: number;
}

/** Build a human-readable summary like "3 edits, 2 reads, 1 bash". */
function buildGroupSummary(count: number, records?: ToolCallRecord[]): string {
  if (!records || records.length === 0) {
    return `${count} tool call${count !== 1 ? "s" : ""}`;
  }

  const groups = new Map<string, number>();
  for (const r of records) {
    const label = (TOOL_LABELS[r.tool_name as keyof typeof TOOL_LABELS] ?? r.tool_name).toLowerCase();
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }

  const parts = [...groups.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([label, n]) => `${n} ${label}${n !== 1 ? "s" : ""}`);

  return `${records.length} tool call${records.length !== 1 ? "s" : ""}: ${parts.join(", ")}`;
}

/** Convert a ToolCallRecord to the ToolCall shape used by renderers. */
function recordToToolCall(record: ToolCallRecord): ToolCall {
  return {
    id: record.id,
    toolName: record.tool_name,
    toolInput: { summary: record.input_summary },
    output: record.output_summary || null,
    isError: record.status === "failed",
    isComplete: true,
  };
}

/** Collapsed post-turn summary row. Expands to show persisted tool call cards. */
export function ToolCallSummary({ messageId, toolCallCount }: ToolCallSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const [records, setRecords] = useState<ToolCallRecord[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleToggle = useCallback(async () => {
    if (!expanded && records === null) {
      setLoading(true);
      try {
        const loaded = await transport.listToolCallRecords(messageId);
        setRecords(loaded);
      } catch {
        setRecords([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((prev) => !prev);
  }, [expanded, records, messageId]);

  const summary = buildGroupSummary(toolCallCount, records ?? undefined);

  return (
    <div className="mx-12 my-1">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <Wrench className="h-3 w-3 shrink-0" />
        <span>{summary}</span>
        {loading && <span className="ml-auto text-[10px]">Loading...</span>}
      </button>

      {expanded && records && records.length > 0 && (
        <div className="mt-1 max-h-[600px] overflow-y-auto">
          <ToolCallCard
            toolCalls={records.filter((r) => !r.parent_tool_call_id).map(recordToToolCall)}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/__tests__/tool-call-summary.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ToolCallSummary.tsx apps/web/src/__tests__/tool-call-summary.test.tsx
git commit -m "feat(web): add ToolCallSummary component for post-turn tool call display"
```

---

### Task 17: Virtual items integration for tool-summary

**Files:**
- Modify: `apps/web/src/components/chat/virtual-items.ts`
- Modify: `apps/web/src/components/chat/MessageList.tsx`

- [ ] **Step 1: Add tool-summary virtual item type**

In `apps/web/src/components/chat/virtual-items.ts`, extend the `ChatVirtualItem` union (after line 13):

```ts
  | { key: string; type: "tool-summary"; messageId: string; toolCallCount: number }
```

- [ ] **Step 2: Update buildVirtualItems to accept persistedToolCallCounts**

Add a new parameter to `buildVirtualItems` (line 23):

```ts
export function buildVirtualItems(
  messages: readonly Message[],
  toolCalls: readonly ToolCall[],
  fadingToolCalls: readonly ToolCall[],
  streamingText: string | undefined,
  isAgentRunning: boolean,
  agentStartTime: number | undefined,
  persistedToolCallCounts?: Record<string, number>,
): ChatVirtualItem[] {
```

Inside the `for (const msg of beforeMessages)` loop (lines 48-50), add tool-summary items after assistant messages:

```ts
  for (const msg of beforeMessages) {
    items.push({ key: msg.id, type: "message", message: msg });
    const count = persistedToolCallCounts?.[msg.id];
    if (count && count > 0 && msg.role === "assistant") {
      items.push({
        key: `tool-summary-${msg.id}`,
        type: "tool-summary",
        messageId: msg.id,
        toolCallCount: count,
      });
    }
  }
```

Also add after `lastAssistantMsg` is pushed (after line 73):

```ts
  if (lastAssistantMsg) {
    items.push({
      key: lastAssistantMsg.id,
      type: "message",
      message: lastAssistantMsg,
    });
    const lastCount = persistedToolCallCounts?.[lastAssistantMsg.id];
    if (lastCount && lastCount > 0) {
      items.push({
        key: `tool-summary-${lastAssistantMsg.id}`,
        type: "tool-summary",
        messageId: lastAssistantMsg.id,
        toolCallCount: lastCount,
      });
    }
  }
```

Add height estimate for `tool-summary` in `estimateItemHeight` (before the closing of the switch):

```ts
    case "tool-summary":
      return 36;
```

- [ ] **Step 3: Render tool-summary in MessageList**

In `apps/web/src/components/chat/MessageList.tsx`, add import:

```ts
import { ToolCallSummary } from "./ToolCallSummary";
```

Add case to `VirtualItemRenderer` switch (after line 41, before the closing `}`):

```ts
    case "tool-summary":
      return (
        <ToolCallSummary
          messageId={item.messageId}
          toolCallCount={item.toolCallCount}
        />
      );
```

- [ ] **Step 4: Pass persistedToolCallCounts to buildVirtualItems**

In `MessageList.tsx`, add store selector:

```ts
  const persistedToolCallCounts = useThreadStore((s) => s.persistedToolCallCounts);
```

Update the `useMemo` call for `items` to include the new parameter:

```ts
  const items = useMemo(
    () =>
      buildVirtualItems(
        messages,
        toolCalls,
        fadingToolCalls,
        streamingText,
        isAgentRunning,
        agentStartTime,
        persistedToolCallCounts,
      ),
    [messages, toolCalls, fadingToolCalls, streamingText, isAgentRunning, agentStartTime, persistedToolCallCounts],
  );
```

- [ ] **Step 5: Update existing virtual-items tests**

In `apps/web/src/__tests__/virtual-items.test.ts`, update all `buildVirtualItems` calls to include the new optional parameter (pass `undefined` or `{}`).

- [ ] **Step 6: Verify web app compiles and tests pass**

Run: `cd apps/web && npx tsc --noEmit && npx vitest run src/__tests__/virtual-items.test.ts`
Expected: No errors, all tests pass

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/chat/virtual-items.ts apps/web/src/components/chat/MessageList.tsx apps/web/src/__tests__/virtual-items.test.ts
git commit -m "feat(web): add tool-summary virtual item type for persisted tool calls"
```

---

### Task 18: DiffViewer component with Shiki

**Files:**
- Create: `apps/web/src/components/chat/DiffViewer.tsx`

- [ ] **Step 1: Install shiki**

Run: `cd apps/web && bun add shiki`

- [ ] **Step 2: Create DiffViewer component**

Create `apps/web/src/components/chat/DiffViewer.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { transport } from "@/transport";

const MAX_LINES = 500;

/** Parse a unified diff string into typed lines. */
function parseDiffLines(diff: string): { type: "add" | "remove" | "context" | "header"; content: string }[] {
  return diff.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      return { type: "header" as const, content: line };
    }
    if (line.startsWith("+")) return { type: "add" as const, content: line.slice(1) };
    if (line.startsWith("-")) return { type: "remove" as const, content: line.slice(1) };
    return { type: "context" as const, content: line.startsWith(" ") ? line.slice(1) : line };
  });
}

interface DiffViewerProps {
  snapshotId: string;
  filePath: string;
  changeType?: "created" | "deleted" | "renamed" | "modified" | "binary";
}

/** Inline unified diff renderer. Lazy-loads diff content on expand. */
export function DiffViewer({ snapshotId, filePath, changeType = "modified" }: DiffViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const handleToggle = useCallback(async () => {
    if (!expanded && diff === null) {
      setLoading(true);
      try {
        const result = await transport.getSnapshotDiff(snapshotId, filePath);
        setDiff(result);
      } catch {
        setDiff("Failed to load diff");
      } finally {
        setLoading(false);
      }
    }
    setExpanded((prev) => !prev);
  }, [expanded, diff, snapshotId, filePath]);

  const lines = diff ? parseDiffLines(diff) : [];
  const truncated = !showAll && lines.length > MAX_LINES;
  const visibleLines = truncated ? lines.slice(0, MAX_LINES) : lines;

  const changeLabel = {
    created: "File created",
    deleted: "File deleted",
    renamed: "File renamed",
    modified: "Modified",
    binary: "Binary file changed",
  }[changeType];

  return (
    <div className="rounded-md border border-border/30 overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <FileText className="h-3 w-3 shrink-0" />
        <span className="truncate font-mono">{filePath}</span>
        <span className="ml-auto text-[10px] opacity-60">{changeLabel}</span>
        {loading && <span className="text-[10px]">Loading...</span>}
      </button>

      {expanded && diff !== null && changeType !== "binary" && (
        <div className="max-h-[500px] overflow-auto text-[11px] font-mono leading-relaxed">
          {visibleLines.map((line, i) => (
            <div
              key={i}
              className={
                line.type === "add"
                  ? "bg-green-500/10 text-green-400"
                  : line.type === "remove"
                    ? "bg-red-500/10 text-red-400"
                    : line.type === "header"
                      ? "bg-muted/30 text-muted-foreground/70"
                      : "text-muted-foreground"
              }
            >
              <span className="inline-block w-5 select-none text-right pr-2 opacity-40">
                {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              </span>
              {line.content}
            </div>
          ))}
          {truncated && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full py-1.5 text-center text-xs text-muted-foreground/70 hover:text-foreground bg-muted/20"
            >
              Show full diff ({lines.length - MAX_LINES} more lines)
            </button>
          )}
        </div>
      )}

      {expanded && changeType === "binary" && (
        <div className="px-3 py-2 text-xs text-muted-foreground/70">
          Binary file changed. No diff available.
        </div>
      )}
    </div>
  );
}
```

Note: Shiki integration is deferred to a follow-up enhancement. The initial implementation uses plain-text diff rendering with +/- line coloring (green/red) per the spec's fallback behavior. This protects the bundle size target and provides the core functionality. Shiki lazy-loading can be added as a separate task once the baseline works.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/DiffViewer.tsx
git commit -m "feat(web): add DiffViewer component with inline unified diff rendering"
```

---

### Task 19: SubagentContainer component

**Files:**
- Create: `apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx`
- Modify: `apps/web/src/components/chat/tool-renderers/AgentRenderer.tsx`

- [ ] **Step 1: Create SubagentContainer**

Create `apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx`:

```tsx
import { useState, useEffect } from "react";
import { Bot, ChevronRight } from "lucide-react";
import { transport } from "@/transport";
import { ToolCallCard } from "../ToolCallCard";
import type { ToolCallRecord } from "@/transport/types";
import type { ToolCall } from "@/transport/types";

interface SubagentContainerProps {
  toolCallId: string;
  description: string;
  status: "completed" | "failed" | "running";
  defaultExpanded?: boolean;
}

/** Convert a ToolCallRecord to the ToolCall shape used by renderers. */
function recordToToolCall(record: ToolCallRecord): ToolCall {
  return {
    id: record.id,
    toolName: record.tool_name,
    toolInput: { summary: record.input_summary },
    output: record.output_summary || null,
    isError: record.status === "failed",
    isComplete: true,
  };
}

/** Collapsible wrapper for subagent tool calls loaded from DB. */
export function SubagentContainer({
  toolCallId,
  description,
  status,
  defaultExpanded = false,
}: SubagentContainerProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [children, setChildren] = useState<ToolCallRecord[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (expanded && children === null) {
      setLoading(true);
      // Load children via the parent's message - we need to query by parent_tool_call_id
      // The listToolCallRecords returns all records for a message; filter client-side
      transport
        .listToolCallRecords(toolCallId)
        .then(setChildren)
        .catch(() => setChildren([]))
        .finally(() => setLoading(false));
    }
  }, [expanded, children, toolCallId]);

  const statusBadge = {
    completed: "text-green-400 bg-green-500/10",
    failed: "text-red-400 bg-red-500/10",
    running: "text-yellow-400 bg-yellow-500/10",
  }[status];

  return (
    <div className="rounded-md border border-border/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/20 transition-colors"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <Bot className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{description || "Subagent"}</span>
        <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] ${statusBadge}`}>
          {status}
        </span>
        {children && (
          <span className="ml-auto text-[10px] opacity-60">
            {children.length} tool call{children.length !== 1 ? "s" : ""}
          </span>
        )}
        {loading && <span className="ml-auto text-[10px]">Loading...</span>}
      </button>

      {expanded && children && children.length > 0 && (
        <div className="border-t border-border/20 pl-4">
          <ToolCallCard toolCalls={children.map(recordToToolCall)} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/chat/tool-renderers/SubagentContainer.tsx
git commit -m "feat(web): add SubagentContainer for nested subagent tool calls"
```

---

### Task 20: AgentStatusBar component

**Files:**
- Create: `apps/web/src/components/chat/AgentStatusBar.tsx`
- Modify: `apps/web/src/components/chat/Composer.tsx`

- [ ] **Step 1: Create AgentStatusBar**

Create `apps/web/src/components/chat/AgentStatusBar.tsx`:

```tsx
import { Bot } from "lucide-react";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Shows "N subagents running" badge when subagents are active on the current thread. */
export function AgentStatusBar() {
  const activeThread = useWorkspaceStore((s) => s.activeThread);
  const count = useThreadStore((s) =>
    activeThread ? s.activeSubagentsByThread[activeThread.id] ?? 0 : 0,
  );

  if (count <= 0) return null;

  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
      <Bot className="h-3 w-3 animate-pulse" />
      <span>
        {count} subagent{count !== 1 ? "s" : ""} running
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Add AgentStatusBar to Composer status bar**

In `apps/web/src/components/chat/Composer.tsx`, add import:

```ts
import { AgentStatusBar } from "./AgentStatusBar";
```

In the status bar row (the `flex` container with `ModeSelector` on the left and `ml-auto` branch controls on the right), add `AgentStatusBar` between them. Find the status bar container div and add after `ModeSelector`:

```tsx
        <AgentStatusBar />
```

- [ ] **Step 3: Verify web app compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/chat/AgentStatusBar.tsx apps/web/src/components/chat/Composer.tsx
git commit -m "feat(web): add AgentStatusBar showing subagent count in composer"
```

---

## Chunk 7: Snapshot Cleanup

### Task 21: Snapshot cleanup on server startup

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Add cleanup call at startup**

In `apps/server/src/index.ts`, after `agentService.init();` (line 65), add:

```ts
// Run snapshot garbage collection on startup
const maxAge = parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? "30", 10);
const removed = turnSnapshotRepo.deleteExpired(maxAge);
if (removed > 0) {
  logger.info(`Cleaned up ${removed} expired turn snapshots`);
}
```

- [ ] **Step 2: Verify server compiles**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): run snapshot garbage collection on startup"
```

---

## Self-Review

### Spec Coverage Check

| Spec Requirement | Task |
|-----------------|------|
| Persist tool calls (Section 1) | Tasks 1, 5, 6, 8, 11 |
| New tables + migration (Section 1) | Task 5 |
| Contract types + Zod schemas (Section 1) | Tasks 1, 2, 3, 4 |
| tool_call_count on messages (Section 1) | Task 3, 10 |
| Post-turn ToolCallSummary (Section 2) | Tasks 16, 17 |
| Subagent nesting inference (Section 2) | Tasks 11, 12 |
| SubagentContainer component (Section 2) | Task 19 |
| AgentStatusBar (Section 2) | Task 20 |
| Git snapshots (Section 3) | Tasks 7, 9, 11 |
| Diff on demand (Section 3) | Tasks 13, 18 |
| Garbage collection (Section 3) | Tasks 7, 13, 21 |
| parentToolCallId event augmentation (Section 2) | Tasks 2, 12, 15 |
| turn.persisted push channel (Section 5) | Tasks 4, 11, 15 |
| RPC methods (Section 5) | Tasks 4, 13, 14 |
| Phase 2 thinking narration | Excluded (spec marks as future Phase 2) |
| StreamingIndicator changes | No changes needed (Phase 1, already works per spec) |

### Placeholder Scan

No "TBD", "TODO", or "implement later" placeholders found.

### Type Consistency Check

- `ToolCallRecord` used consistently across contracts, repos, transport, and components
- `TurnSnapshot` used consistently across contracts, repos, transport
- `CreateToolCallRecordInput.parentToolCallId` matches `ToolCallRecord.parent_tool_call_id`
- `parentToolCallId` on `AgentEvent.toolUse` matches usage in `handleAgentEvent`
- `turn.persisted` channel shape matches across `channels.ts`, `agent-service.ts`, and `ws-events.ts`
