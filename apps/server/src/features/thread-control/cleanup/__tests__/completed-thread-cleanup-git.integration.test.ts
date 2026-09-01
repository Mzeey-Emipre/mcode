import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "../persistence/cleanup-job-repo.js";
import { CleanupWorker } from "../cleanup-worker.js";
import {
  GitRepositoryService,
  GitWorktreeService,
  SandboxWorktreeCleanupPolicy,
  WorktreeSafetyService,
} from "../../../projects/index.js";
import { RepositoryGitMutationLock } from "../../../projects/git/repository-git-mutation-lock.js";
import { RealGitExecutor } from "../../../projects/git/execution/real-git-executor.js";
import { getMcodeDir } from "@mcode/shared";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import type { ClaudeProvider } from "../../../providers/adapters/claude/claude-provider.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { HandoffStorage } from "../../../handoff/index.js";
import type { ThreadDeletionTeardownService } from "../../lifecycle/thread-deletion-teardown-service.js";

vi.mock("../../../../runtime/process/containment/process-kill.js", () => ({
  killDescendantsByName: vi.fn().mockResolvedValue(undefined),
}));

describe("completed thread cleanup Git safety", () => {
  let database: Database.Database;
  let testRootPath: string;
  let repositoryPath: string;
  let worktreePath: string;
  let gitWorktrees: GitWorktreeService;
  let gitRepository: GitRepositoryService;
  let worktreeSafety: WorktreeSafetyService;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let worker: CleanupWorker;
  let externalTargetPath: string | null;
  let escapingLinkContainerPath: string | null;

  beforeEach(() => {
    const worktreesPath = NodePath.join(getMcodeDir(), "worktrees");
    NodeFS.mkdirSync(worktreesPath, { recursive: true });
    testRootPath = NodeFS.mkdtempSync(NodePath.join(worktreesPath, "mcode-completed-cleanup-"));
    repositoryPath = NodePath.join(testRootPath, "repository");
    worktreePath = NodePath.join(testRootPath, "worktree");
    NodeFS.mkdirSync(repositoryPath);
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "init", "-b", "main"]);
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "config", "user.email", "test@mcode.test"]);
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Mcode Test"]);
    NodeFS.writeFileSync(NodePath.join(repositoryPath, "tracked.txt"), "initial\n");
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "add", "tracked.txt"]);
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "commit", "-m", "initial"]);
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "worktree", "add", "--detach", worktreePath, "main"]);
    database = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(database);
    threadRepo = new ThreadRepo(database);
    cleanupJobRepo = new CleanupJobRepo(database);
    externalTargetPath = null;
    escapingLinkContainerPath = null;
    const executor = new RealGitExecutor();
    gitRepository = new GitRepositoryService(workspaceRepo, executor);
    gitWorktrees = new GitWorktreeService(workspaceRepo, executor, hostRuntime, undefined, undefined, gitRepository);
    worktreeSafety = new WorktreeSafetyService(executor, hostRuntime);
    worker = createWorker();
  }, 30_000);

  afterEach(() => {
    worker.dispose();
    database.close();
    NodeFS.rmSync(testRootPath, { recursive: true, force: true });
    if (escapingLinkContainerPath) NodeFS.rmSync(escapingLinkContainerPath, { recursive: true, force: true });
    if (externalTargetPath) NodeFS.rmSync(externalTargetPath, { recursive: true, force: true });
  }, 30_000);

  function createWorker(): CleanupWorker {
    return new CleanupWorker(
      database,
      cleanupJobRepo,
      threadRepo,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider,
      gitWorktrees,
      new SandboxWorktreeCleanupPolicy(worktreeSafety, gitRepository, hostRuntime),
      new RepositoryGitMutationLock(hostRuntime),
      workspaceRepo,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
      { teardownThread: vi.fn().mockResolvedValue(undefined) } as unknown as ThreadDeletionTeardownService,
      hostRuntime,
    );
  }

  function addCompletedThread(options: {
    title: string;
    mode?: "direct" | "worktree";
    path?: string | null;
    checkoutState?: "named" | "branchless";
    baseBranch?: string | null;
    deadline?: string;
    branch?: string;
  }) {
    const workspace = workspaceRepo.listAll()[0] ?? workspaceRepo.create("Project", repositoryPath);
    const thread = threadRepo.create(
      workspace.id,
      options.title,
      options.mode ?? "worktree",
      options.branch ?? "",
      true,
      "claude",
      undefined,
      options.checkoutState ?? "branchless",
      options.baseBranch === undefined ? "main" : options.baseBranch,
    );
    database.prepare(
      `UPDATE threads
       SET worktree_path = ?, user_completed_at = ?, scheduled_deletion_at = ?
       WHERE id = ?`,
    ).run(
      options.path === undefined ? worktreePath : options.path,
      "2026-08-12T09:00:00.000Z",
      options.deadline ?? "2026-08-12T09:01:00.000Z",
      thread.id,
    );
    return thread;
  }

  it("accepts a clean branchless worktree with no unique commits", async () => {
    await expect(worktreeSafety.assessBranchlessWorktreeRemoval(worktreePath, "main")).resolves.toEqual({
      safe: true,
      reason: "clean",
    });
  }, 30_000);

  it("rejects a worktree with uncommitted changes", async () => {
    NodeFS.writeFileSync(NodePath.join(worktreePath, "tracked.txt"), "changed\n");

    await expect(worktreeSafety.assessBranchlessWorktreeRemoval(worktreePath, "main")).resolves.toEqual({
      safe: false,
      reason: "dirty",
    });
  }, 30_000);

  it("rejects a branchless worktree with a unique commit", async () => {
    NodeFS.writeFileSync(NodePath.join(worktreePath, "unique.txt"), "unique\n");
    NodeChildProcess.execFileSync("git", ["-C", worktreePath, "add", "unique.txt"]);
    NodeChildProcess.execFileSync("git", ["-C", worktreePath, "commit", "-m", "unique"]);

    await expect(worktreeSafety.assessBranchlessWorktreeRemoval(worktreePath, "main")).resolves.toEqual({
      safe: false,
      reason: "unique_commits",
    });
  }, 30_000);

  it("deletes an expired direct thread without repository cleanup", async () => {
    const thread = addCompletedThread({ title: "Direct", mode: "direct", path: null });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(true);
  }, 30_000);

  it("removes a clean managed branchless worktree without deleting a branch", async () => {
    const thread = addCompletedThread({ title: "Clean" });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
    expect(NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "branch", "--list", "main"], { encoding: "utf8" }))
      .toContain("main");
  }, 30_000);

  it("removes a clean worktree when a sibling record points to a missing directory", async () => {
    const thread = addCompletedThread({ title: "Missing sibling" });
    const workspace = workspaceRepo.listAll()[0]!;
    const sibling = threadRepo.create(
      workspace.id,
      "Stale sibling",
      "worktree",
      "",
      true,
      "claude",
      undefined,
      "branchless",
      "main",
    );
    database.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run(
      NodePath.join(repositoryPath, "missing-worktree"),
      sibling.id,
    );

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
    expect(threadRepo.findById(sibling.id)).not.toBeNull();
  }, 30_000);

  it("removes a managed directory after Git no longer registers the worktree", async () => {
    const thread = addCompletedThread({ title: "Git-pruned directory" });
    NodeFS.rmSync(NodePath.join(worktreePath, ".git"), { force: true });
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "worktree", "prune"]);

    expect(
      NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }),
    ).not.toContain(worktreePath);

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
  }, 30_000);

  it("removes a dirty sandbox worktree", async () => {
    NodeFS.writeFileSync(NodePath.join(worktreePath, "tracked.txt"), "changed\n");
    const thread = addCompletedThread({ title: "Dirty" });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
  }, 30_000);

  it("removes linked completed threads from the same sandbox worktree", async () => {
    const due = addCompletedThread({ title: "Due" });
    const remaining = addCompletedThread({
      title: "Remaining",
      deadline: "2099-08-12T09:01:00.000Z",
    });

    await worker.poll();

    expect(threadRepo.findById(due.id)).toBeNull();
    expect(threadRepo.findById(remaining.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
  }, 30_000);

  it("removes a named sandbox checkout and its branch", async () => {
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "branch", "mcode/named", "main"]);
    NodeChildProcess.execFileSync("git", ["-C", worktreePath, "checkout", "mcode/named"]);
    const thread = addCompletedThread({
      title: "Named",
      checkoutState: "named",
      baseBranch: null,
      branch: "mcode/named",
    });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
    expect(NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "branch", "--list", "mcode/named"], { encoding: "utf8" }))
      .not.toContain("mcode/named");
  }, 30_000);

  it("preserves a canonical link that resolves outside Mcode worktrees", async ({ skip }) => {
    externalTargetPath = NodeFS.mkdtempSync(NodePath.join(getMcodeDir(), "mcode-external-cleanup-"));
    escapingLinkContainerPath = NodeFS.mkdtempSync(NodePath.join(getMcodeDir(), "worktrees", "mcode-escaping-link-"));
    const escapingLink = NodePath.join(escapingLinkContainerPath, "worktree");
    try {
      NodeFS.symlinkSync(externalTargetPath, escapingLink, "junction");
    } catch {
      skip();
      return;
    }
    const thread = addCompletedThread({ title: "Escaping link", path: escapingLink });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(escapingLink)).toBe(true);
    expect(NodeFS.existsSync(externalTargetPath)).toBe(true);
  }, 30_000);

  it("rejects an escaping link at the worktree removal boundary", async ({ skip }) => {
    externalTargetPath = NodeFS.mkdtempSync(NodePath.join(getMcodeDir(), "mcode-external-git-service-"));
    escapingLinkContainerPath = NodeFS.mkdtempSync(NodePath.join(getMcodeDir(), "worktrees", "mcode-git-service-link-"));
    const escapingLink = NodePath.join(escapingLinkContainerPath, "worktree");
    try {
      NodeFS.symlinkSync(externalTargetPath, escapingLink, "junction");
    } catch {
      skip();
      return;
    }

    await expect(
      gitWorktrees.removeWorktree(repositoryPath, "escaping", {
        deleteBranch: false,
        worktreePath: escapingLink,
        managedCanonicalOnly: true,
      }),
    ).rejects.toThrow("canonical managed worktree");
    expect(NodeFS.existsSync(escapingLink)).toBe(true);
    expect(NodeFS.existsSync(externalTargetPath)).toBe(true);
  }, 30_000);

  it("removes a sandbox worktree with unique commits", async () => {
    NodeFS.writeFileSync(NodePath.join(worktreePath, "unique.txt"), "unique\n");
    NodeChildProcess.execFileSync("git", ["-C", worktreePath, "add", "unique.txt"]);
    NodeChildProcess.execFileSync("git", ["-C", worktreePath, "commit", "-m", "unique"]);
    const thread = addCompletedThread({ title: "Unique" });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeFS.existsSync(worktreePath)).toBe(false);
  }, 30_000);

  it("deletes a thread when its registered worktree path is already missing", async () => {
    const thread = addCompletedThread({ title: "Missing" });
    NodeFS.rmSync(worktreePath, { recursive: true, force: true });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
  }, 30_000);

  it("prunes a missing named sandbox checkout and removes its saved branch", async () => {
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "branch", "mcode/missing", "main"]);
    NodeChildProcess.execFileSync("git", ["-C", worktreePath, "checkout", "mcode/missing"]);
    const thread = addCompletedThread({
      title: "Missing named",
      checkoutState: "named",
      baseBranch: null,
      branch: "mcode/missing",
    });
    NodeFS.rmSync(worktreePath, { recursive: true, force: true });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "branch", "--list", "mcode/missing"], { encoding: "utf8" }))
      .not.toContain("mcode/missing");
  }, 30_000);

  it("keeps a branchless checkout's saved non-default base branch", async () => {
    NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "branch", "release", "main"]);
    const thread = addCompletedThread({
      title: "Missing branchless",
      checkoutState: "branchless",
      baseBranch: "release",
      branch: "release",
    });
    NodeFS.rmSync(worktreePath, { recursive: true, force: true });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(NodeChildProcess.execFileSync("git", ["-C", repositoryPath, "branch", "--list", "release"], { encoding: "utf8" }))
      .toContain("release");
  }, 30_000);

  it("preserves retry state across worker restart and blocks after exhaustion", async () => {
    const thread = addCompletedThread({ title: "Retry" });
    vi.spyOn(gitWorktrees, "removeWorktree").mockRejectedValue(new Error("transient lock"));

    await worker.poll();
    expect(cleanupJobRepo.findByThreadId(thread.id)).toMatchObject({ attempts: 1 });
    worker.dispose();
    worker = createWorker();

    for (let attempt = 1; attempt < MAX_CLEANUP_ATTEMPTS; attempt += 1) {
      database.prepare("UPDATE cleanup_jobs SET next_retry_at = 0 WHERE thread_id = ?").run(thread.id);
      await worker.poll();
    }

    expect(cleanupJobRepo.findByThreadId(thread.id)).toBeNull();
    expect(threadRepo.findById(thread.id)).toMatchObject({
      cleanup_state: "blocked",
      cleanup_reason: `Cleanup failed after ${MAX_CLEANUP_ATTEMPTS} attempts.`,
    });
    expect(NodeFS.existsSync(worktreePath)).toBe(true);

    expect(threadRepo.reopen(thread.id)).toMatchObject({
      cleanup_state: null,
      user_completed_at: null,
    });
  }, 45_000);
});
