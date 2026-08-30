import { logger } from "@mcode/shared";
import type { GithubService, PullRequestWatchSnapshot } from "../github/github-service.js";
import type { ChecksStatus } from "@mcode/contracts";

/** Internal tracking entry for a watched thread. */
export interface WatchEntry {
  threadId: string;
  prNumber: number;
  branch: string;
  repoPath: string;
  cache: ChecksStatus | null;
}

/** Broadcast function signature matching the server push system. */
type BroadcastFn = (channel: string, data: unknown) => void;

/** A terminal lifecycle change detected while polling a linked pull request. */
export interface PullRequestStateChange {
  threadId: string;
  prNumber: number;
  state: "CLOSED" | "MERGED";
}

/** Persists and publishes a terminal pull request lifecycle change. */
type PullRequestStateChangeFn = (change: PullRequestStateChange) => void;

// In-progress checks refresh every 15s. Threads in one repository share a bounded batch,
// so adding another watched PR does not add another request to that polling cycle.
const ACTIVE_INTERVAL_MS = 15_000;
// Terminal checks refresh every 20s to catch a new external run without polling each PR alone.
const PASSIVE_INTERVAL_MS = 20_000;
// When the user just pushed, GitHub Actions take a few seconds to register the new run.
// Bump the cache on this curve so "pending" appears within ~3s of push completion.
const POST_PUSH_BUMP_DELAYS_MS = [3_000, 8_000, 20_000];

/**
 * Server-side CI check watcher with adaptive dual-interval polling.
 * Threads with in-progress checks poll at 15s; terminal checks poll at 20s.
 * Broadcasts `thread.checksUpdated` only when state changes.
 */
export class CiWatcherService {
  private active = new Map<string, WatchEntry>();
  private passive = new Map<string, WatchEntry>();
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private passiveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly bumpTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  private activeTicking = false;
  private passiveTicking = false;

  constructor(
    private readonly githubService: GithubService,
    private readonly broadcast: BroadcastFn,
    private readonly onPullRequestStateChange?: PullRequestStateChangeFn,
  ) {
    this.startPassiveTimer();
  }

  /**
   * Add a thread to the watcher. Starts in the passive set with an immediate first fetch.
   * Pass `skipInitialFetch: true` when the caller will fetch and broadcast the result itself,
   * to avoid spawning a redundant concurrent subprocess.
   */
  watch(threadId: string, prNumber: number, branch: string, repoPath: string, opts?: { skipInitialFetch?: boolean }): void {
    if (this.active.has(threadId) || this.passive.has(threadId)) return;
    this.passive.set(threadId, { threadId, prNumber, branch, repoPath, cache: null });
    this.startPassiveTimer();

    if (opts?.skipInitialFetch) return;

    // Fetch immediately so the client gets data without waiting for the passive tick.
    this.githubService.getCheckRuns(branch, repoPath).then((checks) => {
      const entry = this.passive.get(threadId) ?? this.active.get(threadId);
      if (!entry) return; // unwatched during fetch
      entry.cache = checks;
      this.broadcast("thread.checksUpdated", { threadId, checks });
      if (checks.aggregate === "pending") {
        this.passive.delete(threadId);
        this.active.set(threadId, entry);
        this.startActiveTimer();
        // Passive set just shrank — stop passive timer if it's now empty.
        if (this.passive.size === 0) this.stopPassiveTimer();
      }
    }).catch((err) => {
      logger.debug("CiWatcher initial fetch failed", { threadId, error: String(err) });
    });
  }

  /** Remove a thread from the watcher entirely. */
  unwatch(threadId: string): void {
    this.active.delete(threadId);
    this.passive.delete(threadId);
    this.clearBumpTimers(threadId);
    if (this.active.size === 0) this.stopActiveTimer();
    // Stop the passive timer independently — it's not needed just because active is non-empty.
    if (this.passive.size === 0) this.stopPassiveTimer();
  }

  /** Remove a thread from the watcher and cancel its in-flight GitHub check process. */
  async teardownThread(threadId: string): Promise<void> {
    const entry = this.active.get(threadId) ?? this.passive.get(threadId);
    this.unwatch(threadId);
    if (entry) {
      await this.githubService.cancelCheckRuns(entry.branch, entry.repoPath);
    }
  }

  /** Check if a thread is being watched. */
  isWatching(threadId: string): boolean {
    return this.active.has(threadId) || this.passive.has(threadId);
  }

  /** Get the current entry for a thread (for manual refresh). */
  getEntry(threadId: string): WatchEntry | null {
    return this.active.get(threadId) ?? this.passive.get(threadId) ?? null;
  }

  /**
   * Return the cached status only if it was fetched within `maxAgeMs`. Returns null
   * when the thread is not watched, has no cached result, or the cache is older than
   * `maxAgeMs`. Used by the `github.checkStatus` RPC handler to short-circuit live
   * fetches when the watcher already has a fresh result.
   */
  getFreshCache(threadId: string, maxAgeMs: number): ChecksStatus | null {
    const entry = this.getEntry(threadId);
    if (!entry?.cache) return null;
    if (Date.now() - entry.cache.fetchedAt > maxAgeMs) return null;
    return entry.cache;
  }

  /**
   * Update the cached status for a thread and broadcast if anything changed.
   * Mirrors tick()'s promote/demote logic so a manual refresh keeps the
   * polling cadence correct (e.g. pending → active set, terminal → passive set).
   * Used by the manual-refresh RPC to keep all clients in sync.
   */
  refresh(threadId: string, checks: ChecksStatus): void {
    const entry = this.active.get(threadId) ?? this.passive.get(threadId);
    if (!entry) return;
    const changed = this.hasChanged(entry.cache, checks);
    entry.cache = checks;
    if (changed) {
      this.broadcast("thread.checksUpdated", { threadId, checks });
    }

    // Promote to active when checks are running, demote to passive when terminal.
    if (this.passive.has(threadId) && checks.aggregate === "pending") {
      this.passive.delete(threadId);
      this.active.set(threadId, entry);
      this.startActiveTimer();
      if (this.passive.size === 0) this.stopPassiveTimer();
    } else if (this.active.has(threadId) && checks.aggregate !== "pending") {
      this.active.delete(threadId);
      this.passive.set(threadId, entry);
      this.startPassiveTimer();
      if (this.active.size === 0) this.stopActiveTimer();
    }
  }

  /**
   * Force an immediate fetch + broadcast for a watched thread, bypassing the passive/active
   * tick cadence. Used by push-completion paths so a fresh CI run surfaces within seconds
   * of the push instead of waiting for the next passive tick.
   */
  async bump(threadId: string): Promise<void> {
    const entry = this.active.get(threadId) ?? this.passive.get(threadId);
    if (!entry) return;
    try {
      const checks = await this.githubService.getCheckRuns(entry.branch, entry.repoPath);
      this.refresh(threadId, checks);
    } catch (err) {
      logger.debug("CiWatcher bump failed", { threadId, error: String(err) });
    }
  }

  /**
   * Schedule a burst of bumps on the GitHub Actions registration curve. After a push,
   * runs appear 3-15s later depending on repo size and workflow triggers; this burst
   * catches them without waiting up to a full passive tick.
   */
  scheduleBumpAfterPush(threadId: string): void {
    const entry = this.active.get(threadId) ?? this.passive.get(threadId);
    if (!entry) return;
    this.clearBumpTimers(threadId);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    this.bumpTimers.set(threadId, timers);
    for (const delay of POST_PUSH_BUMP_DELAYS_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (timers.size === 0) this.bumpTimers.delete(threadId);
        void this.bump(threadId);
      }, delay);
      timer.unref?.();
      timers.add(timer);
    }
  }

  /**
   * Find all watched threads matching a workspace + branch pair. Used by the push handler
   * to schedule bumps for any PRs tied to that branch (typically 0 or 1).
   */
  findByWorkspaceBranch(
    threadLookup: (threadId: string) => { branch: string; workspace_id: string } | null,
    workspaceId: string,
    branch: string,
  ): string[] {
    const ids: string[] = [];
    for (const id of [...this.active.keys(), ...this.passive.keys()]) {
      const t = threadLookup(id);
      if (t && t.workspace_id === workspaceId && t.branch === branch) ids.push(id);
    }
    return ids;
  }

  /**
   * Seed the watcher from existing threads with open PRs.
   * Called once on server startup.
   */
  async seed(
    threads: Array<{ id: string; pr_number: number | null; pr_status: string | null; branch: string }>,
    workspacePaths: Map<string, string>,
    getWorkspaceId: (threadId: string) => string | null,
  ): Promise<void> {
    const candidates = threads.filter(
      (t) => t.pr_number != null && t.pr_status != null
        && t.pr_status.toLowerCase() !== "merged"
        && t.pr_status.toLowerCase() !== "closed",
    );

    const targets = candidates.flatMap((t) => {
      const wsId = getWorkspaceId(t.id);
      const repoPath = wsId ? workspacePaths.get(wsId) : undefined;
      if (!repoPath || t.pr_number == null) return [];

      // Insert placeholder synchronously so concurrent watch() calls see this threadId
      // and skip re-insertion during the async fetch window.
      if (!this.active.has(t.id) && !this.passive.has(t.id)) {
        this.passive.set(t.id, { threadId: t.id, prNumber: t.pr_number, branch: t.branch, repoPath, cache: null });
      }
      return [{ threadId: t.id, prNumber: t.pr_number, repoPath }];
    });

    try {
      const snapshots = await this.githubService.getPullRequestWatchSnapshots(targets);
      for (const snapshot of snapshots) {
        const entry = this.passive.get(snapshot.threadId) ?? this.active.get(snapshot.threadId);
        if (entry) this.applyWatchSnapshot(entry, snapshot);
      }
    } catch (err) {
      logger.debug("CiWatcher seed batch failed", { error: String(err) });
    }

    if (this.active.size > 0) this.startActiveTimer();
    logger.info(`CiWatcher seeded: ${this.active.size} active, ${this.passive.size} passive`);
  }

  /** Clean up all timers. Called on server shutdown. */
  async dispose(): Promise<void> {
    for (const threadId of this.bumpTimers.keys()) {
      this.clearBumpTimers(threadId);
    }
    this.stopActiveTimer();
    this.stopPassiveTimer();
    this.active.clear();
    this.passive.clear();
    await this.githubService.cancelAllInFlight();
  }

  private startActiveTimer(): void {
    if (this.activeTimer) return;
    this.activeTimer = setInterval(async () => {
      if (this.activeTicking) return;
      this.activeTicking = true;
      try { await this.tick(this.active); } finally { this.activeTicking = false; }
    }, ACTIVE_INTERVAL_MS);
  }

  private stopActiveTimer(): void {
    if (this.activeTimer) {
      clearInterval(this.activeTimer);
      this.activeTimer = null;
    }
  }

  private startPassiveTimer(): void {
    if (this.passiveTimer) return;
    this.passiveTimer = setInterval(async () => {
      if (this.passiveTicking) return;
      this.passiveTicking = true;
      try { await this.tick(this.passive); } finally { this.passiveTicking = false; }
    }, PASSIVE_INTERVAL_MS);
  }

  private stopPassiveTimer(): void {
    if (this.passiveTimer) {
      clearInterval(this.passiveTimer);
      this.passiveTimer = null;
    }
  }

  private clearBumpTimers(threadId: string): void {
    const timers = this.bumpTimers.get(threadId);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    this.bumpTimers.delete(threadId);
  }

  /** Returns true when `next` differs semantically from `cached` (aggregate, run count, or per-run status/conclusion). */
  private hasChanged(cached: ChecksStatus | null, next: ChecksStatus): boolean {
    return cached == null
      || cached.aggregate !== next.aggregate
      || cached.runs.length !== next.runs.length
      || cached.runs.some((r, i) => {
        const nr = next.runs[i];
        return nr && (r.status !== nr.status || r.conclusion !== nr.conclusion);
      });
  }

  private async tick(set: Map<string, WatchEntry>): Promise<void> {
    if (set.size === 0) return;

    const entries = [...set.values()];
    try {
      const snapshots = await this.githubService.getPullRequestWatchSnapshots(
        entries.map((entry) => ({
          threadId: entry.threadId,
          prNumber: entry.prNumber,
          repoPath: entry.repoPath,
        })),
      );
      for (const snapshot of snapshots) {
        const entry = this.active.get(snapshot.threadId) ?? this.passive.get(snapshot.threadId);
        if (entry) this.applyWatchSnapshot(entry, snapshot);
      }
    } catch (err) {
      logger.debug("CiWatcher batch tick failed", { error: String(err) });
    }
  }

  private applyWatchSnapshot(entry: WatchEntry, snapshot: PullRequestWatchSnapshot): void {
    if (entry.prNumber !== snapshot.prNumber) return;
    if (snapshot.state === "CLOSED" || snapshot.state === "MERGED") {
      this.onPullRequestStateChange?.({
        threadId: entry.threadId,
        prNumber: entry.prNumber,
        state: snapshot.state,
      });
      this.unwatch(entry.threadId);
      return;
    }
    this.refresh(entry.threadId, snapshot.checks);
  }
}
