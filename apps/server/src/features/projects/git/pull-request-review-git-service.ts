import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { inject, injectable } from "tsyringe";
import { getMcodeDir, logger, validateWorktreeName } from "@mcode/shared";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";
import { WorktreeDirectoryRemover } from "../worktrees/worktree-directory-remover.js";
import type { GitExecutor } from "./execution/index.js";
import {
  GitRepositoryService,
  normalizeRemoteIdentity,
  normalizedRepositoryKey,
  type NormalizedGitRemote,
} from "./git-repository-service.js";
import {
  ensureManagedWorktreeBaseDir,
  getManagedWorktreeBaseDir,
  isPathWithin,
} from "./managed-worktree-paths.js";
import { RepositoryGitMutationLock } from "./repository-git-mutation-lock.js";

/** Immutable pull request head needed for local Review worktree setup. */
export interface PullRequestReviewGitSource {
  repositoryNodeId: string;
  pullRequestNumber: number;
  baseRepositoryUrl: string;
  headRepositoryNodeId: string;
  headRepositoryUrl: string;
  headOwner: string;
  headRef: string;
  headOid: string;
}

/** Registered compatible worktree offered through an opaque server-issued ID. */
export interface PullRequestReviewGitCandidate {
  candidateId: string;
  name: string;
  path: string;
  branch: string;
  managed: boolean;
}

/** Result of provisioning or explicitly reusing a local Review worktree. */
export type PullRequestReviewGitProvisionResult =
  | { kind: "requires_reuse"; candidate: PullRequestReviewGitCandidate }
  | {
      kind: "ready";
      disposition: "created" | "reused";
      path: string;
      name: string;
      branch: string;
      managed: boolean;
      pushRemote: string;
      pushRef: string;
      managedRemoteName: string | null;
      rollback: () => Promise<void>;
    };

/** Confirmed choice for creating or reusing a Review worktree. */
export type PullRequestReviewGitProvisionRequest =
  | { action: "create_new"; worktreeName: string }
  | { action: "reuse_existing"; candidateId: string };

/** Typed local Git failure translated to a pull request RPC error. */
export class PullRequestReviewGitError extends Error {
  constructor(
    readonly code: "workspace_mapping_missing" | "head_missing" | "branch_occupied" | "branch_diverged" | "path_collision" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "PullRequestReviewGitError";
  }
}

interface ReviewBranchRecord {
  name: string;
  oid: string;
  upstream: string;
  worktreePath: string;
}

interface ReviewProvisionAttempt {
  repoPath: string;
  remoteName: string;
  createdRemote: boolean;
  remoteTrackingRef: string;
  previousRemoteTrackingOid: string | null;
  fetchedOid: string;
  immutableRef: string;
  createdImmutableRef: boolean;
  createdWorktreePath: string | null;
  createdBranch: string | null;
}

function safeReviewRefComponent(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${readable.slice(0, 30) || "repository"}-${hash}`;
}

function sanitizeReviewBranchPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/\.{2,}/g, ".").replace(/[/.]+$/g, "").replace(/^[-/.]+/g, "") || "review";
}

function sanitizeReviewBranchAtom(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "") || "review";
}

function assertSafeReviewBranch(value: string, label: string): void {
  if (value.length === 0 || value.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.includes("@{") || value.endsWith("/") || value.endsWith(".") || value.includes("//")) {
    throw new PullRequestReviewGitError("head_missing", `${label} is not a safe Git branch ref.`);
  }
}

/** Provisions and validates Review worktrees for immutable pull request heads. */
@injectable()
export class PullRequestReviewGitService {
  private readonly worktreeDirectoryRemover: WorktreeDirectoryRemover;
  private readonly repositoryMutationLock: RepositoryGitMutationLock;
  private readonly gitRepository: GitRepositoryService;

  constructor(
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(GitRepositoryService)
    gitRepository: GitRepositoryService,
    @inject(WorktreeDirectoryRemover, { isOptional: true })
    worktreeDirectoryRemover?: WorktreeDirectoryRemover,
    @inject(RepositoryGitMutationLock, { isOptional: true })
    repositoryMutationLock?: RepositoryGitMutationLock,
  ) {
    this.worktreeDirectoryRemover = worktreeDirectoryRemover ?? new WorktreeDirectoryRemover();
    this.repositoryMutationLock = repositoryMutationLock ?? new RepositoryGitMutationLock();
    this.gitRepository = gitRepository;
  }

  /** Resolve a server-owned Review worktree leaf beneath the managed worktree root. */
  getReviewWorktreeDestination(repoPath: string, worktreeName: string): string {
    validateWorktreeName(worktreeName);
    const base = resolve(getManagedWorktreeBaseDir(repoPath));
    const destination = resolve(base, worktreeName);
    if (!isPathWithin(base, destination) || normalizePathForComparison(base) === normalizePathForComparison(destination)) {
      throw new PullRequestReviewGitError(
        "path_collision",
        "The Review worktree destination is outside managed storage.",
      );
    }
    return destination;
  }

  /** Find existing registered worktrees that exactly track the immutable pull request head. */
  async findCompatiblePullRequestReviewWorktrees(
    repoPath: string,
    source: PullRequestReviewGitSource,
  ): Promise<PullRequestReviewGitCandidate[]> {
    this.validatePullRequestReviewSource(source);
    const remotes = await this.gitRepository.listNormalizedRemotes(repoPath);
    const headKey = normalizedRepositoryKey(source.headRepositoryUrl);
    if (!headKey) return [];
    const matchingRemotes = remotes.filter(
      (item) => normalizedRepositoryKey(item.webUrl) === headKey,
    );
    const safeRemotes: NormalizedGitRemote[] = [];
    for (const remote of matchingRemotes) {
      if (await this.remotePushTargetMatches(repoPath, remote, headKey)) {
        safeRemotes.push(remote);
      }
    }
    if (safeRemotes.length === 0) return [];
    const branches = await this.listReviewBranches(repoPath);
    const matches = safeRemotes.flatMap((remote) =>
      branches
        .filter((branch) =>
          branch.oid.toLowerCase() === source.headOid.toLowerCase()
          && branch.upstream === `${remote.name}/${source.headRef}`
          && branch.worktreePath.length > 0,
        )
        .map((branch) => ({ remote, branch })),
    ).slice(0, 20);
    const candidates = await Promise.all(matches.map(({ remote, branch }) =>
      this.toReviewCandidate(repoPath, source, remote.name, branch),
    ));
    return candidates.filter((candidate): candidate is PullRequestReviewGitCandidate => candidate !== null);
  }

  /**
   * Fetch and verify an exact pull request head, then create or explicitly reuse
   * a compatible worktree without changing the Workspace checkout.
   */
  async provisionPullRequestReviewWorktree(
    repoPath: string,
    source: PullRequestReviewGitSource,
    request: PullRequestReviewGitProvisionRequest,
  ): Promise<PullRequestReviewGitProvisionResult> {
    return this.withReviewWorktreeMutationLock(repoPath, () =>
      this.provisionPullRequestReviewWorktreeLocked(repoPath, source, request),
    );
  }

  /** Hold the repository mutation lock through provisioning and caller persistence. */
  async provisionPullRequestReviewWorktreeAndCommit<T>(
    repoPath: string,
    source: PullRequestReviewGitSource,
    request: PullRequestReviewGitProvisionRequest,
    commit: (
      provisioned: Extract<PullRequestReviewGitProvisionResult, { kind: "ready" }>,
    ) => Promise<T> | T,
  ): Promise<
    | Extract<PullRequestReviewGitProvisionResult, { kind: "requires_reuse" }>
    | { kind: "committed"; value: T }
  > {
    return this.withReviewWorktreeMutationLock(repoPath, async () => {
      const provisioned = await this.provisionPullRequestReviewWorktreeLocked(
        repoPath,
        source,
        request,
      );
      if (provisioned.kind === "requires_reuse") return provisioned;
      try {
        return { kind: "committed" as const, value: await commit(provisioned) };
      } catch (error) {
        await provisioned.rollback();
        throw error;
      }
    });
  }

  private async provisionPullRequestReviewWorktreeLocked(
    repoPath: string,
    source: PullRequestReviewGitSource,
    request: PullRequestReviewGitProvisionRequest,
  ): Promise<PullRequestReviewGitProvisionResult> {
    this.validatePullRequestReviewSource(source);
    const attempt = await this.preparePullRequestReviewFetch(repoPath, source);
    let completed = false;

    try {
      const branches = await this.listReviewBranches(repoPath);
      const expectedUpstream = `${attempt.remoteName}/${source.headRef}`;
      const compatibleBranches = branches
        .filter((branch) =>
          branch.oid.toLowerCase() === source.headOid.toLowerCase()
          && branch.upstream === expectedUpstream
          && branch.worktreePath.length > 0,
        );
      const compatibleWorktrees = (
        await Promise.all(
          compatibleBranches.map((branch) =>
            this.toReviewCandidate(repoPath, source, attempt.remoteName, branch),
          ),
        )
      ).filter((candidate): candidate is PullRequestReviewGitCandidate => candidate !== null);

      if (request.action === "reuse_existing") {
        const candidate = compatibleWorktrees.find(
          (item) => item.candidateId === request.candidateId,
        );
        if (!candidate) {
          throw new PullRequestReviewGitError(
            "conflict",
            "The selected Review worktree is no longer compatible with this pull request head.",
          );
        }
        await this.deleteReviewImmutableRef(attempt);
        completed = true;
        return {
          kind: "ready",
          disposition: "reused",
          path: candidate.path,
          name: candidate.name,
          branch: candidate.branch,
          managed: candidate.managed,
          pushRemote: attempt.remoteName,
          pushRef: source.headRef,
          managedRemoteName: attempt.createdRemote ? attempt.remoteName : null,
          rollback: this.createReviewRollback(attempt),
        };
      }

      if (compatibleWorktrees.length > 0) {
        await this.rollbackPullRequestReviewAttempt(attempt);
        completed = true;
        return { kind: "requires_reuse", candidate: compatibleWorktrees[0]! };
      }

      const destination = this.getReviewWorktreeDestination(repoPath, request.worktreeName);
      await this.assertFreshManagedReviewDestination(repoPath, destination);
      const selected = await this.selectReviewBranch(
        repoPath,
        source,
        attempt.remoteName,
        branches,
      );

      attempt.createdWorktreePath = destination;
      if (selected.created) {
        attempt.createdBranch = selected.name;
        await this.gitExecutor.exec(
          ["-C", repoPath, "worktree", "add", "-b", selected.name, destination, attempt.immutableRef],
          { timeout: 60_000 },
        );
      } else {
        await this.gitExecutor.exec(
          ["-C", repoPath, "worktree", "add", destination, selected.name],
          { timeout: 60_000 },
        );
      }
      const canonicalDestination = await realpath(destination);
      const canonicalBase = await realpath(getManagedWorktreeBaseDir(repoPath));
      if (!isPathWithin(canonicalBase, canonicalDestination)) {
        throw new PullRequestReviewGitError(
          "path_collision",
          "The created Review worktree escaped managed storage.",
        );
      }
      attempt.createdWorktreePath = canonicalDestination;
      if (selected.created) {
        await this.gitExecutor.exec(
          [
            "-C",
            repoPath,
            "branch",
            `--set-upstream-to=${attempt.remoteName}/${source.headRef}`,
            selected.name,
          ],
          { timeout: 10_000 },
        );
      }
      await this.deleteReviewImmutableRef(attempt);
      completed = true;
      return {
        kind: "ready",
        disposition: "created",
        path: canonicalDestination,
        name: request.worktreeName,
        branch: selected.name,
        managed: true,
        pushRemote: attempt.remoteName,
        pushRef: source.headRef,
        managedRemoteName: attempt.createdRemote ? attempt.remoteName : null,
        rollback: this.createReviewRollback(attempt),
      };
    } catch (error) {
      if (!completed) await this.rollbackPullRequestReviewAttempt(attempt);
      throw error;
    }
  }

  /** Push one linked Review branch to its persisted explicit target without force. */
  async pushPullRequestReviewBranch(
    repoPath: string,
    pushRemote: string,
    pushRef: string,
    expectedHeadRepositoryUrl: string,
  ): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(pushRemote)) {
      throw new Error("Invalid Review push remote.");
    }
    assertSafeReviewBranch(pushRef, "Review push ref");
    const expectedRepositoryKey = normalizedRepositoryKey(expectedHeadRepositoryUrl);
    const remote = (await this.gitRepository.listNormalizedRemotes(repoPath)).find(
      (item) => item.name === pushRemote,
    );
    if (
      !expectedRepositoryKey
      || !remote
      || normalizedRepositoryKey(remote.webUrl) !== expectedRepositoryKey
      || !(await this.remotePushTargetMatches(repoPath, remote, expectedRepositoryKey))
    ) {
      throw new PullRequestReviewGitError(
        "conflict",
        "The Review push remote no longer targets the pull request head repository.",
      );
    }
    await this.gitExecutor.exec(
      ["-C", repoPath, "fetch", "--no-tags", pushRemote, `refs/heads/${pushRef}`],
      { timeout: 60_000 },
    );
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"],
        { timeout: 10_000 },
      );
    } catch {
      throw new PullRequestReviewGitError(
        "branch_diverged",
        "The remote pull request branch advanced outside this local branch.",
      );
    }
    await this.gitExecutor.exec(
      ["-C", repoPath, "push", pushRemote, `HEAD:refs/heads/${pushRef}`],
      { timeout: 60_000 },
    );
  }

  /** Serialize Review provisioning and cleanup mutations for one repository. */
  async withReviewWorktreeMutationLock<T>(
    repoPath: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.repositoryMutationLock.run(repoPath, work);
  }

  private validatePullRequestReviewSource(source: PullRequestReviewGitSource): void {
    if (
      !source.repositoryNodeId
      || source.repositoryNodeId.length > 256
      || !source.headRepositoryNodeId
      || source.headRepositoryNodeId.length > 256
      || !Number.isInteger(source.pullRequestNumber)
      || source.pullRequestNumber <= 0
      || source.pullRequestNumber > 2_147_483_647
      || !/^[0-9a-f]{40,64}$/i.test(source.headOid)
      || !normalizedRepositoryKey(source.baseRepositoryUrl)
      || !normalizedRepositoryKey(source.headRepositoryUrl)
    ) {
      throw new PullRequestReviewGitError(
        "head_missing",
        "The pull request head metadata is invalid.",
      );
    }
    assertSafeReviewBranch(source.headRef, "Pull request head ref");
  }

  private async listReviewBranches(repoPath: string): Promise<ReviewBranchRecord[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.gitExecutor.exec(
        [
          "-C",
          repoPath,
          "for-each-ref",
          "--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(worktreepath)",
          "refs/heads",
        ],
        { timeout: 10_000 },
      ));
    } catch {
      return [];
    }
    return stdout
      .split("\n")
      .slice(0, 1_024)
      .flatMap((line) => {
        if (!line) return [];
        const [name = "", oid = "", upstream = "", worktreePath = ""] = line.split("\t");
        if (!name || !/^[0-9a-f]{40,64}$/i.test(oid)) return [];
        return [{ name, oid, upstream, worktreePath }];
      });
  }

  private async toReviewCandidate(
    repoPath: string,
    source: PullRequestReviewGitSource,
    remoteName: string,
    branch: ReviewBranchRecord,
  ): Promise<PullRequestReviewGitCandidate | null> {
    if (!branch.worktreePath || !existsSync(branch.worktreePath)) return null;
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(branch.worktreePath);
    } catch {
      return null;
    }
    const normalizedPath = normalizePathForComparison(canonicalPath);
    const candidateId = createHash("sha256")
      .update([
        normalizePathForComparison(repoPath),
        source.repositoryNodeId,
        String(source.pullRequestNumber),
        source.headOid.toLowerCase(),
        remoteName,
        branch.name,
        normalizedPath,
      ].join("\0"))
      .digest("base64url");
    let managed = false;
    const managedRoot = getManagedWorktreeBaseDir(repoPath);
    if (existsSync(managedRoot)) {
      try {
        const canonicalManagedRoot = await realpath(managedRoot);
        managed = isPathWithin(canonicalManagedRoot, canonicalPath);
      } catch {
        managed = false;
      }
    }
    return {
      candidateId,
      name: (basename(canonicalPath) || "worktree").slice(0, 100),
      path: canonicalPath,
      branch: branch.name,
      managed,
    };
  }

  private async preparePullRequestReviewFetch(
    repoPath: string,
    source: PullRequestReviewGitSource,
  ): Promise<ReviewProvisionAttempt> {
    if (!existsSync(repoPath)) {
      throw new PullRequestReviewGitError(
        "workspace_mapping_missing",
        "The mapped Workspace repository is unavailable.",
      );
    }
    const remotes = await this.gitRepository.listNormalizedRemotes(repoPath);
    const baseKey = normalizedRepositoryKey(source.baseRepositoryUrl)!;
    const headKey = normalizedRepositoryKey(source.headRepositoryUrl)!;
    const baseRemote = remotes.find(
      (remote) => normalizedRepositoryKey(remote.webUrl) === baseKey,
    );
    if (!baseRemote) {
      throw new PullRequestReviewGitError(
        "workspace_mapping_missing",
        "The mapped Workspace no longer has a matching repository remote.",
      );
    }

    let remote: NormalizedGitRemote | undefined;
    for (const candidate of remotes.filter(
      (item) => normalizedRepositoryKey(item.webUrl) === headKey,
    )) {
      if (await this.remotePushTargetMatches(repoPath, candidate, headKey)) {
        remote = candidate;
        break;
      }
    }
    let createdRemote = false;
    if (
      !remote
      && baseKey === headKey
      && await this.remotePushTargetMatches(repoPath, baseRemote, headKey)
    ) {
      remote = baseRemote;
    }
    if (!remote) {
      const remoteName = `mcode-pr-${createHash("sha256")
        .update(source.headRepositoryNodeId)
        .digest("hex")
        .slice(0, 12)}`;
      try {
        await this.gitExecutor.exec(
          ["-C", repoPath, "remote", "add", remoteName, source.headRepositoryUrl],
          { timeout: 10_000 },
        );
      } catch {
        throw new PullRequestReviewGitError(
          "conflict",
          `The managed remote ${remoteName} already exists with another repository URL.`,
        );
      }
      createdRemote = true;
      remote = {
        name: remoteName,
        rawUrl: source.headRepositoryUrl,
        ...normalizeRemoteIdentity(source.headRepositoryUrl)!,
      };
    }

    const remoteTrackingRef = `refs/remotes/${remote.name}/${source.headRef}`;
    const immutableRef = `refs/mcode/pull-requests/${safeReviewRefComponent(source.repositoryNodeId)}/${source.pullRequestNumber}/${source.headOid.toLowerCase()}`;
    const previousRemoteTrackingOid = await this.readReviewRefOid(repoPath, remoteTrackingRef);
    const attempt: ReviewProvisionAttempt = {
      repoPath,
      remoteName: remote.name,
      createdRemote,
      remoteTrackingRef,
      previousRemoteTrackingOid,
      fetchedOid: source.headOid.toLowerCase(),
      immutableRef,
      createdImmutableRef: false,
      createdWorktreePath: null,
      createdBranch: null,
    };

    try {
      await this.gitExecutor.exec(
        [
          "-C",
          repoPath,
          "fetch",
          "--no-tags",
          remote.name,
          `+refs/heads/${source.headRef}:${remoteTrackingRef}`,
        ],
        { timeout: 60_000 },
      );
      const fetchedOid = await this.readReviewRefOid(repoPath, "FETCH_HEAD");
      if (!fetchedOid || fetchedOid.toLowerCase() !== source.headOid.toLowerCase()) {
        throw new PullRequestReviewGitError(
          "conflict",
          "The pull request head changed while the Review worktree was being prepared.",
        );
      }

      const existingImmutableOid = await this.readReviewRefOid(repoPath, immutableRef);
      if (existingImmutableOid && existingImmutableOid.toLowerCase() !== fetchedOid.toLowerCase()) {
        throw new PullRequestReviewGitError(
          "conflict",
          "The immutable pull request ref is already owned by another head.",
        );
      }
      if (!existingImmutableOid) {
        try {
          await this.gitExecutor.exec(
            ["-C", repoPath, "update-ref", immutableRef, fetchedOid, ""],
            { timeout: 10_000 },
          );
          attempt.createdImmutableRef = true;
        } catch {
          const racedOid = await this.readReviewRefOid(repoPath, immutableRef);
          if (!racedOid || racedOid.toLowerCase() !== fetchedOid.toLowerCase()) {
            throw new PullRequestReviewGitError(
              "conflict",
              "Another Review worktree setup changed the immutable pull request ref.",
            );
          }
        }
      }
      return attempt;
    } catch (error) {
      await this.rollbackPullRequestReviewAttempt(attempt);
      throw error;
    }
  }

  private async readReviewRefOid(repoPath: string, ref: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--verify", `${ref}^{commit}`],
        { timeout: 5_000 },
      );
      const oid = stdout.trim();
      return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
    } catch {
      return null;
    }
  }

  private async selectReviewBranch(
    repoPath: string,
    source: PullRequestReviewGitSource,
    remoteName: string,
    branches: ReviewBranchRecord[],
  ): Promise<{ name: string; created: boolean }> {
    const baseKey = normalizedRepositoryKey(source.baseRepositoryUrl);
    const headKey = normalizedRepositoryKey(source.headRepositoryUrl);
    const exactHeadName = baseKey === headKey && source.headRef.length <= 100
      ? source.headRef
      : null;
    const fallback = sanitizeReviewBranchPart(
      `mcode/pr-${source.pullRequestNumber}-${sanitizeReviewBranchAtom(source.headOwner)}-${sanitizeReviewBranchAtom(source.headRef)}-${source.headOid.slice(0, 7)}`,
    ).slice(0, 100);
    const names: string[] = [];
    if (exactHeadName) names.push(exactHeadName);
    for (let suffix = 1; suffix <= 99; suffix++) {
      const suffixText = suffix === 1 ? "" : `-${suffix}`;
      names.push(`${fallback.slice(0, 100 - suffixText.length)}${suffixText}`);
    }

    let sawDivergence = false;
    for (const name of [...new Set(names)]) {
      try {
        assertSafeReviewBranch(name, "Review branch");
        await this.gitExecutor.exec(
          ["-C", repoPath, "check-ref-format", "--branch", name],
          { timeout: 5_000 },
        );
      } catch {
        continue;
      }
      const existing = branches.find((branch) => branch.name === name);
      if (!existing) return { name, created: true };
      if (
        !existing.worktreePath
        && existing.oid.toLowerCase() === source.headOid.toLowerCase()
        && existing.upstream === `${remoteName}/${source.headRef}`
      ) {
        return { name, created: false };
      }
      sawDivergence = true;
    }
    throw new PullRequestReviewGitError(
      sawDivergence ? "branch_diverged" : "branch_occupied",
      sawDivergence
        ? "Every safe Review branch candidate is occupied by different history or tracking."
        : "No safe local Review branch name is available.",
    );
  }

  private async assertFreshManagedReviewDestination(
    repoPath: string,
    destination: string,
  ): Promise<void> {
    if (existsSync(destination)) {
      throw new PullRequestReviewGitError(
        "path_collision",
        "The Review worktree destination already exists.",
      );
    }
    const managedRoot = resolve(getMcodeDir(), "worktrees");
    mkdirSync(managedRoot, { recursive: true });
    const base = ensureManagedWorktreeBaseDir(repoPath);
    const [realManagedRoot, realBase] = await Promise.all([
      realpath(managedRoot),
      realpath(base),
    ]);
    if (!isPathWithin(realManagedRoot, realBase) || !isPathWithin(realBase, destination)) {
      throw new PullRequestReviewGitError(
        "path_collision",
        "The Review worktree destination escapes managed storage.",
      );
    }
  }

  private async deleteReviewImmutableRef(attempt: ReviewProvisionAttempt): Promise<void> {
    if (!attempt.createdImmutableRef) return;
    try {
      await this.gitExecutor.exec(
        [
          "-C",
          attempt.repoPath,
          "update-ref",
          "-d",
          attempt.immutableRef,
          attempt.fetchedOid,
        ],
        { timeout: 10_000 },
      );
      attempt.createdImmutableRef = false;
    } catch (error) {
      logger.warn("Failed to remove attempt-owned immutable pull request ref", {
        ref: attempt.immutableRef,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createReviewRollback(attempt: ReviewProvisionAttempt): () => Promise<void> {
    let rolledBack = false;
    return async () => {
      if (rolledBack) return;
      rolledBack = true;
      await this.withReviewWorktreeMutationLock(attempt.repoPath, () =>
        this.rollbackPullRequestReviewAttempt(attempt),
      );
    };
  }

  private async rollbackPullRequestReviewAttempt(attempt: ReviewProvisionAttempt): Promise<void> {
    if (attempt.createdWorktreePath) {
      try {
        await this.gitExecutor.exec(
          [
            "-C",
            attempt.repoPath,
            "worktree",
            "remove",
            attempt.createdWorktreePath,
            "--force",
            "--force",
          ],
          { timeout: 30_000 },
        );
      } catch {
        if (isPathWithin(getManagedWorktreeBaseDir(attempt.repoPath), attempt.createdWorktreePath)) {
          await this.worktreeDirectoryRemover.remove(attempt.createdWorktreePath).catch(() => undefined);
          await this.gitExecutor.exec(
            [
              "-C",
              attempt.repoPath,
              "worktree",
              "remove",
              attempt.createdWorktreePath,
              "--force",
              "--force",
            ],
            { timeout: 10_000 },
          ).catch(() => undefined);
        }
      }
      attempt.createdWorktreePath = null;
    }
    if (attempt.createdBranch) {
      await this.gitExecutor.exec(
        ["-C", attempt.repoPath, "update-ref", "-d", `refs/heads/${attempt.createdBranch}`, attempt.fetchedOid],
        { timeout: 10_000 },
      ).catch(() => undefined);
      attempt.createdBranch = null;
    }
    await this.deleteReviewImmutableRef(attempt);

    const currentTrackingOid = await this.readReviewRefOid(
      attempt.repoPath,
      attempt.remoteTrackingRef,
    );
    if (currentTrackingOid?.toLowerCase() === attempt.fetchedOid.toLowerCase()) {
      if (attempt.previousRemoteTrackingOid) {
        await this.gitExecutor.exec(
          [
            "-C",
            attempt.repoPath,
            "update-ref",
            attempt.remoteTrackingRef,
            attempt.previousRemoteTrackingOid,
            attempt.fetchedOid,
          ],
          { timeout: 10_000 },
        ).catch(() => undefined);
      } else {
        await this.gitExecutor.exec(
          ["-C", attempt.repoPath, "update-ref", "-d", attempt.remoteTrackingRef, attempt.fetchedOid],
          { timeout: 10_000 },
        ).catch(() => undefined);
      }
    }

    if (attempt.createdRemote && !(await this.isReviewRemoteReferenced(attempt.repoPath, attempt.remoteName))) {
      await this.gitExecutor.exec(
        ["-C", attempt.repoPath, "remote", "remove", attempt.remoteName],
        { timeout: 10_000 },
      ).catch(() => undefined);
      attempt.createdRemote = false;
    }
  }

  private async isReviewRemoteReferenced(repoPath: string, remoteName: string): Promise<boolean> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "config", "--get-regexp", "^branch\\..*\\.remote$"],
        { timeout: 5_000 },
      );
      return stdout
        .split("\n")
        .slice(0, 1_024)
        .some((line) => line.trim().endsWith(` ${remoteName}`));
    } catch {
      return false;
    }
  }

  private async remotePushTargetMatches(
    repoPath: string,
    remote: NormalizedGitRemote,
    expectedRepositoryKey: string,
  ): Promise<boolean> {
    let pushUrls: string[] = [];
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "config", "--get-all", `remote.${remote.name}.pushurl`],
        { timeout: 5_000 },
      );
      pushUrls = stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 8);
    } catch {
      pushUrls = [];
    }
    const effectiveUrls = pushUrls.length > 0 ? pushUrls : [remote.rawUrl];
    return effectiveUrls.every(
      (url) => normalizedRepositoryKey(url) === expectedRepositoryKey,
    );
  }

}
