/**
 * Production git executor.
 * Wraps promisified execFile with per-repo serialisation, a configurable
 * default timeout, and a transparent result cache for cheap rev-parse calls.
 */

import { injectable } from "tsyringe";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import type { GitExecutor, GitExecOptions, GitExecResult } from "./types.js";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

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
    if (opts.onStdout || opts.onStderr) return await this.runObservedGit(args, opts);
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

  /** Run Git with streamed output while preserving the buffered result and error contract. */
  private async runObservedGit(args: string[], opts: GitExecOptions): Promise<GitExecResult> {
    const timeout = opts.timeout ?? RealGitExecutor.DEFAULT_TIMEOUT;
    return await new Promise<GitExecResult>((resolve, reject) => {
      const child = NodeChildProcess.spawn("git", args, {
        windowsHide: true,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeout);
      const finish = (result: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        opts.onStdout?.(text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        opts.onStderr?.(text);
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code, signal) => finish(() => {
        if (timedOut) {
          reject(Object.assign(new Error(`Git command timed out after ${timeout} ms`), {
            code: null,
            signal,
            stdout,
            stderr,
            killed: true,
          }));
          return;
        }
        if (code !== 0) {
          reject(Object.assign(new Error(`Git exited with code ${code ?? "unknown"}`), {
            code,
            signal,
            stdout,
            stderr,
          }));
          return;
        }
        resolve({ stdout, stderr });
      }));
    });
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
