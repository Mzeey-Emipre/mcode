import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../persistence/workspace-repo.js";
import { ProjectActionRunRepo } from "../project-action-run-repo.js";

const RETAINED_ACTION_RUNS_PER_THREAD = 256;

function run(
  threadId: string,
  workspaceId: string,
  actionId: string,
  index: number,
  status: "running" | "completed" = "completed",
): WorkspaceEnvironmentActionRun {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    threadId,
    workspaceId,
    actionId,
    runId: `run-${index}`,
    revision: 1,
    terminalSessionId: status === "running" ? `terminal-${index}` : null,
    actionName: `Deleted action ${index}`,
    status,
    snapshot: {
      platform: "windows",
      script: "bun run build",
      checkoutPath: "C:\\repo",
      terminal: null,
      environmentNames: [],
    },
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: status === "running" ? null : timestamp,
    exitCode: status === "running" ? null : 0,
    transcript: "",
    transcriptTruncated: false,
  };
}

describe("ProjectActionRunRepo retention", () => {
  let db: Database;
  let repo: ProjectActionRunRepo;
  let threadId: string;
  let workspaceId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    const workspace = new WorkspaceRepo(db).create("Action retention", "C:\\repo");
    const thread = new ThreadRepo(db).create(workspace.id, "Thread", "direct", "main");
    repo = new ProjectActionRunRepo(db);
    threadId = thread.id;
    workspaceId = workspace.id;
  });

  afterEach(() => {
    db.close();
  });

  it("keeps the newest bounded deleted Action slots using an independent retention oracle", () => {
    const submitted = Array.from({ length: RETAINED_ACTION_RUNS_PER_THREAD + 1 }, (_, index) =>
      run(threadId, workspaceId, `deleted-${index.toString().padStart(3, "0")}`, index),
    );
    for (const candidate of submitted) repo.replace(candidate);

    const expected = [...submitted]
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.actionId.localeCompare(left.actionId),
      )
      .slice(0, RETAINED_ACTION_RUNS_PER_THREAD)
      .map((candidate) => candidate.actionId);
    const retained = repo.list(threadId);

    expect(retained.map((candidate) => candidate.actionId)).toEqual(expected);
    expect(retained).toHaveLength(RETAINED_ACTION_RUNS_PER_THREAD);
    expect(retained.every((candidate) => candidate.actionName.startsWith("Deleted action"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_action_runs WHERE thread_id = ?")
      .get(threadId)).toEqual({ count: RETAINED_ACTION_RUNS_PER_THREAD });
  });

  it("keeps a running slot through finalized retention and preserves its final result", () => {
    const active = run(threadId, workspaceId, "active", 0, "running");
    const finalized = Array.from({ length: RETAINED_ACTION_RUNS_PER_THREAD + 1 }, (_, index) =>
      run(threadId, workspaceId, `deleted-${(index + 1).toString().padStart(3, "0")}`, index + 1),
    );
    repo.replace(active);
    for (const candidate of finalized) repo.replace(candidate);

    expect(repo.get(threadId, active.actionId)).toMatchObject({ status: "running" });
    const finalizedActive = {
      ...active,
      revision: 2,
      status: "completed" as const,
      finishedAt: "2026-01-01T00:00:00.000Z",
      exitCode: 0,
    };
    expect(repo.updateIfCurrent(finalizedActive)).toBe(true);

    const expectedFinalized = [...finalized]
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.actionId.localeCompare(left.actionId),
      )
      .slice(0, RETAINED_ACTION_RUNS_PER_THREAD - 1)
      .map((candidate) => candidate.actionId);
    const retained = repo.list(threadId);

    expect(retained.map((candidate) => candidate.actionId)).toEqual([...expectedFinalized, active.actionId]);
    expect(retained).toHaveLength(RETAINED_ACTION_RUNS_PER_THREAD);
    expect(repo.get(threadId, active.actionId)).toMatchObject({
      runId: active.runId,
      status: "completed",
      revision: 2,
    });
  });
});
