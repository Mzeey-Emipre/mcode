/**
 * Abstraction layer for diff sources used by the summary pipeline.
 * Decouples "where the diff comes from" from "how to summarize it",
 * allowing future sources (e.g. BranchDiffSource) without pipeline changes.
 */

import type { GitExecutor } from "../../git/execution/index.js";
import { RealGitExecutor } from "../../git/execution/real-git-executor.js";
import type { SnapshotService } from "../snapshots/snapshot-service.js";
import type { TurnFileEffectSummary } from "@mcode/contracts";
import {
  attributedWorkspacePaths,
  collectAttributedWorkspacePathGroups,
  collectAttributedWorkspacePaths,
} from "../snapshots/snapshot-attribution.js";

/** Per-file diff statistics. */
export interface FileDiffStat {
  filePath: string;
  additions: number;
  deletions: number;
}

/** Payload returned by a diff source for summary generation. */
export interface DiffPayload {
  /** Per-file diff stats (always included, cheap). */
  stats: FileDiffStat[];
  /** Unified diff content (full, partial, or empty depending on tier). */
  diff: string;
  /** Commit messages from the session. */
  commits: string;
  /** Number of turns that had actual file modifications. */
  turnCount: number;
  /** ID of the last turn with file modifications. */
  lastTurnId: string | null;
}

/** Abstraction for where a diff comes from. */
export interface DiffSummarySource {
  getDiff(): Promise<DiffPayload>;
}

/** Character limit for the unified diff before switching to partial tier. */
const DIFF_CHAR_LIMIT = 8_000;

/** Number of highest-churn files to include in partial tier. */
const PARTIAL_TOP_FILES = 5;

/** A snapshot row as stored in the database. */
export interface TurnSnapshotRow {
  id: string;
  message_id: string;
  thread_id: string;
  ref_before: string;
  ref_after: string;
  files_changed: string;
  file_effects?: TurnFileEffectSummary | string;
  worktree_path: string | null;
  created_at: string;
}

/**
 * Pulls the aggregate diff from a thread's turn snapshots.
 * Implements tiered diff inclusion to bound token costs:
 * - Under 8K chars: include the full aggregate diff
 * - Over 8K chars: include only diffs for the top 5 files by churn
 */
export class ThreadDiffSource implements DiffSummarySource {
  constructor(
    private readonly snapshots: TurnSnapshotRow[],
    private readonly cwd: string,
    private readonly snapshotService: SnapshotService,
    private readonly gitExecutor: GitExecutor,
  ) {}

  /** Build the aggregate diff payload from the thread's turn snapshots. */
  async getDiff(): Promise<DiffPayload> {
    const withChanges = this.snapshots.filter((snapshot) => (
      snapshot.ref_before.length > 0
      && snapshot.ref_after.length > 0
      && attributedWorkspacePaths(snapshot).length > 0
    ));

    if (withChanges.length === 0) {
      return { stats: [], diff: "", commits: "", turnCount: 0, lastTurnId: null };
    }

    const first = withChanges[0]!;
    const last = withChanges[withChanges.length - 1]!;
    const attributedPaths = collectAttributedWorkspacePaths(withChanges);
    const attributedPathGroups = collectAttributedWorkspacePathGroups(withChanges);

    const stats = await this.snapshotService.getDiffStats(
      this.cwd,
      first.ref_before,
      last.ref_after,
      attributedPaths,
      attributedPathGroups,
    );

    const commits = await this.getCommitLog(first.ref_before, last.ref_after);

    const fullDiff = await this.snapshotService.getDiff(
      this.cwd,
      first.ref_before,
      last.ref_after,
      undefined,
      undefined,
      attributedPaths,
      attributedPathGroups,
    );

    let diff: string;
    if (fullDiff.length <= DIFF_CHAR_LIMIT) {
      diff = fullDiff;
    } else {
      diff = await this.buildPartialDiff(stats, first.ref_before, last.ref_after);
    }

    return {
      stats,
      diff,
      commits,
      turnCount: withChanges.length,
      lastTurnId: last.message_id,
    };
  }

  /** Build a partial diff from the top N files by churn, capped to the same char budget. */
  private async buildPartialDiff(
    stats: FileDiffStat[],
    refBefore: string,
    refAfter: string,
  ): Promise<string> {
    const sorted = [...stats].sort(
      (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
    );
    const topFiles = sorted.slice(0, PARTIAL_TOP_FILES);

    let remaining = DIFF_CHAR_LIMIT;
    const parts: string[] = [];
    for (const file of topFiles) {
      if (remaining <= 0) break;
      const fileDiff = await this.snapshotService.getDiff(
        this.cwd,
        refBefore,
        refAfter,
        file.filePath,
      );
      parts.push(fileDiff.slice(0, remaining));
      remaining -= fileDiff.length;
    }

    return parts.join("\n");
  }

  /**
   * Retrieve the commit log between two tree refs via git.
   * GitService.log() requires a workspaceId and only supports branch-based ranges,
   * so we invoke git here to support arbitrary tree SHA ranges.
   */
  private async getCommitLog(
    refBefore: string,
    refAfter: string,
  ): Promise<string> {
    if (!/^[0-9a-fA-F]{4,40}$/.test(refBefore) || !/^[0-9a-fA-F]{4,40}$/.test(refAfter)) {
      return "";
    }

    try {
      const { stdout } = await this.gitExecutor.exec(
        [
          "-C",
          this.cwd,
          "log",
          "--pretty=format:%h %s",
          `${refBefore}..${refAfter}`,
        ],
        { timeout: RealGitExecutor.DEFAULT_TIMEOUT },
      );
      return stdout.trim();
    } catch {
      return "";
    }
  }
}
