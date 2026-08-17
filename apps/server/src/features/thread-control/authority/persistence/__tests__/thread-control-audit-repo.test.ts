import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ThreadControlAuditRepo } from "../thread-control-audit-repo.js";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";

describe("ThreadControlAuditRepo", () => {
  it("persists bounded identity and outcome fields without prompt or path columns", () => {
    const db = openMemoryDatabase();
    const audit = new ThreadControlAuditRepo(db);

    audit.write({
      callerId: "user-1",
      sourceThreadId: "source-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      operation: "thread_create_batch",
      outcome: "created",
    });

    expect(db.prepare("SELECT caller_id, source_thread_id, workspace_id, thread_id, operation, outcome FROM thread_control_audit").get()).toEqual({
      caller_id: "user-1",
      source_thread_id: "source-1",
      workspace_id: "workspace-1",
      thread_id: "thread-1",
      operation: "thread_create_batch",
      outcome: "created",
    });
    expect((db.prepare("PRAGMA table_info(thread_control_audit)").all() as Array<{ name: string }>).map((column) => column.name)).not.toEqual(expect.arrayContaining(["prompt", "path", "secret"]));
  });
});
