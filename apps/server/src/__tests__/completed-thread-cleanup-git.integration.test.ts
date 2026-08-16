import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { ThreadRepo } from "../repositories/thread-repo";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "../repositories/cleanup-job-repo";
import { CleanupWorker } from "../services/cleanup-worker";
import { GitService } from "../features/projects/index.js";
import { RealGitExecutor } from "../services/git-executor/real-git-executor";
import type { ClaudeProvider } from "../providers/claude/claude-provider";
import type { TerminalBackend } from "../terminal/terminal-backend";
import type { AttachmentService } from "../services/attachment-service";
import type { HandoffStorage } from "../features/handoff/index.js";

vi.mock("../services/process-kill.js", () => ({
  killDescendantsByName: vi.fn().mockResolvedValue(undefined),
}));

describe("completed thread cleanup Git safety", () => {
  let database: Database.Database;
  let repositoryPath: string;
  let worktreePath: string;
  let service: GitService;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let worker: CleanupWorker;

  beforeEach(() => {
    repositoryPath = mkdtempSync(join(tmpdir(), "mcode-completed-cleanup-"));
    worktreePath = join(repositoryPath, "worktree");
    execFileSync("git", ["-C", repositoryPath, "init", "-b", "main"]);
    execFileSync("git", ["-C", repositoryPath, "config", "user.email", "test@mcode.test"]);
    execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Mcode Test"]);
    writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n");
    execFileSync("git", ["-C", repositoryPath, "add", "tracked.txt"]);
    execFileSync("git", ["-C", repositoryPath, "commit", "-m", "initial"]);
    execFileSync("git", ["-C", repositoryPath, "worktree", "add", "--detach", worktreePath, "main"]);
    database = openMemoryDatabase();
    workspaceRepo = new WorkspaceRepo(database);
    threadRepo = new ThreadRepo(database);
    cleanupJobRepo = new CleanupJobRepo(database);
    service = new GitService(workspaceRepo, new RealGitExecutor());
    worker = createWorker();
  }, 30_000);

  afterEach(() => {
    worker.dispose();
    database.close();
    rmSync(repositoryPath, { recursive: true, force: true });
  }, 30_000);

  function createWorker(): CleanupWorker {
    return new CleanupWorker(
      database,
      cleanupJobRepo,
      threadRepo,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider,
      { killByThread: vi.fn().mockResolvedValue(undefined) } as unknown as TerminalBackend,
      service,
      workspaceRepo,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
    );
  }

  function addCompletedThread(options: {
    title: string;
    mode?: "direct" | "worktree";
    path?: string | null;
    managed?: boolean;
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
      options.managed ?? true,
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
    await expect(service.assessBranchlessWorktreeRemoval(worktreePath, "main")).resolves.toEqual({
      safe: true,
      reason: "clean",
    });
  }, 30_000);

  it("rejects a worktree with uncommitted changes", async () => {
    writeFileSync(join(worktreePath, "tracked.txt"), "changed\n");

    await expect(service.assessBranchlessWorktreeRemoval(worktreePath, "main")).resolves.toEqual({
      safe: false,
      reason: "dirty",
    });
  }, 30_000);

  it("rejects a branchless worktree with a unique commit", async () => {
    writeFileSync(join(worktreePath, "unique.txt"), "unique\n");
    execFileSync("git", ["-C", worktreePath, "add", "unique.txt"]);
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "unique"]);

    await expect(service.assessBranchlessWorktreeRemoval(worktreePath, "main")).resolves.toEqual({
      safe: false,
      reason: "unique_commits",
    });
  }, 30_000);

  it("deletes an expired direct thread without repository cleanup", async () => {
    const thread = addCompletedThread({ title: "Direct", mode: "direct", path: null });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(existsSync(worktreePath)).toBe(true);
  }, 30_000);

  it("removes a clean managed branchless worktree without deleting a branch", async () => {
    const thread = addCompletedThread({ title: "Clean" });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
    expect(existsSync(worktreePath)).toBe(false);
    expect(execFileSync("git", ["-C", repositoryPath, "branch", "--list", "main"], { encoding: "utf8" }))
      .toContain("main");
  }, 30_000);

  it("keeps a dirty managed worktree and blocks cleanup", async () => {
    writeFileSync(join(worktreePath, "tracked.txt"), "changed\n");
    const thread = addCompletedThread({ title: "Dirty" });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toMatchObject({
      cleanup_state: "blocked",
      cleanup_reason: "The worktree has uncommitted changes.",
    });
    expect(existsSync(worktreePath)).toBe(true);
  }, 30_000);

  it("keeps a shared worktree while another linked thread remains", async () => {
    const due = addCompletedThread({ title: "Due" });
    const remaining = addCompletedThread({
      title: "Remaining",
      deadline: "2099-08-12T09:01:00.000Z",
    });

    await worker.poll();

    expect(threadRepo.findById(due.id)).toBeNull();
    expect(threadRepo.findById(remaining.id)).not.toBeNull();
    expect(existsSync(worktreePath)).toBe(true);
  }, 30_000);

  it("blocks unmanaged worktrees", async () => {
    const thread = addCompletedThread({ title: "Unmanaged", managed: false });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toMatchObject({ cleanup_state: "blocked" });
    expect(existsSync(worktreePath)).toBe(true);
  }, 30_000);

  it("blocks named checkouts without deleting their branch", async () => {
    execFileSync("git", ["-C", repositoryPath, "branch", "mcode/named", "main"]);
    const thread = addCompletedThread({
      title: "Named",
      checkoutState: "named",
      baseBranch: null,
      branch: "mcode/named",
    });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toMatchObject({ cleanup_state: "blocked" });
    expect(execFileSync("git", ["-C", repositoryPath, "branch", "--list", "mcode/named"], { encoding: "utf8" }))
      .toContain("mcode/named");
  }, 30_000);

  it("blocks branchless worktrees with unique commits", async () => {
    writeFileSync(join(worktreePath, "unique.txt"), "unique\n");
    execFileSync("git", ["-C", worktreePath, "add", "unique.txt"]);
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "unique"]);
    const thread = addCompletedThread({ title: "Unique" });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toMatchObject({
      cleanup_state: "blocked",
      cleanup_reason: "The branchless worktree has commits that are not in its base branch.",
    });
    expect(existsSync(worktreePath)).toBe(true);
  }, 30_000);

  it("deletes a thread when its registered worktree path is already missing", async () => {
    const thread = addCompletedThread({ title: "Missing" });
    rmSync(worktreePath, { recursive: true, force: true });

    await worker.poll();

    expect(threadRepo.findById(thread.id)).toBeNull();
  }, 30_000);

  it("preserves retry state across worker restart and blocks after exhaustion", async () => {
    const thread = addCompletedThread({ title: "Retry" });
    vi.spyOn(service, "removeWorktree").mockRejectedValue(new Error("transient lock"));

    await worker.poll();
    expect(cleanupJobRepo.findByThreadId(thread.id)).toMatchObject({ attempts: 1 });
    worker.dispose();
    worker = createWorker();

    for (let attempt = 1; attempt < MAX_CLEANUP_ATTEMPTS; attempt += 1) {
      database.prepare("UPDATE cleanup_jobs SET next_retry_at = 0 WHERE thread_id = ?").run(thread.id);
      await worker.poll();
    }

    expect(cleanupJobRepo.findByThreadId(thread.id)).toMatchObject({
      attempts: MAX_CLEANUP_ATTEMPTS,
    });
    expect(threadRepo.findById(thread.id)).toMatchObject({
      cleanup_state: "blocked",
      cleanup_reason: `Cleanup failed after ${MAX_CLEANUP_ATTEMPTS} attempts.`,
    });
    expect(existsSync(worktreePath)).toBe(true);
  }, 45_000);
});
