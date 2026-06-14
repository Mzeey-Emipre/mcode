/**
 * Production git executor.
 * Wraps promisified execFile with per-repo serialisation, a configurable
 * default timeout, and a transparent result cache for cheap rev-parse calls.
 */

import { injectable } from "tsyringe";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import type { GitExecutor, GitExecOptions, GitExecResult } from "./types.js";

const execFile = promisify(execFileCb);

/** Noop used to suppress unhandled-rejection warnings on queue chains. */
const noop = () => {};

/**
 * Production implementation of {@link GitExecutor}.
 *
 * Features:
 * - Serialises concurrent git calls per effective working directory so that
 *   index-mutating operations (worktree add/remove, checkout) do not race.
 * - Transparent LRU-style cache for `rev-parse --git-dir` and
 *   `rev-parse --show-toplevel` results keyed by cwd.
 * - Default timeout of 10 s, overridable per call.
 */
@injectable()
export class RealGitExecutor implements GitExecutor {
  /** Default timeout in milliseconds for all git invocations. */
  static readonly DEFAULT_TIMEOUT = 10_000;

  /** Per-directory promise queues (key = effective cwd). */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Cache for `rev-parse --git-dir` and `rev-parse --show-toplevel` results.
   * Key format: `"git-dir:<cwd>"` or `"show-toplevel:<cwd>"`.
   */
  private readonly revParseCache = new Map<string, GitExecResult>();

  /**
   * Run `git` with the given arguments, serialising calls per effective cwd.
   * Results of `rev-parse --git-dir` and `rev-parse --show-toplevel` are
   * cached transparently so repeated probe calls are free.
   */
  async exec(args: string[], opts: GitExecOptions = {}): Promise<GitExecResult> {
    const cacheKey = this.getCacheKey(args);
    const queueKey = this.getQueueKey(args, opts);

    return this.enqueue(queueKey, async () => {
      // Re-check cache inside the queue in case a concurrent queued operation
      // already populated it while we were waiting.
      const cachedNow = cacheKey ? this.revParseCache.get(cacheKey) : undefined;
      if (cachedNow) return cachedNow;

      const result = await this.runGit(args, opts);
      if (cacheKey) {
        this.revParseCache.set(cacheKey, result);
      } else {
        this.invalidateRevParseCacheForCwd(this.getEffectiveCwd(args, opts));
      }
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Enqueue an async operation behind any previously queued operation for the
   * same key. Each operation runs regardless of whether the previous one
   * succeeded or failed, preventing a single error from stalling the queue.
   */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.queues.get(key) ?? Promise.resolve()) as Promise<void>;
    // Run fn after prev settles (success or failure).
    const next = prev.then(fn, fn);
    // Store a void sentinel so map values are homogeneous and results don't
    // accumulate in memory.
    const sentinel = next.then(noop, noop);
    this.queues.set(key, sentinel);
    return next;
  }

  /** Invoke git, returning stdout/stderr as UTF-8 strings. */
  private async runGit(
    args: string[],
    opts: GitExecOptions,
  ): Promise<GitExecResult> {
    const timeout = opts.timeout ?? RealGitExecutor.DEFAULT_TIMEOUT;
    const result = await execFile("git", args, {
      timeout,
      windowsHide: true,
      encoding: "utf8",
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
    };
  }

  /**
   * Extract the effective working directory from a `-C <path>` arg or
   * `opts.cwd`, used as the serialisation queue key.
   */
  private getQueueKey(args: string[], opts: GitExecOptions): string {
    return this.getEffectiveCwd(args, opts);
  }

  /** Drop cached rev-parse probes for a checkout after mutating git commands. */
  private invalidateRevParseCacheForCwd(cwd: string): void {
    if (cwd === "__global__") return;
    this.revParseCache.delete(`git-dir:${cwd}`);
    this.revParseCache.delete(`show-toplevel:${cwd}`);
  }

  /** Extract the effective working directory from `-C <path>` or `opts.cwd`. */
  private getEffectiveCwd(args: string[], opts: GitExecOptions): string {
    const cIdx = args.indexOf("-C");
    if (cIdx !== -1 && cIdx + 1 < args.length) return args[cIdx + 1]!;
    return opts.cwd ?? "__global__";
  }

  /**
   * Return a deterministic cache key when the command is a cheap read-only
   * rev-parse probe that produces stable output for a given repo checkout.
   * Returns null for all other commands.
   */
  private getCacheKey(args: string[]): string | null {
    if (!args.includes("rev-parse")) return null;
    const cIdx = args.indexOf("-C");
    if (cIdx === -1 || cIdx + 1 >= args.length) return null;
    const cwd = args[cIdx + 1]!;
    if (args.includes("--git-dir")) return `git-dir:${cwd}`;
    if (args.includes("--show-toplevel")) return `show-toplevel:${cwd}`;
    return null;
  }
}
