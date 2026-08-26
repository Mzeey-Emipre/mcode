/**
 * Git operations service.
 * Manages branches, worktrees, checkout, and fetch operations using the
 * injected GitExecutor abstraction. All git invocations go through the
 * executor so tests can swap in FakeGitExecutor and production code benefits
 * from per-repo serialisation and rev-parse caching.
 */

import { injectable, inject } from "tsyringe";
import { createHash } from "crypto";
import { rmdir, realpath } from "fs/promises";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { join, basename, dirname, resolve, relative, isAbsolute } from "path";
import { getMcodeDir, validateBranchName, validateWorktreeName, logger } from "@mcode/shared";
import type { GitBranch, WorktreeInfo, GitCommit, BranchComparison, GitRemoteUrl, ReviewComparison, ReviewFileChange } from "@mcode/contracts";

const MAX_REVIEW_COMPARISON_FILES = 10_000;
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import type { GitExecutor } from "./execution/index.js";
import { normalizePathForComparison } from "../../../shared/filesystem/path-identity.js";
import { WorktreeDirectoryRemover } from "../worktrees/worktree-directory-remover.js";
import { RepositoryGitMutationLock } from "./repository-git-mutation-lock.js";
import {
  WorktreeSafetyService,
  type BranchlessWorktreeRemovalSafety,
  type NamedWorktreeRemovalSafety,
  type WorktreeRemovalSafety,
} from "./worktree-safety-service.js";

/** Normalized configured remote used for repository-identity matching. */
export interface NormalizedGitRemote {
  name: string;
  rawUrl: string;
  host: string;
  repositoryPath: string;
  webUrl: string;
}

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

export type {
  BranchlessWorktreeRemovalSafety,
  NamedWorktreeRemovalSafety,
  WorktreeRemovalSafety,
} from "./worktree-safety-service.js";

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
  | {
      kind: "requires_reuse";
      candidate: PullRequestReviewGitCandidate;
    }
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

/** Max retries for rmdir on parent directories (handles transient Windows NTFS/AV locks). */
const PARENT_RMDIR_MAX_RETRIES = 5;

/** Delay between rmdir retries in milliseconds. */
const PARENT_RMDIR_RETRY_DELAY_MS = 300;

/**
 * Options for {@link GitService.removeWorktree}.
 * Controls which worktree path is removed and whether the associated branch is deleted.
 */
interface RemoveWorktreeOptions {
  /**
   * Exact branch name to delete after the worktree is removed.
   * When omitted and deleteBranch is true, removeWorktree falls back to `mcode/<worktree-name>`.
   */
  branchName?: string;
  /**
   * Whether removeWorktree should attempt `git branch -d` after cleaning up the worktree.
   * Defaults to true; when false, branchName is ignored and no branch deletion is attempted.
   */
  deleteBranch?: boolean;
  /**
   * Exact filesystem path of the worktree to remove.
   * When omitted, removeWorktree derives the managed path under the mcode worktree directory from the worktree name.
   */
  worktreePath?: string;
  /**
   * Require the supplied path to resolve to a canonical descendant of Mcode's
   * managed worktree root before any Git or filesystem removal is attempted.
   */
  managedCanonicalOnly?: boolean;
}

/** Resolve the worktree base directory path under the mcode data dir. */
function getWorktreeBaseDir(repoPath: string): string {
  return join(getMcodeDir(), "worktrees", worktreeSlug(repoPath));
}

/** Resolve and ensure the worktree base directory exists. */
function ensureWorktreeBaseDir(repoPath: string): string {
  const dir = getWorktreeBaseDir(repoPath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function worktreeSlug(repoPath: string): string {
  return basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * Retry rmdir for transient EBUSY/EPERM locks on Windows.
 * After a child directory is removed, NTFS journal updates, antivirus scans,
 * or the search indexer can briefly hold the parent directory.
 */
async function rmdirWithRetry(dirPath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rmdir(dirPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (
        (code === "EBUSY" || code === "EPERM") &&
        attempt < PARENT_RMDIR_MAX_RETRIES - 1
      ) {
        await new Promise<void>((r) => setTimeout(r, PARENT_RMDIR_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Best-effort cleanup of empty managed parent directories after a worktree is removed.
 * Returns true if all empty parents were removed, false if any failed.
 */
async function removeEmptyManagedParentDirs(wtPath: string): Promise<boolean> {
  const managedRoot = resolve(getMcodeDir(), "worktrees");
  const rel = relative(managedRoot, resolve(wtPath));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return true;
  }

  let current = dirname(resolve(wtPath));
  while (current !== managedRoot) {
    try {
      await rmdirWithRetry(current);
      logger.info("Removed empty managed worktree parent dir", { path: current });
      current = dirname(current);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err
        ? String((err as NodeJS.ErrnoException).code)
        : "";
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        break;
      }
      if (code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      logger.warn("Failed to remove empty managed worktree parent dir", {
        path: current,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  return true;
}

/**
 * Reject a git ref that could smuggle a flag into a git argv (a leading `-`) or
 * contains characters outside what refnames and short SHAs use. Guards the
 * base/target of a Branch comparison before they are interpolated into a rev
 * range; the WS layer also validates via `GitRefSchema`, this is defense in
 * depth for any direct caller.
 */
function assertSafeRef(ref: string): void {
  if (!/^(?!-)[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`Unsafe git ref: ${ref}`);
  }
}

function assertSafeBranchCreationName(name: string): void {
  validateBranchName(name);
  if (!/^(?!-)[A-Za-z0-9._/-]+$/.test(name) || name.includes("..") || name === "HEAD") {
    throw new Error(`Branch name contains invalid characters: ${name}`);
  }
}

function fallbackRemoteUrl(repoPath: string): GitRemoteUrl {
  return {
    webUrl: null,
    label: basename(repoPath) || repoPath,
  };
}

function normalizeRemotePath(pathname: string): string | null {
  const trimmed = pathname.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const withoutGitSuffix = trimmed.replace(/\.git$/i, "");
  if (!withoutGitSuffix || /[\s\\?#]/.test(withoutGitSuffix)) {
    return null;
  }
  const segments = withoutGitSuffix.split("/").filter(Boolean);
  if (segments.length < 2 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function isSafeRemoteHost(host: string): boolean {
  const match = /^(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(?::(?<port>\d{1,5}))?$/.exec(host);
  if (!match) return false;
  const port = match.groups?.port;
  return port === undefined || Number(port) <= 65_535;
}

function buildHttpsRemote(host: string, remotePath: string): GitRemoteUrl | null {
  const normalizedPath = normalizeRemotePath(remotePath);
  if (!host || !isSafeRemoteHost(host) || !normalizedPath) return null;
  try {
    const parsed = new URL(`https://${host}/${normalizedPath}`);
    if (parsed.username || parsed.password) return null;
    return {
      webUrl: parsed.toString().replace(/\/$/, ""),
      label: normalizedPath,
    };
  } catch {
    return null;
  }
}

function normalizeRemoteUrl(remote: string): GitRemoteUrl | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  const scpLike = /^(?<user>[^@\s]+)@(?<host>[^@:\s/]+):(?<path>.+)$/.exec(trimmed);
  if (scpLike?.groups) {
    return buildHttpsRemote(scpLike.groups.host ?? "", scpLike.groups.path ?? "");
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") {
      return null;
    }
    const host = parsed.protocol === "ssh:" ? parsed.hostname : parsed.host;
    return buildHttpsRemote(host, parsed.pathname);
  } catch {
    return null;
  }
}

function normalizeRemoteIdentity(remote: string): Omit<NormalizedGitRemote, "name" | "rawUrl"> | null {
  const normalized = normalizeRemoteUrl(remote);
  if (!normalized?.webUrl) return null;
  const parsed = new URL(normalized.webUrl);
  const repositoryPath = normalizeRemotePath(parsed.pathname);
  if (!repositoryPath) return null;
  return {
    host: parsed.host.toLowerCase(),
    repositoryPath: repositoryPath.toLowerCase(),
    webUrl: normalized.webUrl,
  };
}

function normalizedRepositoryKey(url: string): string | null {
  const normalized = normalizeRemoteIdentity(url);
  return normalized
    ? `${normalized.host}/${normalized.repositoryPath}`
    : null;
}

function safeReviewRefComponent(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${readable.slice(0, 30) || "repository"}-${hash}`;
}

function sanitizeReviewBranchPart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/[/.]+$/g, "")
    .replace(/^[-/.]+/g, "") || "review";
}

function sanitizeReviewBranchAtom(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "") || "review";
}

function assertSafeReviewBranch(value: string, label: string): void {
  if (
    value.length === 0
    || value.length > 255
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.includes("..")
    || value.includes("@{")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.includes("//")
  ) {
    throw new PullRequestReviewGitError("head_missing", `${label} is not a safe Git branch ref.`);
  }
}

function isPathWithin(basePath: string, candidatePath: string): boolean {
  const rel = relative(normalizePathForComparison(basePath), normalizePathForComparison(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

/** Handles all git branch, worktree, checkout, and fetch operations. */
@injectable()
export class GitService {
  private readonly worktreeDirectoryRemover: WorktreeDirectoryRemover;
  private readonly repositoryMutationLock: RepositoryGitMutationLock;
  private readonly worktreeSafety: WorktreeSafetyService;

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(WorktreeDirectoryRemover, { isOptional: true })
    worktreeDirectoryRemover?: WorktreeDirectoryRemover,
    @inject(RepositoryGitMutationLock, { isOptional: true })
    repositoryMutationLock?: RepositoryGitMutationLock,
    @inject(WorktreeSafetyService, { isOptional: true })
    worktreeSafety?: WorktreeSafetyService,
  ) {
    this.worktreeDirectoryRemover = worktreeDirectoryRemover ?? new WorktreeDirectoryRemover();
    this.repositoryMutationLock = repositoryMutationLock ?? new RepositoryGitMutationLock();
    this.worktreeSafety = worktreeSafety ?? new WorktreeSafetyService(gitExecutor);
  }

  /** List all branches (local, remote, and worktree-attached) for a workspace. */
  async listBranches(workspaceId: string): Promise<GitBranch[]> {
    const workspace = this.requireWorkspace(workspaceId);
    return this.listBranchesForPath(workspace.path);
  }

  /** Get the current branch name for a workspace. Returns null for non-git workspaces. */
  async getCurrentBranch(workspaceId: string): Promise<string | null> {
    const workspace = this.requireWorkspace(workspaceId);
    return this.getCurrentBranchForPath(workspace.path);
  }

  /**
   * Get the current branch name for an arbitrary repo path.
   * Use this instead of getCurrentBranch when you already have the resolved path
   * (e.g. a worktree directory that may differ from the workspace root).
   */
  async getCurrentBranchAt(repoPath: string): Promise<string | null> {
    return this.getCurrentBranchForPath(repoPath);
  }

  /** Checkout an existing branch in the workspace repository. */
  async checkout(workspaceId: string, branch: string): Promise<void> {
    validateBranchName(branch);
    const workspace = this.requireWorkspace(workspaceId);
    await this.gitExecutor.exec(["-C", workspace.path, "checkout", branch]);
  }

  /** Create and checkout a new branch in the repository at the given path. */
  async createBranch(path: string, name: string): Promise<string> {
    assertSafeBranchCreationName(name);
    await this.gitExecutor.exec(["-C", path, "checkout", "-b", name]);
    return name;
  }

  /** List all git worktrees registered for a workspace. */
  async listWorktrees(workspaceId: string): Promise<WorktreeInfo[]> {
    const workspace = this.requireWorkspace(workspaceId);
    return this.listWorktreesForPath(workspace.path);
  }

  /** Resolve the origin remote as a normalized https URL and UI label. */
  async getRemoteUrl(repoPath: string): Promise<GitRemoteUrl> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "remote", "get-url", "origin"],
        { timeout: 5_000 },
      );
      return normalizeRemoteUrl(stdout) ?? fallbackRemoteUrl(repoPath);
    } catch {
      return fallbackRemoteUrl(repoPath);
    }
  }

  /** List bounded configured remotes normalized to repository identities. */
  async listNormalizedRemotes(repoPath: string): Promise<NormalizedGitRemote[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "config", "--get-regexp", "^remote\\..*\\.url$"],
        { timeout: 5_000 },
      ));
    } catch {
      return [];
    }

    const remotes: NormalizedGitRemote[] = [];
    for (const line of stdout.split("\n").slice(0, 64)) {
      const separator = line.search(/\s/);
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      const rawUrl = line.slice(separator).trim();
      const match = /^remote\.([A-Za-z0-9._-]{1,100})\.url$/.exec(key);
      if (!match?.[1] || rawUrl.length === 0 || rawUrl.length > 2_048) continue;
      const normalized = normalizeRemoteIdentity(rawUrl);
      if (!normalized) continue;
      remotes.push({ name: match[1], rawUrl, ...normalized });
    }
    return remotes;
  }

  /** Resolve a server-owned Review worktree leaf beneath the managed worktree root. */
  getReviewWorktreeDestination(repoPath: string, worktreeName: string): string {
    validateWorktreeName(worktreeName);
    const base = resolve(getWorktreeBaseDir(repoPath));
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
    const remotes = await this.listNormalizedRemotes(repoPath);
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
      const canonicalBase = await realpath(getWorktreeBaseDir(repoPath));
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
    const remote = (await this.listNormalizedRemotes(repoPath)).find(
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

  /** Check whether a filesystem path is a git-registered worktree for a repository. */
  async isRegisteredWorktreePath(repoPath: string, worktreePath: string): Promise<boolean> {
    const normalize = (value: string) =>
      resolve(value).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    const target = normalize(worktreePath);
    const worktrees = await this.listWorktreesForPath(repoPath);
    return worktrees.some((worktree) => normalize(worktree.path) === target);
  }

  /**
   * Fetch a remote branch from origin and create a local tracking branch.
   * When prNumber is provided, fetches via `refs/pull/<n>/head` refspec.
   */
  async fetchBranch(
    workspaceId: string,
    branch: string,
    prNumber?: number,
  ): Promise<void> {
    const workspace = this.requireWorkspace(workspaceId);
    await this.fetchBranchForPath(workspace.path, branch, prNumber);
  }

  /**
   * Create a new git worktree in the mcode data directory.
   * Returns the worktree metadata including the filesystem path, whether this
   * call created the branch or attached to an existing one, and any non-fatal
   * warnings (e.g. post-checkout hook failures).
   */
  async createWorktree(
    repoPath: string,
    name: string,
    branchName?: string,
    options: { branchless?: boolean; baseRef?: string } = {},
  ): Promise<WorktreeInfo & { createdBranch: boolean; warnings: string[] }> {
    validateWorktreeName(name);

    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    const branch = branchName ?? `mcode/${name}`;
    validateBranchName(branch);
    if (options.baseRef) validateBranchName(options.baseRef);
    const wtPath = join(ensureWorktreeBaseDir(repoPath), name);

    if (existsSync(wtPath)) {
      throw new Error(`Worktree directory already exists: ${wtPath}`);
    }

    const createdBranch = options.branchless ? false : !(await this.branchExists(repoPath, branch));
    const warnings: string[] = [];

    try {
      if (options.branchless) {
        await this.gitExecutor.exec(["-C", repoPath, "worktree", "add", "--detach", wtPath, branch]);
      } else if (!createdBranch) {
        await this.gitExecutor.exec(["-C", repoPath, "worktree", "add", wtPath, branch]);
      } else {
        await this.gitExecutor.exec([
          "-C",
          repoPath,
          "worktree",
          "add",
          wtPath,
          "-b",
          branch,
          ...(options.baseRef ? [options.baseRef] : []),
        ]);
      }
    } catch (err) {
      // If the worktree's .git file exists, git initialized the worktree
      // successfully. The error likely comes from a post-checkout hook.
      // Treat it as a warning so the caller can still use the worktree.
      if (existsSync(join(wtPath, ".git"))) {
        const stderr =
          err instanceof Error && "stderr" in err
            ? String((err as { stderr: unknown }).stderr)
            : String(err);
        warnings.push(stderr || String(err));
        logger.warn("Worktree created but post-checkout hook failed", {
          wtPath,
          branch,
          error: stderr,
        });
      } else {
        throw err;
      }
    }

    return { name, path: wtPath, branch, managed: true, createdBranch, warnings };
  }

  /**
   * Remove a git worktree by name.
   * Returns true only when the target worktree and managed parent directories are clean.
   * Returns false when a transient lock leaves a managed parent directory for retry.
   * When deleteBranch is true, deletes options.branchName or the default managed branch.
   * When worktreePath is set, removes that exact worktree path instead of deriving
   * one under the managed mcode worktree directory.
   */
  async removeWorktree(
    repoPath: string,
    name: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<boolean> {
    validateWorktreeName(name);

    let wtPath = options.worktreePath ?? join(getWorktreeBaseDir(repoPath), name);
    if (options.managedCanonicalOnly) {
      wtPath = await this.worktreeSafety.resolveManagedCanonicalWorktreePath(wtPath);
    }
    const deleteBranch = options.deleteBranch ?? true;
    const branch = deleteBranch
      ? (options.branchName ?? `mcode/${name}`)
      : null;
    if (branch) {
      validateBranchName(branch);
    }

    await this.assertRemovableWorktreePath(repoPath, wtPath);

    // 1. Try git worktree remove
    try {
      await this.gitExecutor.exec(
        // Double --force: the second flag tells git to remove even if the
        // worktree directory is locked (e.g. held by a Windows process).
        ["-C", repoPath, "worktree", "remove", wtPath, "--force", "--force"],
        { timeout: 30_000 },
      );
    } catch (err) {
      logger.warn("git worktree remove failed", {
        wtPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Fallback: remove directory manually if git didn't clean it up.
    if (existsSync(wtPath)) {
      logger.warn(
        "Worktree directory still exists after git remove, falling back to bounded child removal",
        { wtPath },
      );
      try {
        await this.worktreeDirectoryRemover.remove(wtPath);
      } catch (err) {
        logger.error("Fallback worktree removal failed", {
          wtPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Keep a locked worktree at its registered path so the cleanup worker
    // can retry after the application holding the directory releases it.
    if (existsSync(wtPath)) {
      logger.error("Worktree directory could not be removed", { wtPath });
      return false;
    }

    // 4. Prune stale worktree metadata after any manual fallback removed the path.
    try {
      await this.gitExecutor.exec(["-C", repoPath, "worktree", "prune"], { timeout: 10_000 });
    } catch (err) {
      logger.warn("git worktree prune failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 5. Remove empty managed parent directories. Returns false on transient
    //    lock errors (EBUSY/EPERM) so the cleanup worker can retry later when
    //    the OS releases handles.
    const parentsCleaned = await removeEmptyManagedParentDirs(wtPath);

    // 6. Delete the branch when explicitly requested (independent of parent
    //    dir state - always attempt this).
    if (branch) {
      try {
        await this.gitExecutor.exec(["-C", repoPath, "branch", "-d", branch], { timeout: 10_000 });
      } catch (err) {
        logger.warn("Branch deletion failed (may not exist)", {
          branch,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return parentsCleaned;
  }

  /**
   * Reject fallback removal when a caller-supplied worktree path is outside the
   * managed mcode worktree root and not registered with git for the repo.
   */
  private async assertRemovableWorktreePath(
    repoPath: string,
    worktreePath: string,
  ): Promise<void> {
    const managedRoot = resolve(getMcodeDir(), "worktrees");
    const rel = relative(managedRoot, resolve(worktreePath));
    const isManagedPath = !(rel.startsWith("..") || isAbsolute(rel));
    if (isManagedPath) return;

    const isRegistered = await this.isRegisteredWorktreePath(repoPath, worktreePath);
    if (!isRegistered) {
      throw new Error(
        `worktreePath is not a managed or registered worktree: ${worktreePath}`,
      );
    }
  }

  /**
   * Resolve the working directory for a thread, accounting for worktree mode.
   * Uses the thread's worktree_path when available, otherwise the workspace root.
   */
  resolveWorkingDir(
    workspacePath: string,
    threadMode: string | null,
    worktreePath: string | null,
  ): string {
    if (threadMode === "worktree" && worktreePath) {
      return worktreePath;
    }
    return workspacePath;
  }

  /** Get commit log for a workspace. When baseBranch is provided, only returns commits on branch that are not on baseBranch. Pass repoPath to run from a worktree directory instead of the workspace root. */
  async log(
    workspaceId: string,
    branch?: string,
    limit = 50,
    baseBranch?: string,
    repoPath?: string,
    skip = 0,
    includeStats = true,
  ): Promise<GitCommit[]> {
    const workspace = this.requireWorkspace(workspaceId);
    const effectivePath = repoPath ?? workspace.path;

    if (branch !== undefined) assertSafeRef(branch);
    if (baseBranch !== undefined) assertSafeRef(baseBranch);

    // Auto-detect default branch when baseBranch is omitted but branch is specified
    const resolvedBase = baseBranch !== undefined
      ? baseBranch
      : branch !== undefined
        ? await this.detectDefaultComparisonRef(effectivePath)
        : undefined;

    const args = [
      "-C", effectivePath,
      "log",
      "--pretty=format:MCODE_SEP%H|||%h|||%s|||%an|||%aI",
      `-${limit}`,
    ];
    if (skip > 0) args.push(`--skip=${skip}`);
    if (includeStats) args.push("--numstat");
    // When running from a worktree path, HEAD is the checked-out branch — no need to name it.
    const headRef = repoPath ? "HEAD" : branch;
    if (resolvedBase && headRef) {
      args.push(`${resolvedBase}..${headRef}`);
    } else if (resolvedBase) {
      args.push(`${resolvedBase}..HEAD`);
    } else if (branch) {
      args.push(branch);
    }

    let stdout: string;
    try {
      const result = await this.gitExecutor.exec(args, { timeout: 10_000 });
      stdout = result.stdout;
    } catch {
      return [];
    }

    const commits: GitCommit[] = [];
    // Each block starts with MCODE_SEP; split on that separator
    const blocks = stdout.split("MCODE_SEP").filter(Boolean);

    for (const block of blocks) {
      const lines = block.split("\n");
      const meta = lines[0];
      if (!meta) continue;

      const [sha, shortSha, message, author, date] = meta.split("|||");
      if (!sha) continue;

      // numstat lines have format: additions\tdeletions\tfilename
      const filesChanged = includeStats
        ? lines.slice(1).filter((l) => l.includes("\t")).length
        : 0;

      commits.push({
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        message: message ?? "",
        author: author ?? "",
        date: date ?? "",
        filesChanged,
      });
    }

    return commits;
  }

  /** Get unified diff for a specific git commit. */
  async commitDiff(
    workspaceId: string,
    sha: string,
    filePath?: string,
    maxLines?: number,
  ): Promise<string> {
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
      throw new Error(`Invalid git SHA: ${sha}`);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const args = ["-C", workspace.path, "diff", "--find-renames", `${sha}~1..${sha}`];
    if (filePath) args.push("--", filePath);

    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      if (maxLines) {
        return result.split("\n").slice(0, maxLines).join("\n");
      }
      return result;
    } catch {
      // Handle root commit (no parent): diff against empty tree
      try {
        const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
        const args2 = ["-C", workspace.path, "diff", "--find-renames", `${emptyTree}..${sha}`];
        if (filePath) args2.push("--", filePath);
        const { stdout } = await this.gitExecutor.exec(args2, { timeout: 10_000 });
        return stdout.trim();
      } catch {
        return "";
      }
    }
  }

  /** Get the list of files changed in a specific git commit. */
  async commitFiles(workspaceId: string, sha: string): Promise<string[]> {
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
      throw new Error(`Invalid git SHA: ${sha}`);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const nameOnlyArgs = ["-C", workspace.path, "diff", "--name-only", `${sha}~1..${sha}`];
    try {
      const { stdout } = await this.gitExecutor.exec(nameOnlyArgs, { timeout: 5_000 });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      // Root commit — diff against empty tree
      const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
      try {
        const { stdout } = await this.gitExecutor.exec(
          ["-C", workspace.path, "diff", "--name-only", `${emptyTree}..${sha}`],
          { timeout: 5_000 },
        );
        return stdout.trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    }
  }

  /**
   * List files in a working tree for the given stage. `staged` selects the
   * index-versus-HEAD diff (`git diff --cached`); otherwise the
   * working-tree-versus-index diff (`git diff`). Reads the workspace root by
   * default; pass `repoPath` (a thread's worktree) to read that checkout instead.
   */
  async workingTreeFiles(workspaceId: string, staged: boolean, repoPath?: string): Promise<string[]> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const args = ["-C", cwd, "diff", "--name-only"];
    if (staged) args.push("--cached");
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the unified diff for a working tree at the given stage. `staged` selects
   * the index-versus-HEAD diff; otherwise working-tree-versus-index. Reads the
   * workspace root by default; pass `repoPath` to read a thread's worktree.
   * Optionally scoped to a single file and truncated.
   */
  async workingTreeDiff(
    workspaceId: string,
    staged: boolean,
    filePath?: string,
    maxLines?: number,
    repoPath?: string,
  ): Promise<string> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const args = ["-C", cwd, "diff", "--find-renames"];
    if (staged) args.push("--cached");
    if (filePath) args.push("--", filePath);
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      return maxLines ? result.split("\n").slice(0, maxLines).join("\n") : result;
    } catch {
      return "";
    }
  }

  /**
   * List files that differ between two refs as a three-dot comparison
   * (`base...target`, the symmetric-difference range — only what changed on the
   * target side since the two diverged). `base`/`target` default to the detected
   * default branch and HEAD respectively, preserving the legacy `base...HEAD`
   * behavior for callers that pass neither. The default pair the Branch view
   * uses is resolved by {@link resolveBranchComparison} per ADR 0007 and passed
   * explicitly. Reads the workspace root by default; pass `repoPath` to read a
   * thread's worktree. Returns an empty list when the refs match.
   */
  async branchFiles(
    workspaceId: string,
    base?: string,
    target?: string,
    repoPath?: string,
  ): Promise<string[]> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const resolvedBase = base ?? (await this.detectDefaultBranch(cwd));
    if (!resolvedBase) return [];
    const resolvedTarget = target ?? "HEAD";
    assertSafeRef(resolvedBase);
    assertSafeRef(resolvedTarget);
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--name-only", `${resolvedBase}...${resolvedTarget}`],
        { timeout: 10_000 },
      );
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the unified diff between two refs as a three-dot comparison
   * (`base...target`). `base`/`target` default to the detected default branch and
   * HEAD; see {@link branchFiles} for the range semantics. Reads the workspace
   * root by default; pass `repoPath` to read a thread's worktree. Optionally
   * scoped to a single file and truncated.
   */
  async branchDiff(
    workspaceId: string,
    base?: string,
    target?: string,
    filePath?: string,
    maxLines?: number,
    repoPath?: string,
  ): Promise<string> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const resolvedBase = base ?? (await this.detectDefaultBranch(cwd));
    if (!resolvedBase) return "";
    const resolvedTarget = target ?? "HEAD";
    assertSafeRef(resolvedBase);
    assertSafeRef(resolvedTarget);
    const args = ["-C", cwd, "diff", "--find-renames", `${resolvedBase}...${resolvedTarget}`];
    if (filePath) args.push("--", filePath);
    try {
      const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
      const result = stdout.trim();
      return maxLines ? result.split("\n").slice(0, maxLines).join("\n") : result;
    } catch {
      return "";
    }
  }

  /**
   * Parse a `git diff --numstat` stdout block into a totalled { additions, deletions } pair.
   * Binary files emit "-\t-\t<path>" — those lines count as 0 for both columns, matching
   * the behaviour of the file-list methods which still include the file in their output.
   */
  private parseNumstatTotal(stdout: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const line of stdout.trim().split("\n")) {
      if (!line.includes("\t")) continue;
      const [addStr, delStr] = line.split("\t");
      const parsedAdditions = addStr === "-" ? 0 : Number.parseInt(addStr ?? "", 10);
      const parsedDeletions = delStr === "-" ? 0 : Number.parseInt(delStr ?? "", 10);
      if (Number.isFinite(parsedAdditions)) additions += parsedAdditions;
      if (Number.isFinite(parsedDeletions)) deletions += parsedDeletions;
    }
    return { additions, deletions };
  }

  /** Parse one NUL-delimited git name-status batch into Review file metadata. */
  private parseReviewFileChanges(stdout: string, binaryPaths: ReadonlySet<string>): ReviewFileChange[] {
    const fields = stdout.split("\0");
    const files: ReviewFileChange[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      if (!status) continue;
      const code = status[0];
      if (code === "R" || code === "C") {
        const previousPath = fields[index++] ?? "";
        const path = fields[index++] ?? "";
        if (!previousPath || !path) continue;
        files.push({
          path,
          previousPath,
          changeType: code === "R" ? "renamed" : "copied",
          binary: binaryPaths.has(path),
        });
        if (files.length > MAX_REVIEW_COMPARISON_FILES) {
          throw new Error(`Review comparison is limited to ${MAX_REVIEW_COMPARISON_FILES} files`);
        }
        continue;
      }
      const path = fields[index++] ?? "";
      if (!path) continue;
      const changeType: ReviewFileChange["changeType"] =
        code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      files.push({ path, previousPath: null, changeType, binary: binaryPaths.has(path) });
      if (files.length > MAX_REVIEW_COMPARISON_FILES) {
        throw new Error(`Review comparison is limited to ${MAX_REVIEW_COMPARISON_FILES} files`);
      }
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Parse binary paths from one NUL-delimited git numstat batch. */
  private parseBinaryPaths(stdout: string): Set<string> {
    const fields = stdout.split("\0");
    const paths = new Set<string>();
    for (let index = 0; index < fields.length;) {
      const record = fields[index++];
      if (!record) continue;
      const firstSeparator = record.indexOf("\t");
      const secondSeparator = firstSeparator < 0 ? -1 : record.indexOf("\t", firstSeparator + 1);
      if (firstSeparator < 0 || secondSeparator < 0) continue;
      const additions = record.slice(0, firstSeparator);
      const deletions = record.slice(firstSeparator + 1, secondSeparator);
      const path = record.slice(secondSeparator + 1);
      const binary = additions === "-" || deletions === "-";
      if (path) {
        if (binary) paths.add(path);
        continue;
      }
      const previousPath = fields[index++] ?? "";
      const nextPath = fields[index++] ?? "";
      if (binary) {
        if (previousPath) paths.add(previousPath);
        if (nextPath) paths.add(nextPath);
      }
    }
    return paths;
  }

  /** Return one settled file/status/stat batch for a Review git comparison. */
  async reviewComparison(
    workspaceId: string,
    view: "unstaged" | "staged" | "branch" | "commit",
    opts: { base?: string; target?: string; sha?: string },
    repoPath?: string,
  ): Promise<ReviewComparison> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    let suffix: string[] = [];
    if (view === "staged") suffix = ["--cached"];
    if (view === "branch") {
      const base = opts.base ?? (await this.detectDefaultBranch(cwd));
      if (!base) return { files: [], additions: 0, deletions: 0 };
      const target = opts.target ?? "HEAD";
      assertSafeRef(base);
      assertSafeRef(target);
      suffix = [`${base}...${target}`];
    }
    if (view === "commit") {
      const sha = opts.sha;
      if (!sha || !/^[0-9a-fA-F]{4,40}$/.test(sha)) {
        throw new Error(`Invalid or missing git SHA for commit view: ${sha}`);
      }
      suffix = [`${sha}~1`, sha];
    }

    const run = async (range: readonly string[]): Promise<ReviewComparison> => {
      const [names, numstat] = await Promise.all([
        this.gitExecutor.exec(
          ["-C", cwd, "diff", "--name-status", "-z", "--find-renames", "--find-copies", ...range],
          { timeout: 10_000 },
        ),
        this.gitExecutor.exec(
          ["-C", cwd, "diff", "--numstat", "-z", "--find-renames", "--find-copies", ...range],
          { timeout: 10_000 },
        ),
      ]);
      const totals = this.parseNumstatTotal(numstat.stdout.replaceAll("\0", "\n"));
      return {
        files: this.parseReviewFileChanges(names.stdout, this.parseBinaryPaths(numstat.stdout)),
        ...totals,
      };
    };

    try {
      return await run(suffix);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Review comparison is limited")) {
        throw error;
      }
      if (view !== "commit") throw error;
      const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
      return run([emptyTree, opts.sha!]);
    }
  }

  /**
   * Return total additions and deletions for a Review-panel git view.
   * Ref semantics match the corresponding file-list methods so the stat
   * total always agrees with the file list the panel shows:
   *
   * - `unstaged` → working tree vs index (`git diff --numstat`)
   * - `staged`   → index vs HEAD (`git diff --numstat --cached`)
   * - `branch`   → three-dot symmetric diff (`git diff --numstat base...target`)
   * - `commit`   → parent vs commit (`git diff --numstat sha~1 sha`), with the
   *   standard empty-tree fallback for root commits
   *
   * Pass `repoPath` to read a thread's worktree instead of the workspace root.
   */
  async reviewDiffStats(
    workspaceId: string,
    view: "unstaged" | "staged" | "branch" | "commit",
    opts: { base?: string; target?: string; sha?: string },
    repoPath?: string,
  ): Promise<{ additions: number; deletions: number }> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const empty = { additions: 0, deletions: 0 };

    if (view === "unstaged" || view === "staged") {
      const args = ["-C", cwd, "diff", "--numstat"];
      if (view === "staged") args.push("--cached");
      try {
        const { stdout } = await this.gitExecutor.exec(args, { timeout: 10_000 });
        return this.parseNumstatTotal(stdout);
      } catch {
        return empty;
      }
    }

    if (view === "branch") {
      const resolvedBase = opts.base ?? (await this.detectDefaultBranch(cwd));
      if (!resolvedBase) return empty;
      const resolvedTarget = opts.target ?? "HEAD";
      assertSafeRef(resolvedBase);
      assertSafeRef(resolvedTarget);
      try {
        const { stdout } = await this.gitExecutor.exec(
          ["-C", cwd, "diff", "--numstat", `${resolvedBase}...${resolvedTarget}`],
          { timeout: 10_000 },
        );
        return this.parseNumstatTotal(stdout);
      } catch {
        return empty;
      }
    }

    // commit view
    const sha = opts.sha;
    if (!sha || !/^[0-9a-fA-F]{4,40}$/.test(sha)) {
      throw new Error(`Invalid or missing git SHA for commit view: ${sha}`);
    }
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", cwd, "diff", "--numstat", `${sha}~1`, sha],
        { timeout: 10_000 },
      );
      return this.parseNumstatTotal(stdout);
    } catch {
      // Root commit — diff against the empty tree
      const emptyTree = "4b825dc642cb6eb9a060e54bf899d69f82049264";
      try {
        const { stdout } = await this.gitExecutor.exec(
          ["-C", cwd, "diff", "--numstat", emptyTree, sha],
          { timeout: 10_000 },
        );
        return this.parseNumstatTotal(stdout);
      } catch {
        return empty;
      }
    }
  }

  /**
   * Resolve the default Branch comparison for a checkout, plus the refs that
   * populate the base/target pickers. Implements the priority ladder from
   * `docs/adr/0007-branch-comparison-default-and-range.md`:
   *
   * 1. Tracked upstream (`@{upstream}`) when set.
   * 2. Remote default ref (`origin/<repo-default>`) when `origin` exists.
   * 3. Local default branch for feature branches in repos with no remote.
   * 4. On the local-only default branch with no upstream — no comparison
   *    (`isComparisonAvailable: false`; Branch view disabled).
   *
   * Detached HEAD compares the best available base to `HEAD`. Unborn branches
   * return `isUnborn: true`. When no base can be detected on a feature branch,
   * `base` is null and the user picks one in the ref picker.
   *
   * Reads the workspace root by default; pass `repoPath` to resolve against a
   * thread's worktree so "current branch" is the thread's branch.
   */
  async resolveBranchComparison(
    workspaceId: string,
    repoPath?: string,
    savedBaseBranch?: string | null,
  ): Promise<BranchComparison> {
    const cwd = repoPath ?? this.requireWorkspace(workspaceId).path;
    const refs = await this.listBranchesForPath(cwd);

    if (!(await this.hasCommits(cwd))) {
      return { base: null, target: null, refs, isUnborn: true, isComparisonAvailable: false };
    }

    const defaultBranch = await this.detectDefaultBranch(cwd);
    const originDefaultRef = await this.detectOriginDefaultRef(cwd);
    const current = await this.getCurrentBranchForPath(cwd);
    const upstream =
      current && current !== "HEAD" ? await this.getUpstreamRef(cwd) : null;
    const onDefaultBranch = defaultBranch !== null && current === defaultBranch;

    const unavailable = (
      comparison: Omit<BranchComparison, "isComparisonAvailable">,
    ): BranchComparison => ({ ...comparison, isComparisonAvailable: false });

    const available = (
      comparison: Omit<BranchComparison, "isComparisonAvailable">,
    ): BranchComparison => ({ ...comparison, isComparisonAvailable: true });

    // Detached HEAD (no branch name): compare the best base to HEAD. Three-dot
    // semantics resolve the merge-base internally, so an explicit base is enough.
    if (!current || current === "HEAD") {
      const base = savedBaseBranch ?? upstream ?? originDefaultRef ?? defaultBranch;
      if (!base) {
        return unavailable({ base: null, target: "HEAD", refs, isUnborn: false });
      }
      return available({ base, target: "HEAD", refs, isUnborn: false });
    }

    // 1. Tracked upstream — most accurate when the branch has a remote tracking ref.
    if (upstream) {
      if (onDefaultBranch) {
        return available({ base: current, target: upstream, refs, isUnborn: false });
      }
      return available({ base: upstream, target: current, refs, isUnborn: false });
    }

    // 2. Remote default ref when origin exists but this branch has no upstream.
    if (originDefaultRef) {
      if (onDefaultBranch) {
        return available({ base: current, target: originDefaultRef, refs, isUnborn: false });
      }
      return available({ base: originDefaultRef, target: current, refs, isUnborn: false });
    }

    // 3. Local-only feature branch: compare against the detected local default.
    if (!onDefaultBranch && defaultBranch) {
      return available({ base: defaultBranch, target: current, refs, isUnborn: false });
    }

    // 4. Local-only default branch — nothing meaningful to compare.
    if (onDefaultBranch) {
      return unavailable({ base: current, target: current, refs, isUnborn: false });
    }

    // Feature branch with no detectable base — user must pick in the ref picker.
    return available({ base: null, target: current, refs, isUnborn: false });
  }

  /** Return the abbreviated upstream ref for the current branch, or null when unset. */
  private async getUpstreamRef(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "@{upstream}"],
        { timeout: 5_000 },
      );
      const ref = stdout.trim();
      if (!ref || ref === "@{upstream}") return null;
      return ref;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the remote-qualified default ref (`origin/main`, etc.) without
   * falling back to a local branch name.
   */
  private async detectOriginDefaultRef(repoPath: string): Promise<string | null> {
    const cached = this.originDefaultRefCache.get(repoPath);
    if (cached !== undefined) return cached;

    const result = await this.resolveOriginDefaultRef(repoPath);
    this.originDefaultRefCache.set(repoPath, result);
    return result;
  }

  /** Resolve `origin/<repo-default>` via origin/HEAD; null when no origin remote. */
  private async resolveOriginDefaultRef(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectOriginDefaultRef] origin/HEAD not set, trying set-head", {
        repoPath,
        err,
      });
    }

    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "remote", "set-head", "origin", "--auto"],
        { timeout: 1_500 },
      );
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectOriginDefaultRef] set-head failed", { repoPath, err });
    }

    return null;
  }

  /** Whether HEAD resolves to a commit (false on an unborn branch / empty repo). */
  private async hasCommits(repoPath: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--verify", "--quiet", "HEAD"],
        { timeout: 5_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Push a branch to the origin remote, creating the upstream tracking ref if needed. */
  async push(repoPath: string, branch: string): Promise<void> {
    validateBranchName(branch);
    await this.gitExecutor.exec(
      ["-C", repoPath, "push", "--set-upstream", "origin", branch],
      { timeout: 60_000 },
    );
  }

  /** Return a diff stat summary between two refs. */
  async diffStat(repoPath: string, base: string, head: string): Promise<string> {
    const { stdout } = await this.gitExecutor.exec(
      ["-C", repoPath, "diff", "--stat", `${base}...${head}`],
      { timeout: 30_000 },
    );
    return stdout.trim();
  }

  /**
   * Check whether the working tree at repoPath has no uncommitted changes.
   * Returns true only for genuinely clean trees or paths git reports as
   * "not a git repository". Other failures (timeouts, permission errors)
   * return false so a dirty repo is never silently labelled clean — the
   * UI then surfaces the warning state instead of the green "clean" pill.
   */
  async isWorkingTreeClean(repoPath: string): Promise<boolean> {
    return this.worktreeSafety.isWorkingTreeClean(repoPath);
  }

  /** Compare bounded active sibling paths by canonical filesystem identity. */
  async assessWorktreeRemovalSafety(
    worktreePath: string,
    activeSiblingPaths: readonly string[],
    truncated: boolean,
  ): Promise<WorktreeRemovalSafety> {
    return this.worktreeSafety.assessWorktreeRemovalSafety(
      worktreePath,
      activeSiblingPaths,
      truncated,
    );
  }

  /** Verify that a branchless worktree is clean and has no commits beyond its base. */
  async assessBranchlessWorktreeRemoval(
    worktreePath: string,
    baseBranch: string,
  ): Promise<BranchlessWorktreeRemovalSafety> {
    return this.worktreeSafety.assessBranchlessWorktreeRemoval(worktreePath, baseBranch);
  }

  /** Verify that a named worktree is accessible and has no uncommitted files. */
  async assessNamedWorktreeRemoval(worktreePath: string): Promise<NamedWorktreeRemovalSafety> {
    return this.worktreeSafety.assessNamedWorktreeRemoval(worktreePath);
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
    const managedRoot = getWorktreeBaseDir(repoPath);
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
    const remotes = await this.listNormalizedRemotes(repoPath);
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
    const base = ensureWorktreeBaseDir(repoPath);
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
        if (isPathWithin(getWorktreeBaseDir(attempt.repoPath), attempt.createdWorktreePath)) {
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

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  // ---------------------------------------------------------------------------
  // Private git helpers (formerly module-level functions)
  // ---------------------------------------------------------------------------

  /** Check whether a branch ref exists in the repository. */
  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(["-C", repoPath, "rev-parse", "--verify", branch]);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the current branch name for a repository path. Returns null for non-git paths. */
  private async getCurrentBranchForPath(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"],
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** List all branches (local, remote, worktree-attached) for a repository path. */
  private async listBranchesForPath(repoPath: string): Promise<GitBranch[]> {
    let output: string;
    try {
      const { stdout } = await this.gitExecutor.exec([
        "-C",
        repoPath,
        "branch",
        "-a",
        "--format=%(refname)|||%(refname:short)|||%(objectname:short)|||%(HEAD)|||%(worktreepath)",
      ]);
      output = stdout;
    } catch {
      return [];
    }

    const branches: GitBranch[] = [];

    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const [fullRefname, refname, shortSha, head, worktreepath] = trimmed.split("|||");
      // Skip remote HEAD symrefs (refs/remotes/*/HEAD)
      if (!fullRefname || !refname || /\/HEAD$/.test(fullRefname)) continue;
      // Detached checkouts appear as "(no branch)" in `git branch --format`.
      // They are display-only pseudo refs; diff callers use HEAD instead.
      if (fullRefname === "(no branch)" || refname === "(no branch)") continue;

      let type: GitBranch["type"];
      if (worktreepath && worktreepath.length > 0) {
        type = "worktree";
      } else if (fullRefname.startsWith("refs/remotes/")) {
        type = "remote";
      } else {
        type = "local";
      }

      branches.push({
        name: refname,
        shortSha: shortSha ?? "",
        type,
        isCurrent: head === "*",
      });
    }

    const typeOrder: Record<GitBranch["type"], number> = {
      local: 0,
      worktree: 1,
      remote: 2,
    };

    return branches.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      const orderDiff = typeOrder[a.type] - typeOrder[b.type];
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name);
    });
  }

  /** List all git worktrees for a repository path. */
  private async listWorktreesForPath(repoPath: string): Promise<WorktreeInfo[]> {
    const worktreesDir = getWorktreeBaseDir(repoPath)
      .replace(/\\/g, "/")
      .toLowerCase();
    const normalizedRepo = repoPath
      .replace(/\\/g, "/")
      .toLowerCase()
      .replace(/\/+$/, "");

    let output: string;
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "worktree", "list", "--porcelain"],
      );
      output = stdout;
    } catch {
      return [];
    }

    const result: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim();
        currentBranch = "";
      } else if (line.startsWith("branch ")) {
        currentBranch = line
          .slice("branch ".length)
          .trim()
          .replace("refs/heads/", "");
      } else if (line === "detached") {
        currentBranch = "(detached)";
      } else if (line.trim() === "" && currentPath) {
        const normalized = currentPath
          .replace(/\\/g, "/")
          .toLowerCase()
          .replace(/\/+$/, "");
        if (normalized !== normalizedRepo && currentBranch) {
          const name =
            currentPath.replace(/\\/g, "/").split("/").pop() || currentPath;
          const managed = normalized.startsWith(worktreesDir + "/");
          result.push({ name, path: currentPath, branch: currentBranch, managed });
        }
        currentPath = "";
        currentBranch = "";
      }
    }

    // Handle last entry (porcelain output may not end with blank line)
    if (currentPath && currentBranch) {
      const normalized = currentPath
        .replace(/\\/g, "/")
        .toLowerCase()
        .replace(/\/+$/, "");
      if (normalized !== normalizedRepo) {
        const name =
          currentPath.replace(/\\/g, "/").split("/").pop() || currentPath;
        const managed = normalized.startsWith(worktreesDir + "/");
        result.push({ name, path: currentPath, branch: currentBranch, managed });
      }
    }

    return result;
  }

  /**
   * Fetch a remote branch from origin and create a local tracking branch.
   * When prNumber is provided, fetches via `refs/pull/<n>/head` refspec.
   */
  private async fetchBranchForPath(
    repoPath: string,
    branch: string,
    prNumber?: number,
  ): Promise<void> {
    validateBranchName(branch);

    let fetchOk = true;
    try {
      if (prNumber != null) {
        await this.gitExecutor.exec([
          "-C",
          repoPath,
          "fetch",
          "origin",
          `+pull/${prNumber}/head:${branch}`,
        ]);
      } else {
        await this.gitExecutor.exec(["-C", repoPath, "fetch", "origin", branch]);
      }
    } catch {
      fetchOk = false;
    }

    if (fetchOk && prNumber == null) {
      const localExists = await this.branchExists(repoPath, branch);
      if (localExists) {
        await this.gitExecutor.exec(
          ["-C", repoPath, "branch", "-f", branch, `origin/${branch}`],
        );
      } else {
        await this.gitExecutor.exec(
          ["-C", repoPath, "branch", "--track", branch, `origin/${branch}`],
        );
      }
    } else if (!fetchOk && !(await this.branchExists(repoPath, branch))) {
      throw new Error(`Branch "${branch}" not found locally or on origin`);
    }
  }

  /** Per-repo cache: avoids re-running mutating git commands on every log call. */
  private readonly defaultBranchCache = new Map<string, string | null>();
  private readonly defaultComparisonRefCache = new Map<string, string | null>();
  private readonly originDefaultRefCache = new Map<string, string | null>();

  /** Detect the default comparison ref for commit ranges, preferring the remote-qualified ref. */
  private async detectDefaultComparisonRef(repoPath: string): Promise<string | null> {
    const cached = this.defaultComparisonRefCache.get(repoPath);
    if (cached !== undefined) return cached;

    const result = await this.resolveDefaultComparisonRef(repoPath);
    this.defaultComparisonRefCache.set(repoPath, result);
    return result;
  }

  /** Resolve the default comparison ref, preserving `origin/main` when available. */
  private async resolveDefaultComparisonRef(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectDefaultComparisonRef] origin/HEAD not set, trying set-head", { repoPath, err });
    }

    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "remote", "set-head", "origin", "--auto"],
        { timeout: 1_500 },
      );
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim();
    } catch (err) {
      logger.debug("[detectDefaultComparisonRef] set-head failed, falling back to local default", { repoPath, err });
    }

    return this.detectDefaultBranch(repoPath);
  }

  /** Detect the default upstream branch (e.g. main, master) for a repository. */
  private async detectDefaultBranch(repoPath: string): Promise<string | null> {
    const cached = this.defaultBranchCache.get(repoPath);
    if (cached !== undefined) return cached;

    const result = await this.resolveDefaultBranch(repoPath);
    this.defaultBranchCache.set(repoPath, result);
    return result;
  }

  /** Resolve the default comparison branch by probing git refs in order of cheapness. */
  private async resolveDefaultBranch(repoPath: string): Promise<string | null> {
    // 1. Ask the remote tracking ref (fast, no network, works if origin/HEAD is set)
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim().replace(/^[^/]+\//, "");
    } catch (err) {
      logger.debug("[detectDefaultBranch] origin/HEAD not set, trying set-head", { repoPath, err });
    }

    // 2. Ask the remote to set origin/HEAD, then re-read it.
    // Timeout is short (1 500 ms) so an unreachable remote doesn't block the caller.
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "remote", "set-head", "origin", "--auto"],
        { timeout: 1_500 },
      );
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { timeout: 5_000 },
      );
      return stdout.trim().replace(/^[^/]+\//, "");
    } catch (err) {
      logger.debug("[detectDefaultBranch] set-head failed, falling back to HEAD", { repoPath, err });
    }

    // 3. Local-only repos have no origin/HEAD; prefer established default branch
    // names when they exist instead of treating the current feature branch as base.
    for (const branchName of ["main", "master", "develop", "trunk"]) {
      try {
        await this.gitExecutor.exec(
          ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
          { timeout: 5_000 },
        );
        return branchName;
      } catch {
        // Keep probing the next conventional default name.
      }
    }

    logger.debug("[detectDefaultBranch] no default branch detected", { repoPath });
    return null;
  }
}
