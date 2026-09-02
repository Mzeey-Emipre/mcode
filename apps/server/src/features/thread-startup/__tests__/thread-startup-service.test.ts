import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../runtime/persistence/sqlite/database.js";
import {
  THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES,
  type ThreadStartupStartInput,
} from "@mcode/contracts";
import { ThreadStartupRepo } from "../persistence/thread-startup-repo.js";
import { ThreadStartupConflictError, ThreadStartupService } from "../thread-startup-service.js";

const firstStartupId = "00000000-0000-4000-8000-000000000001";
const secondStartupId = "00000000-0000-4000-8000-000000000002";
const thirdStartupId = "00000000-0000-4000-8000-000000000003";
const threadId = "00000000-0000-4000-8000-000000000004";

function createHarness() {
  const db = openMemoryDatabase();
  db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES (?, ?, ?, ?)")
    .run("workspace-1", "First", "/first", "{}");
  db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES (?, ?, ?, ?)")
    .run("workspace-2", "Second", "/second", "{}");
  let time = Date.parse("2026-09-02T10:00:00.000Z");
  const service = new ThreadStartupService(
    new ThreadStartupRepo(db),
    () => new Date(time++),
  );
  return { db, service };
}

function input(
  startupId = firstStartupId,
  workspaceId = "workspace-1",
  kind: ThreadStartupStartInput["kind"] = "direct",
): ThreadStartupStartInput {
  return { startupId, workspaceId, kind };
}

describe("ThreadStartupService", () => {
  it("increments revisions for each lifecycle change", () => {
    const { db, service } = createHarness();
    const created = service.start(input());
    const thread = service.advance(firstStartupId, "thread");
    const agent = service.advance(firstStartupId, "agent");

    expect([created.revision, thread.revision, agent.revision]).toEqual([1, 2, 3]);
    db.close();
  });

  it("retains only a bounded transcript", () => {
    const { db, service } = createHarness();
    service.start(input());
    for (let index = 0; index <= THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES; index += 1) {
      service.appendOutput(firstStartupId, String(index).padStart(4, "0").padEnd(512, "x"));
    }

    const transcript = service.get(firstStartupId)?.transcript;
    expect(transcript).toHaveLength(THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES);
    expect(transcript?.[0]?.content.startsWith("0001")).toBe(true);
    expect(transcript?.at(-1)?.content.startsWith("0032")).toBe(true);
    db.close();
  });

  it("returns the existing record for identical start input and rejects conflicting reuse", () => {
    const { db, service } = createHarness();
    const created = service.start(input());

    expect(service.start(input())).toEqual(created);
    expect(() => service.start(input(firstStartupId, "workspace-2")))
      .toThrow(ThreadStartupConflictError);
    db.close();
  });

  it("keeps terminal records stable", () => {
    const { db, service } = createHarness();
    service.start(input());
    service.advance(firstStartupId, "thread");
    service.advance(firstStartupId, "agent");
    const completed = service.complete(firstStartupId);

    expect(service.advance(firstStartupId, "agent")).toEqual(completed);
    expect(service.fail(firstStartupId, {
      code: "unexpected",
      message: "This must not replace completion",
      retryable: false,
    })).toEqual(completed);
    db.close();
  });

  it("binds a created thread and preserves structured failure detail", () => {
    const { db, service } = createHarness();
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, mode, worktree_managed, provider) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(threadId, "workspace-1", "Started", "main", "direct", 0, "claude");
    service.start(input());
    const bound = service.bindThread(firstStartupId, threadId);
    service.advance(firstStartupId, "thread");
    const failed = service.fail(firstStartupId, {
      code: "worktree_unavailable",
      message: "The worktree could not start",
      retryable: true,
    });

    expect(bound.threadId).toBe(threadId);
    expect(failed).toMatchObject({
      state: "failed",
      phase: "thread",
      error: { code: "worktree_unavailable", retryable: true },
    });
    db.close();
  });

  it("scopes list results to one workspace", () => {
    const { db, service } = createHarness();
    service.start(input(firstStartupId, "workspace-1"));
    service.start(input(secondStartupId, "workspace-2"));

    expect(service.list("workspace-1").map((startup) => startup.startupId)).toEqual([firstStartupId]);
    db.close();
  });

  it("records cancellation intent without claiming the startup stopped", () => {
    const { db, service } = createHarness();
    service.start(input());
    const cancelled = service.cancel(firstStartupId);

    expect(cancelled).toMatchObject({ state: "pending", cancellation: "requested", revision: 2 });
    expect(service.isCancellationRequested(firstStartupId)).toBe(true);
    expect(service.cancel(firstStartupId)).toEqual(cancelled);
    db.close();
  });

  it("marks nonterminal startup records interrupted after restart", () => {
    const { db, service } = createHarness();
    service.start(input(firstStartupId));
    service.start(input(secondStartupId, "workspace-1", "managed-worktree"));
    service.advance(secondStartupId, "thread");
    service.start(input(thirdStartupId, "workspace-2"));
    service.advance(thirdStartupId, "thread");
    service.advance(thirdStartupId, "agent");
    service.complete(thirdStartupId);

    const interrupted = service.interruptNonterminalOnStartup();

    expect(interrupted.map((startup) => startup.startupId).sort()).toEqual([
      firstStartupId,
      secondStartupId,
    ]);
    expect(service.get(firstStartupId)).toMatchObject({ state: "interrupted", phase: "thread" });
    expect(service.get(firstStartupId)?.steps[0]).toEqual({ phase: "thread", state: "interrupted" });
    expect(service.get(secondStartupId)).toMatchObject({ state: "interrupted", phase: "thread" });
    expect(service.get(secondStartupId)?.steps[0]).toEqual({ phase: "thread", state: "interrupted" });
    expect(service.get(thirdStartupId)?.state).toBe("completed");
    db.close();
  });
});
