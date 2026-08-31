import "reflect-metadata";
import type Database from "better-sqlite3";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { FakeGitExecutor } from "../execution/fake-git-executor.js";
import type { GitExecOptions, GitExecResult } from "../execution/types.js";
import {
  type PullRequestReviewGitSource,
  PullRequestReviewGitService,
} from "../pull-request-review-git-service.js";
import { GitRepositoryService } from "../git-repository-service.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

const headOid = "a".repeat(40);
const source: PullRequestReviewGitSource = {
  repositoryNodeId: "R_mcode",
  pullRequestNumber: 42,
  baseRepositoryUrl: "https://github.com/Mzeey-Empire/mcode",
  headRepositoryNodeId: "R_fork",
  headRepositoryUrl: "https://github.com/contributor/mcode",
  headOwner: "contributor",
  headRef: "feature/review",
  headOid,
};

class WorktreeCreatingGitExecutor extends FakeGitExecutor {
  readonly createdPaths: string[] = [];
  failWorktreeAdd = false;

  override async exec(args: string[], opts?: GitExecOptions): Promise<GitExecResult> {
    const worktreeIndex = args.indexOf("worktree");
    if (worktreeIndex >= 0 && args[worktreeIndex + 1] === "add") {
      const hasBranch = args[worktreeIndex + 2] === "-b";
      const destination = args[worktreeIndex + (hasBranch ? 4 : 2)]!;
      NodeFS.mkdirSync(destination, { recursive: true });
      this.createdPaths.push(destination);
      const result = await super.exec(args, opts);
      if (this.failWorktreeAdd) throw new Error("post-checkout hook failed");
      return result;
    }
    return super.exec(args, opts);
  }
}

describe("PullRequestReviewGitService", () => {
  let db: Database.Database;
  let executor: WorktreeCreatingGitExecutor;
  let service: PullRequestReviewGitService;
  let gitRepository: GitRepositoryService;
  let repoPath: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repoPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-repo-"));
    executor = new WorktreeCreatingGitExecutor();
    const workspaceRepo = new WorkspaceRepo(db);
    gitRepository = new GitRepositoryService(workspaceRepo, executor);
    service = new PullRequestReviewGitService(executor, gitRepository, TEST_HOST_RUNTIME);
    executor.setResponse(
      ["config", "--get-regexp", "^remote\\..*\\.url$"],
      {
        stdout: [
          "remote.origin.url git@github.com:Mzeey-Empire/mcode.git",
          "remote.contrib.url https://github.com/contributor/mcode.git",
        ].join("\n"),
        stderr: "",
      },
    );
    executor.setResponse(
      ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      { stdout: `${headOid}\n`, stderr: "" },
    );
  });

  afterEach(() => {
    for (const path of executor.createdPaths) NodeFS.rmSync(path, { recursive: true, force: true });
    NodeFS.rmSync(repoPath, { recursive: true, force: true });
    db.close();
  });

  it("normalizes SSH and HTTPS remotes in one bounded Git query", async () => {
    await expect(gitRepository.listNormalizedRemotes(repoPath)).resolves.toMatchObject([
      {
        name: "origin",
        host: "github.com",
        repositoryPath: "mzeey-empire/mcode",
      },
      {
        name: "contrib",
        host: "github.com",
        repositoryPath: "contributor/mcode",
      },
    ]);
  });

  it("creates a branch from the verified immutable head without mutating the Workspace checkout", async () => {
    const result = await service.provisionPullRequestReviewWorktree(
      repoPath,
      source,
      { action: "create_new", worktreeName: "pr-42-mcode-aaaaaaa" },
    );

    expect(result).toMatchObject({
      kind: "ready",
      disposition: "created",
      branch: "mcode/pr-42-contributor-feature-review-aaaaaaa",
      pushRemote: "contrib",
      pushRef: "feature/review",
    });
    const commands = executor.calls.map((call) => call.args.slice(2));
    expect(commands).toContainEqual([
      "fetch",
      "--no-tags",
      "contrib",
      "+refs/heads/feature/review:refs/remotes/contrib/feature/review",
    ]);
    expect(commands.some((args) =>
      args[0] === "worktree"
      && args[1] === "add"
      && args.includes("-b")
      && args.at(-1)?.startsWith("refs/mcode/pull-requests/"),
    )).toBe(true);
    expect(commands.some((args) =>
      ["checkout", "switch", "reset", "pull", "push"].includes(args[0] ?? ""),
    )).toBe(false);

    if (result.kind === "ready") await result.rollback();
  });

  it("holds one repository lock through provisioning and the persistence callback", async () => {
    const operation = service.provisionPullRequestReviewWorktreeAndCommit(
      repoPath,
      source,
      { action: "create_new", worktreeName: `single-lock-${Date.now()}` },
      async (provisioned) => ({ branch: provisioned.branch }),
    );

    await expect(Promise.race([
      operation,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 1_000)),
    ])).resolves.toMatchObject({
      kind: "committed",
      value: { branch: "mcode/pr-42-contributor-feature-review-aaaaaaa" },
    });
  });

  it("serializes cleanup work behind a repository provisioning transaction", async () => {
    const events: string[] = [];
    let releaseProvision!: () => void;
    const provisionGate = new Promise<void>((resolveGate) => {
      releaseProvision = resolveGate;
    });
    const provisioning = service.withReviewWorktreeMutationLock(repoPath, async () => {
      events.push("provision-start");
      await provisionGate;
      events.push("provision-end");
    });
    await Promise.resolve();
    const cleanup = service.withReviewWorktreeMutationLock(repoPath, async () => {
      events.push("cleanup");
    });
    await Promise.resolve();

    expect(events).toEqual(["provision-start"]);
    releaseProvision();
    await Promise.all([provisioning, cleanup]);
    expect(events).toEqual(["provision-start", "provision-end", "cleanup"]);
  });

  it("re-enters the same repository lock without deadlock and releases it afterward", async () => {
    const nested = service.withReviewWorktreeMutationLock(repoPath, () =>
      service.withReviewWorktreeMutationLock(repoPath, async () => "nested-complete"),
    );

    await expect(Promise.race([
      nested,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 1_000)),
    ])).resolves.toBe("nested-complete");
    await expect(service.withReviewWorktreeMutationLock(repoPath, async () => "released"))
      .resolves.toBe("released");
  });

  it("offers a compatible occupied worktree through an opaque candidate id", async () => {
    const existingPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-existing-"));
    const branchOutput = [
      "feature/review",
      headOid,
      "contrib/feature/review",
      existingPath,
    ].join("\t");
    executor.setResponse(
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(worktreepath)",
        "refs/heads",
      ],
      { stdout: `${branchOutput}\n`, stderr: "" },
    );

    const result = await service.provisionPullRequestReviewWorktree(
      repoPath,
      source,
      { action: "create_new", worktreeName: "pr-42-mcode-aaaaaaa" },
    );

    expect(result).toMatchObject({
      kind: "requires_reuse",
      candidate: {
        path: NodeFS.realpathSync(existingPath),
        branch: "feature/review",
      },
    });
    if (result.kind === "requires_reuse") {
      expect(result.candidate.candidateId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(
      executor.calls.some((call) => call.args.includes("worktree") && call.args.includes("add")),
    ).toBe(false);
    NodeFS.rmSync(existingPath, { recursive: true, force: true });
  });

  it("ignores stale registered worktree paths", async () => {
    const stalePath = NodePath.join(NodeOS.tmpdir(), `mcode-missing-${Date.now()}`);
    executor.setResponse(
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(worktreepath)",
        "refs/heads",
      ],
      {
        stdout: ["feature/review", headOid, "contrib/feature/review", stalePath].join("\t"),
        stderr: "",
      },
    );

    await expect(
      service.findCompatiblePullRequestReviewWorktrees(repoPath, source),
    ).resolves.toEqual([]);
  });

  it("canonicalizes a junction before deciding whether a reused worktree is managed", async () => {
    const destination = service.getReviewWorktreeDestination(
      repoPath,
      `junction-${Date.now()}`,
    );
    const externalTarget = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-target-"));
    NodeFS.mkdirSync(NodePath.join(destination, ".."), { recursive: true });
    NodeFS.symlinkSync(
      externalTarget,
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );
    executor.setResponse(
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(worktreepath)",
        "refs/heads",
      ],
      {
        stdout: ["feature/review", headOid, "contrib/feature/review", destination].join("\t"),
        stderr: "",
      },
    );

    const [candidate] = await service.findCompatiblePullRequestReviewWorktrees(
      repoPath,
      source,
    );

    expect(candidate).toMatchObject({
      path: NodeFS.realpathSync(externalTarget),
      managed: false,
    });
    NodeFS.rmSync(destination, { recursive: true, force: true });
    NodeFS.rmSync(externalTarget, { recursive: true, force: true });
  });

  it("cleans an exact partially-created branch and worktree without repository-wide prune", async () => {
    executor.failWorktreeAdd = true;

    await expect(
      service.provisionPullRequestReviewWorktree(
        repoPath,
        source,
        { action: "create_new", worktreeName: `partial-${Date.now()}` },
      ),
    ).rejects.toThrow("post-checkout hook failed");

    const commands = executor.calls.map((call) => call.args.slice(2));
    expect(commands.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(true);
    expect(commands).toContainEqual([
      "update-ref",
      "-d",
      "refs/heads/mcode/pr-42-contributor-feature-review-aaaaaaa",
      headOid,
    ]);
    expect(commands.some((args) => args[0] === "worktree" && args[1] === "prune")).toBe(false);
  });

  it("uses a dedicated managed remote when an existing fetch remote pushes elsewhere", async () => {
    executor.setResponse(
      ["config", "--get-all", "remote.contrib.pushurl"],
      { stdout: "https://github.com/attacker/other.git\n", stderr: "" },
    );

    const result = await service.provisionPullRequestReviewWorktree(
      repoPath,
      source,
      { action: "create_new", worktreeName: `push-safe-${Date.now()}` },
    );

    expect(result).toMatchObject({
      kind: "ready",
      pushRemote: expect.stringMatching(/^mcode-pr-[0-9a-f]{12}$/),
      managedRemoteName: expect.stringMatching(/^mcode-pr-[0-9a-f]{12}$/),
    });
    expect(
      executor.calls.some((call) =>
        call.args.includes("remote")
        && call.args.includes("add")
        && call.args.includes(source.headRepositoryUrl),
      ),
    ).toBe(true);
    if (result.kind === "ready") await result.rollback();
  });

  it("selects a later URL-equivalent remote whose effective push target is safe", async () => {
    const existingPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-safe-remote-"));
    executor.setResponse(
      ["config", "--get-regexp", "^remote\\..*\\.url$"],
      {
        stdout: [
          "remote.origin.url git@github.com:Mzeey-Empire/mcode.git",
          "remote.contrib.url https://github.com/contributor/mcode.git",
          "remote.safe.url git@github.com:contributor/mcode.git",
        ].join("\n"),
        stderr: "",
      },
    );
    executor.setResponse(
      ["config", "--get-all", "remote.contrib.pushurl"],
      { stdout: "https://github.com/attacker/other.git\n", stderr: "" },
    );
    executor.setResponse(
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(worktreepath)",
        "refs/heads",
      ],
      {
        stdout: ["feature/review", headOid, "safe/feature/review", existingPath].join("\t"),
        stderr: "",
      },
    );

    const candidates = await service.findCompatiblePullRequestReviewWorktrees(
      repoPath,
      source,
    );
    const result = await service.provisionPullRequestReviewWorktree(
      repoPath,
      source,
      { action: "create_new", worktreeName: `safe-remote-${Date.now()}` },
    );

    expect(candidates).toHaveLength(1);
    expect(result).toMatchObject({ kind: "requires_reuse" });
    expect(
      executor.calls.some((call) => call.args.includes("remote") && call.args.includes("add")),
    ).toBe(false);
    NodeFS.rmSync(existingPath, { recursive: true, force: true });
  });

  it("rejects a head that changed during fetch and does not create a worktree", async () => {
    executor.setResponse(
      ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      { stdout: `${"b".repeat(40)}\n`, stderr: "" },
    );

    await expect(
      service.provisionPullRequestReviewWorktree(
        repoPath,
        source,
        { action: "create_new", worktreeName: "pr-42-mcode-aaaaaaa" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      executor.calls.some((call) => call.args.includes("worktree") && call.args.includes("add")),
    ).toBe(false);
  });

  it("uses the persisted explicit push target and blocks non-ancestor remote heads", async () => {
    executor.setResponse(
      ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"],
      new Error("not an ancestor"),
    );

    await expect(
      service.pushPullRequestReviewBranch(
        repoPath,
        "contrib",
        "feature/review",
        source.headRepositoryUrl,
      ),
    ).rejects.toMatchObject({
      code: "branch_diverged",
    });
    expect(executor.calls.some((call) => call.args.includes("push"))).toBe(false);
  });
});
