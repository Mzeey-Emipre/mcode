import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { ReviewComparisonSchema } from "@mcode/contracts";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { TurnFinalizer } from "../turn-finalizer.js";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { RealGitExecutor } from "../../../projects/git/execution/real-git-executor.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { routeTurnDiffRpc, type TurnDiffRouterDeps } from "../../../projects/diffs/transport/turn-diff-rpc.js";
import { routeSnapshotRpc } from "../../../projects/diffs/transport/snapshot-rpc.js";
import { TurnDiffRepo } from "../persistence/turn-diff-repo.js";
import { TurnSnapshotRepo } from "../persistence/turn-snapshot-repo.js";
import { TurnDiffService } from "../turn-diff-service.js";

const identity = { threadId: "thread-1", turnId: "turn-1", turnExecutionId: "execution-1", deliveryAttempt: 1 };
const nativePatch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-AGENT=before\n+AGENT=after\n USER=before\n";

describe("Last turn Review public comparison boundary", () => {
  let db: Database;
  let directory: string;
  let deps: TurnDiffRouterDeps;
  const scratch = NodePath.resolve(process.cwd(), "../../.codex/tmp");

  beforeEach(async () => {
    NodeFS.mkdirSync(scratch, { recursive: true });
    directory = NodeFS.mkdtempSync(NodePath.join(scratch, "turn-diff-review-"));
    NodeChildProcess.execFileSync("git", ["init", "--template=", "--quiet", "--initial-branch=main", directory]);
    NodeFS.writeFileSync(NodePath.join(directory, "a.txt"), "AGENT=before\nUSER=before\n");
    NodeChildProcess.execFileSync("git", ["-C", directory, "add", "a.txt"]);
    NodeChildProcess.execFileSync("git", ["-C", directory, "-c", `core.hooksPath=${NodePath.join(directory, ".git/no-hooks")}`,
      "-c", "commit.gpgSign=false", "-c", "user.name=Verifier", "-c", "user.email=verifier@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws-1", "Test", directory, now, now);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(identity.threadId, "ws-1", "Test", "main", now, now);
    db.prepare("INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)").run("message-1", identity.threadId, "assistant", "Done", now, 1);
    deps = { turnDiffs: new TurnDiffService(new TurnDiffRepo(db)), turnSnapshotRepo: new TurnSnapshotRepo(db),
      snapshotService: new SnapshotService(new RealGitExecutor()), threadService: new ThreadRepo(db), workspaceService: new WorkspaceRepo(db),
      gitWorktrees: { resolveWorkingDir: GitWorktreeService.prototype.resolveWorkingDir } };
  });
  afterEach(() => {
    db.close();
    if (NodePath.dirname(directory) !== scratch) throw new Error("Fixture outside scratch root");
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  async function snapshotBothEdits(refBefore?: string) {
    const service = new SnapshotService(new RealGitExecutor());
    const before = refBefore ?? await service.captureRef(directory);
    NodeFS.writeFileSync(NodePath.join(directory, "a.txt"), "AGENT=after\nUSER=after\n");
    const after = await service.captureRef(directory);
    return new TurnSnapshotRepo(db).create({ messageId: "message-1", threadId: identity.threadId,
      refBefore: before, refAfter: after, filesChanged: ["a.txt"], worktreePath: null });
  }

  it("isolates the native agent patch while disk and cumulative Git retain the same-file user edit", async () => {
    const before = await new SnapshotService(new RealGitExecutor()).captureRef(directory);
    NodeFS.writeFileSync(NodePath.join(directory, "a.txt"), "AGENT=after\nUSER=before\n");
    deps.turnDiffs.begin(identity);
    deps.turnDiffs.push({ ...identity, state: "snapshot", nativeFidelity: "agent", revision: 1, patch: nativePatch });
    const live = ReviewComparisonSchema().parse(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: identity.threadId }, deps));
    expect(live.turnDiff?.phase).toBe("live");
    expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: identity.threadId, comparisonId: live.turnDiff!.id, filePath: "a.txt" }, deps)).toBe(nativePatch);
    await snapshotBothEdits(before);
    deps.turnDiffs.prepareFinalization(identity.threadId, identity.turnExecutionId, "completed")("message-1", undefined);
    deps.turnDiffs = new TurnDiffService(new TurnDiffRepo(db));
    const settled = ReviewComparisonSchema().parse(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: identity.threadId }, deps));
    expect(settled.turnDiff).toMatchObject({ phase: "settled", source: "native", fidelity: "agent" });
    expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: identity.threadId, comparisonId: settled.turnDiff!.id, filePath: "a.txt" }, deps)).toBe(nativePatch);
    expect(NodeFS.readFileSync(NodePath.join(directory, "a.txt"), "utf8")).toBe("AGENT=after\nUSER=after\n");
    const cumulative = await routeSnapshotRpc("snapshot.getCumulativeDiff", { threadId: identity.threadId }, deps);
    expect(cumulative).toContain("+AGENT=after");
    expect(cumulative).toContain("+USER=after");
  });

  it("keeps legacy histories readable through the attributed Git fallback", async () => {
    const snapshot = await snapshotBothEdits();
    const result = ReviewComparisonSchema().parse(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: identity.threadId }, deps));
    expect(result.turnDiff).toEqual({ id: `git:${snapshot.id}`, phase: "settled", source: "git", fidelity: "same-file-changes-possible", revision: 0 });
    expect(result.files.map((file) => file.path)).toEqual(["a.txt"]);
    const patch = await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: identity.threadId, comparisonId: result.turnDiff!.id, filePath: "a.txt" }, deps);
    expect(patch).toContain("+USER=after");
    expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: identity.threadId, comparisonId: result.turnDiff!.id, filePath: "../a.txt" }, deps)).toBe("");
  });

  it("reads settled evidence after reconnect without clearing another client's Live patch", async () => {
    const snapshot = await snapshotBothEdits();
    deps.turnDiffs.begin(identity);
    deps.turnDiffs.push({ ...identity, state: "snapshot", nativeFidelity: "agent", revision: 1, patch: nativePatch });
    const reconnected = ReviewComparisonSchema().parse(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: identity.threadId, includeLive: false }, deps));
    expect(reconnected.turnDiff?.id).toBe(`git:${snapshot.id}`);
    const otherClient = ReviewComparisonSchema().parse(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: identity.threadId }, deps));
    expect(otherClient.turnDiff?.phase).toBe("live");
    deps.turnDiffs.push({ ...identity, state: "snapshot", nativeFidelity: "agent", revision: 2, patch: nativePatch.replace("+AGENT=after", "+AGENT=fresh") });
    const fresh = ReviewComparisonSchema().parse(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: identity.threadId, includeLive: true }, deps));
    expect(fresh.turnDiff?.revision).toBe(2);
    expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: identity.threadId, comparisonId: fresh.turnDiff!.id, filePath: "a.txt" }, deps)).toContain("+AGENT=fresh");
  });

  it.each([
    ["interrupted", false], ["interrupted", true], ["cancelled", false],
    ["cancelled", true], ["errored", false], ["errored", true],
  ] as const)("does not expose %s Git snapshots as Last turn, prior legacy=%s", async (outcome, hasPrevious) => {
    const previous = hasPrevious ? await snapshotBothEdits() : null;
    const messages = new MessageRepo(db);
    messages.create(identity.threadId, "user", "Make the next edit", 2);
    const narrative = new NarrativeStore(messages, new ToolCallRecordRepo(db), new ThoughtSegmentRepo(db), new HookExecutionRepo(db));
    const finalizer = new TurnFinalizer(messages, new ThreadRepo(db), narrative, deps.snapshotService,
      deps.turnSnapshotRepo, db, undefined, undefined, undefined, deps.turnDiffs);
    const executionId = "execution-2";
    deps.turnDiffs.begin({ ...identity, turnExecutionId: executionId });
    deps.turnDiffs.push({ ...identity, turnExecutionId: executionId, state: "snapshot", nativeFidelity: "agent", revision: 1, patch: nativePatch });
    finalizer.recordTurnRef(identity.threadId, await deps.snapshotService.captureRef(directory), directory);
    finalizer.bufferAssistantBody(identity.threadId, "Partial agent edit", "test-model");
    NodeFS.writeFileSync(NodePath.join(directory, "a.txt"), "PARTIAL=edit\n");
    await finalizer.finalize(identity.threadId, outcome, Promise.resolve(), executionId);
    expect(deps.turnDiffs.latest(identity.threadId)).toBeUndefined();
    const result = await routeTurnDiffRpc("turnDiff.getComparison", { threadId: identity.threadId }, deps);
    if (previous) expect(ReviewComparisonSchema().parse(result).turnDiff?.id).toBe(`git:${previous.id}`);
    else expect(result).toBeNull();
    expect(deps.turnSnapshotRepo.listByThread(identity.threadId)).toHaveLength(hasPrevious ? 2 : 1);
  });
});
