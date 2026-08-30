import { basename } from "node:path";
import { inject, injectable } from "tsyringe";
import { validateBranchName } from "@mcode/shared";
import type { GitBranch, GitRemoteUrl } from "@mcode/contracts";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import type { GitExecutor } from "./execution/index.js";

/** Normalized configured remote used for repository-identity matching. */
export interface NormalizedGitRemote {
  name: string;
  rawUrl: string;
  host: string;
  repositoryPath: string;
  webUrl: string;
}

/** Convert a configured remote URL into a stable repository-identity key. */
export function normalizedRepositoryKey(url: string): string | null {
  const normalized = normalizeRemoteIdentity(url);
  return normalized
    ? `${normalized.host}/${normalized.repositoryPath}`
    : null;
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

  return normalizeScpRemoteUrl(trimmed) ?? normalizeStandardRemoteUrl(trimmed);
}

function normalizeScpRemoteUrl(remote: string): GitRemoteUrl | null {
  const match = /^(?<user>[^@\s]+)@(?<host>[^@:\s/]+):(?<path>.+)$/.exec(remote);
  if (!match?.groups) return null;
  return buildHttpsRemote(match.groups.host ?? "", match.groups.path ?? "");
}

function normalizeStandardRemoteUrl(remote: string): GitRemoteUrl | null {
  try {
    const parsed = new URL(remote);
    if (!isSupportedRemoteProtocol(parsed.protocol)) return null;
    const host = parsed.protocol === "ssh:" ? parsed.hostname : parsed.host;
    return buildHttpsRemote(host, parsed.pathname);
  } catch {
    return null;
  }
}

function isSupportedRemoteProtocol(protocol: string): boolean {
  return protocol === "https:" || protocol === "http:" || protocol === "ssh:";
}

/** Normalize a configured remote URL to its repository identity fields. */
export function normalizeRemoteIdentity(
  remote: string,
): Omit<NormalizedGitRemote, "name" | "rawUrl"> | null {
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

/** Performs repository-level Git commands and remote identity normalization. */
@injectable()
export class GitRepositoryService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
  ) {}

  /** List all branches for a workspace. */
  async listBranches(workspaceId: string): Promise<GitBranch[]> {
    return this.listBranchesAt(this.requireWorkspace(workspaceId).path);
  }

  /** Get the current branch name for a workspace. */
  async getCurrentBranch(workspaceId: string): Promise<string | null> {
    return this.getCurrentBranchAt(this.requireWorkspace(workspaceId).path);
  }

  /** Get the current branch name for an arbitrary repository path. */
  async getCurrentBranchAt(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"],
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Checkout an existing branch in a workspace repository. */
  async checkout(workspaceId: string, branch: string): Promise<void> {
    validateBranchName(branch);
    await this.gitExecutor.exec(["-C", this.requireWorkspace(workspaceId).path, "checkout", branch]);
  }

  /** Create and checkout a new branch in the repository at the supplied path. */
  async createBranch(repoPath: string, name: string): Promise<string> {
    assertSafeBranchCreationName(name);
    await this.gitExecutor.exec(["-C", repoPath, "checkout", "-b", name]);
    return name;
  }

  /** Resolve the origin remote as a normalized HTTPS URL and UI label. */
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

  /** Fetch an origin branch for a workspace and update its local tracking branch. */
  async fetchBranch(workspaceId: string, branch: string, prNumber?: number): Promise<void> {
    await this.fetchBranchAt(this.requireWorkspace(workspaceId).path, branch, prNumber);
  }

  /** Fetch an origin branch at an arbitrary repository path. */
  async fetchBranchAt(repoPath: string, branch: string, prNumber?: number): Promise<void> {
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
      if (await this.branchExists(repoPath, branch)) {
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

  /** Push a branch to origin and establish its upstream tracking ref. */
  async push(repoPath: string, branch: string): Promise<void> {
    validateBranchName(branch);
    await this.gitExecutor.exec(
      ["-C", repoPath, "push", "--set-upstream", "origin", branch],
      { timeout: 60_000 },
    );
  }

  /** Check whether a branch ref exists in the repository. */
  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(["-C", repoPath, "rev-parse", "--verify", branch]);
      return true;
    } catch {
      return false;
    }
  }

  /** List all branches for an arbitrary repository path. */
  async listBranchesAt(repoPath: string): Promise<GitBranch[]> {
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
      const branch = parseBranchLine(line);
      if (branch) branches.push(branch);
    }
    return branches.sort(compareBranches);
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }
}

function parseBranchLine(line: string): GitBranch | null {
  const [fullRefname, refname, shortSha, head, worktreepath] = line.trim().split("|||");
  if (!fullRefname || !refname) return null;
  if (fullRefname.endsWith("/HEAD")) return null;
  if (fullRefname === "(no branch)" || refname === "(no branch)") return null;
  return {
    name: refname,
    shortSha: shortSha ?? "",
    type: getBranchType(fullRefname, worktreepath),
    isCurrent: head === "*",
  };
}

function getBranchType(fullRefname: string, worktreepath: string | undefined): GitBranch["type"] {
  if (worktreepath) return "worktree";
  return fullRefname.startsWith("refs/remotes/") ? "remote" : "local";
}

function compareBranches(left: GitBranch, right: GitBranch): number {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  const typeOrder: Record<GitBranch["type"], number> = { local: 0, worktree: 1, remote: 2 };
  const orderDiff = typeOrder[left.type] - typeOrder[right.type];
  return orderDiff === 0 ? left.name.localeCompare(right.name) : orderDiff;
}
