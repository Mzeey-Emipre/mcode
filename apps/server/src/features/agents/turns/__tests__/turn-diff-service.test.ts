import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import type { ProviderTurnDiffUpdate, TurnFileEffectSummary } from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { TurnDiffRepo } from "../persistence/turn-diff-repo.js";
import { TURN_DIFF_MAX_BYTES, TurnDiffService } from "../turn-diff-service.js";

const patch = "diff --git a/a.txt b/a.txt\nindex 1..2\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
const identity = { threadId: "thread-1", turnId: "turn-1", turnExecutionId: "execution-1", deliveryAttempt: 1 };
const update = (overrides: Partial<ProviderTurnDiffUpdate> = {}): ProviderTurnDiffUpdate => ({
  ...identity, revision: 1, state: "snapshot", nativeFidelity: "agent", patch, ...overrides,
});
const empty: TurnFileEffectSummary = { revision: 1, fileCount: 0, additions: 0, deletions: 0, effects: [] };
const effects: TurnFileEffectSummary = { revision: 1, fileCount: 1, additions: 1, deletions: 1,
  effects: [{ path: "a.txt", scope: "workspace", kind: "edited", additions: 1, deletions: 1, binary: false, toolCallIds: ["edit-1"] }] };

describe("TurnDiffService production settlement", () => {
  let db: Database;
  let service: TurnDiffService;
  let repo: TurnDiffRepo;
  beforeEach(() => {
    db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws-1", "Test", "/test", now, now);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(identity.threadId, "ws-1", "Test", "main", now, now);
    for (const sequence of [1, 2]) db.prepare("INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)").run("message-" + sequence, identity.threadId, "assistant", "Done", now, sequence);
    repo = new TurnDiffRepo(db);
    service = new TurnDiffService(repo);
    service.begin(identity);
  });
  afterEach(() => db.close());

  it("keeps Live volatile and persists the exact full native patch across service recreation", () => {
    expect(service.push(update())).toBe("accepted");
    expect(repo.latest(identity.threadId)).toBeUndefined();
    expect(service.liveComparison(identity.threadId)).toEqual({
      files: [{ path: "a.txt", previousPath: null, binary: false, changeType: "modified" }],
      additions: 1, deletions: 1,
      turnDiff: { id: "live:turn-1:execution-1:1:1", phase: "live", source: "native", fidelity: "agent", revision: 1 },
    });
    const settle = service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed");
    expect(service.liveComparison(identity.threadId)).toBeNull();
    settle("message-1", effects);
    expect(new TurnDiffService(repo).latest(identity.threadId)).toMatchObject({ message_id: "message-1", source: "native", patch, revision: 1 });
    settle("message-1", effects);
    expect(db.prepare("SELECT count(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 1 });
  });

  it("rejects stale and unadmitted attempts, revisions, executions, and late terminal updates", () => {
    service.push(update());
    for (const rejected of [
      update({ revision: 1 }), update({ revision: 0 }), update({ revision: -1 }),
      update({ deliveryAttempt: 2, revision: 100 }), update({ deliveryAttempt: 0, revision: 100 }),
      update({ turnExecutionId: "other", revision: 100 }),
    ]) expect(service.push(rejected)).toBe("stale");
    service.prepareFinalization(identity.threadId, "other", "completed")("message-1", effects);
    expect(service.liveComparison(identity.threadId)?.turnDiff?.revision).toBe(1);
    service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", effects);
    expect(service.push(update({ revision: 100 }))).toBe("stale");
    expect(repo.latest(identity.threadId)?.patch).toBe(patch);
  });

  it("freezes terminal evidence before another execution starts", () => {
    service.push(update());
    const settle = service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed");
    service.begin({ ...identity, turnId: "turn-2", turnExecutionId: "execution-2" });
    service.push(update({ turnId: "turn-2", turnExecutionId: "execution-2", patch: patch.replace("+new", "+second") }));
    settle("message-1", effects);
    expect(repo.latest(identity.threadId)?.patch).toBe(patch);
    expect(service.liveComparison(identity.threadId)?.turnDiff?.id).toBe("live:turn-2:execution-2:1:1");
    expect(service.push(update({ revision: 99 }))).toBe("stale");
  });

  it.each(["invalidated", "interrupted", "cancelled", "errored"] as const)("preserves previous settlement on %s", (state) => {
    service.push(update());
    service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", effects);
    service.begin({ ...identity, turnId: "turn-2", turnExecutionId: "execution-2" });
    service.push(update({ turnId: "turn-2", turnExecutionId: "execution-2" }));
    if (state === "invalidated") service.push({ turnId: "turn-2", turnExecutionId: "execution-2", deliveryAttempt: 1, revision: 2, state: "invalidated" });
    service.prepareFinalization(identity.threadId, "execution-2", state === "invalidated" ? "completed" : state)("message-2", effects);
    expect(service.liveComparison(identity.threadId)).toBeNull();
    expect(repo.latest(identity.threadId)?.message_id).toBe("message-1");
  });

  it.each([true, false])("reconciles indeterminate empty with remaining effects=%s", (hasEffects) => {
    service.push(update());
    service.push({ ...identity, revision: 2, state: "indeterminate-empty" });
    expect(service.liveComparison(identity.threadId)).toBeNull();
    service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", hasEffects ? effects : empty);
    expect(repo.latest(identity.threadId)).toMatchObject({ source: hasEffects ? "git" : "native", patch: hasEffects ? null : "" });
  });

  it.each(["bad patch", patch + "trailing data", "é".repeat(TURN_DIFF_MAX_BYTES / 2 + 1)])("rejects the whole malformed or oversized patch and selects Git", (invalid) => {
    service.push(update());
    expect(service.push(update({ patch: invalid, revision: 2 }))).toBe("invalidated");
    expect(service.liveComparison(identity.threadId)).toBeNull();
    service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", effects);
    expect(repo.latest(identity.threadId)).toMatchObject({ source: "git", patch: null });
  });

  it("uses Git after an adapter rejects native evidence before persistence", () => {
    expect(service.push({ ...identity, revision: 1, state: "rejected" })).toBe("accepted");
    service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", effects);
    expect(repo.latest(identity.threadId)).toMatchObject({ source: "git", patch: null });
  });

  it("orders native evidence before tracked reconstruction and Git fallback", () => {
    const reconstruction = patch.replace("+new", "+tracked");
    service.push(update());
    service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", effects, reconstruction);
    expect(repo.latest(identity.threadId)).toMatchObject({ source: "native", patch });

    service = new TurnDiffService(repo);
    service.begin({ ...identity, turnId: "turn-2", turnExecutionId: "execution-2" });
    service.prepareFinalization(identity.threadId, "execution-2", "completed")("message-2", effects, reconstruction);
    expect(repo.latest(identity.threadId)).toMatchObject({ source: "tracked", patch: reconstruction });

    service.begin({ ...identity, turnId: "turn-3", turnExecutionId: "execution-3" });
    service.prepareFinalization(identity.threadId, "execution-3", "completed")("message-2", effects, undefined);
    expect(repo.latest(identity.threadId)).toMatchObject({ source: "tracked", patch: reconstruction });
  });

  it("uses Git for a provider without native evidence and removes records on message rollback", () => {
    service.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", effects);
    expect(repo.latest(identity.threadId)).toMatchObject({ source: "git", patch: null });
    db.prepare("DELETE FROM messages WHERE id = ?").run("message-1");
    expect(repo.latest(identity.threadId)).toBeUndefined();
  });
});
