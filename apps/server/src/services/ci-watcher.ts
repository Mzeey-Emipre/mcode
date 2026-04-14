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

const ACTIVE_INTERVAL_MS = 10_000;
const PASSIVE_INTERVAL_MS = 60_000;

/**
 * Server-side CI check watcher with adaptive dual-interval polling.
 * Threads with in-progress checks poll at 10s; terminal checks poll at 60s.
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

  /** Add a thread to the watcher. Starts in the passive set. */
  watch(threadId: string, prNumber: number, repoPath: string): void {
    if (this.active.has(threadId) || this.passive.has(threadId)) return;
    this.passive.set(threadId, { threadId, prNumber, repoPath, cache: null });
    this.startPassiveTimer();
  }

  /** Remove a thread from the watcher entirely. */
  unwatch(threadId: string): void {
    this.active.delete(threadId);
    this.passive.delete(threadId);
    if (this.active.size === 0) this.stopActiveTimer();
    if (this.passive.size === 0 && this.active.size === 0) this.stopPassiveTimer();
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

      try {
        const checks = await this.githubService.getCheckRuns(t.pr_number, repoPath);
        const entry: WatchEntry = { threadId: t.id, prNumber: t.pr_number, repoPath, cache: checks };

        if (checks.aggregate === "pending") {
          this.active.set(t.id, entry);
        } else {
          this.passive.set(t.id, entry);
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
      } else if (set === this.active && checks.aggregate !== "pending") {
        this.active.delete(entry.threadId);
        this.passive.set(entry.threadId, entry);
        if (this.active.size === 0) this.stopActiveTimer();
      }
    }
  }
}
