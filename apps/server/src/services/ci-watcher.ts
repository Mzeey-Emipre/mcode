import { logger } from "@mcode/shared";
import type { GithubService } from "./github-service";
import type { ChecksStatus } from "@mcode/contracts";

/** Internal tracking entry for a watched thread. */
export interface WatchEntry {
  threadId: string;
  prNumber: number;
  repoPath: string;
  cache: ChecksStatus | null;
}

/** Broadcast function signature matching the server push system. */
type BroadcastFn = (channel: string, data: unknown) => void;

// 10s for in-progress checks: responsive enough to catch completion within a PR review window.
// Worst case: 5 active threads × 6 calls/min = 30 calls/min, well within GitHub's 5000/hr limit.
const ACTIVE_INTERVAL_MS = 10_000;
// 30s for terminal checks: catches re-triggered CI runs within half a minute.
// Worst case: 5 passive threads × 2 calls/min = 10 calls/min, well within GitHub's 5000/hr limit.
const PASSIVE_INTERVAL_MS = 30_000;

/**
 * Server-side CI check watcher with adaptive dual-interval polling.
 * Threads with in-progress checks poll at 10s; terminal checks poll at 30s.
 * Broadcasts `thread.checksUpdated` only when state changes.
 */
export class CiWatcherService {
  private active = new Map<string, WatchEntry>();
  private passive = new Map<string, WatchEntry>();
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private passiveTimer: ReturnType<typeof setInterval> | null = null;
  private activeTicking = false;
  private passiveTicking = false;

  constructor(
    private readonly githubService: GithubService,
    private readonly broadcast: BroadcastFn,
  ) {
    this.startPassiveTimer();
  }

  /**
   * Add a thread to the watcher. Starts in the passive set with an immediate first fetch.
   * Pass `skipInitialFetch: true` when the caller will fetch and broadcast the result itself,
   * to avoid spawning a redundant concurrent subprocess.
   */
  watch(threadId: string, prNumber: number, repoPath: string, opts?: { skipInitialFetch?: boolean }): void {
    if (this.active.has(threadId) || this.passive.has(threadId)) return;
    this.passive.set(threadId, { threadId, prNumber, repoPath, cache: null });
    this.startPassiveTimer();

    if (opts?.skipInitialFetch) return;

    // Fetch immediately so the client gets data without waiting for the passive tick.
    this.githubService.getCheckRuns(prNumber, repoPath).then((checks) => {
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
    if (this.active.size === 0) this.stopActiveTimer();
    // Stop the passive timer independently — it's not needed just because active is non-empty.
    if (this.passive.size === 0) this.stopPassiveTimer();
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
   * Update the cached status for a thread and broadcast the change.
   * Mirrors tick()'s promote/demote logic so a manual refresh keeps the
   * polling cadence correct (e.g. pending → active set, terminal → passive set).
   * Used by the manual-refresh RPC to keep all clients in sync.
   */
  refresh(threadId: string, checks: ChecksStatus): void {
    const entry = this.active.get(threadId) ?? this.passive.get(threadId);
    if (!entry) return;
    entry.cache = checks;
    this.broadcast("thread.checksUpdated", { threadId, checks });

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

    const fetches = candidates.map(async (t) => {
      const wsId = getWorkspaceId(t.id);
      const repoPath = wsId ? workspacePaths.get(wsId) : undefined;
      if (!repoPath || t.pr_number == null) return;

      // Insert placeholder synchronously so concurrent watch() calls see this threadId
      // and skip re-insertion during the async fetch window.
      if (!this.active.has(t.id) && !this.passive.has(t.id)) {
        this.passive.set(t.id, { threadId: t.id, prNumber: t.pr_number, repoPath, cache: null });
      }

      try {
        const checks = await this.githubService.getCheckRuns(t.pr_number, repoPath);
        const entry = this.passive.get(t.id) ?? this.active.get(t.id);
        if (!entry) return; // was unwatched during fetch
        entry.cache = checks;

        // Promote to active if checks are pending; it's already in passive
        if (checks.aggregate === "pending") {
          this.passive.delete(t.id);
          this.active.set(t.id, entry);
        }
      } catch (err) {
        logger.debug("CiWatcher seed failed for thread", { threadId: t.id, error: String(err) });
      }
    });

    await Promise.allSettled(fetches);

    if (this.active.size > 0) this.startActiveTimer();
    logger.info(`CiWatcher seeded: ${this.active.size} active, ${this.passive.size} passive`);
  }

  /** Clean up all timers. Called on server shutdown. */
  dispose(): void {
    this.stopActiveTimer();
    this.stopPassiveTimer();
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

  private async tick(set: Map<string, WatchEntry>): Promise<void> {
    if (set.size === 0) return;

    const entries = [...set.values()];
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const checks = await this.githubService.getCheckRuns(entry.prNumber, entry.repoPath);
        return { entry, checks };
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") continue;
      const { entry, checks } = result.value;

      // Guard: thread was unwatched while the fetch was in flight
      if (!this.active.has(entry.threadId) && !this.passive.has(entry.threadId)) continue;

      const changed = entry.cache == null || entry.cache.aggregate !== checks.aggregate
        || entry.cache.runs.length !== checks.runs.length
        || entry.cache.runs.some((r, i) => {
          const nr = checks.runs[i];
          return nr && (r.status !== nr.status || r.conclusion !== nr.conclusion);
        });

      entry.cache = checks;

      if (changed) {
        this.broadcast("thread.checksUpdated", {
          threadId: entry.threadId,
          checks,
        });
      }

      // Promote/demote between sets
      if (set === this.passive && checks.aggregate === "pending") {
        this.passive.delete(entry.threadId);
        this.active.set(entry.threadId, entry);
        this.startActiveTimer();
        // Passive set shrank — stop timer if now empty.
        if (this.passive.size === 0) this.stopPassiveTimer();
      } else if (set === this.active && checks.aggregate !== "pending") {
        this.active.delete(entry.threadId);
        this.passive.set(entry.threadId, entry);
        this.startPassiveTimer();
        if (this.active.size === 0) this.stopActiveTimer();
      }
    }
  }
}
