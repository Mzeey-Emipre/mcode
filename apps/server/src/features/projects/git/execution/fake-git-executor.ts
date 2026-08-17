/**
 * Test double for GitExecutor.
 * Records every call and returns canned responses from a configurable map.
 * Preserves per-key FIFO serialisation so queue-ordering tests remain valid.
 */

import type { GitExecutor, GitExecOptions, GitExecResult } from "./types.js";

/** A single recorded invocation. */
export interface FakeGitCall {
  /** Arguments passed to exec (excluding the implicit "git" binary). */
  args: string[];
  /** Options passed to exec, if any. */
  opts: GitExecOptions | undefined;
}

/** Noop used to drain queue chains. */
const noop = () => {};

/**
 * In-memory {@link GitExecutor} for unit tests.
 *
 * Usage:
 * ```ts
 * const fake = new FakeGitExecutor();
 * fake.setResponse(["rev-parse", "--git-dir"], { stdout: ".git", stderr: "" });
 * const result = await fake.exec(["-C", "/repo", "rev-parse", "--git-dir"]);
 * ```
 *
 * Response lookup strips the leading `-C <path>` pair before matching so the
 * same canned response applies regardless of which cwd is passed.
 *
 * If no matching response is registered, exec resolves with `{ stdout: "", stderr: "" }`.
 */
export class FakeGitExecutor implements GitExecutor {
  /** Ordered list of every exec invocation (for assertion in tests). */
  readonly calls: FakeGitCall[] = [];

  /** Canned responses keyed by JSON-serialised args (after stripping -C). */
  private readonly responses = new Map<string, GitExecResult | Error>();

  /** Per-key serialisation queues (mirrors RealGitExecutor behaviour). */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Register a canned response for the given argument list.
   * The args should omit the leading `-C <path>` pair; the executor strips it
   * automatically during lookup.
   *
   * Pass an `Error` instance to simulate a non-zero exit code.
   */
  setResponse(args: string[], result: GitExecResult | Error): void {
    this.responses.set(this.responseKey(args), result);
  }

  /** Remove all registered canned responses and clear recorded calls. */
  reset(): void {
    this.calls.length = 0;
    this.responses.clear();
    this.queues.clear();
  }

  /**
   * Execute a git command, honouring the registered canned response.
   * Serialises calls per effective cwd so queue-ordering tests work correctly.
   */
  async exec(args: string[], opts?: GitExecOptions): Promise<GitExecResult> {
    const queueKey = this.getQueueKey(args, opts);

    return this.enqueue(queueKey, async () => {
      this.calls.push({ args, opts });

      const normalized = this.stripCArg(args);
      const key = this.responseKey(normalized);
      const response = this.responses.get(key);

      if (response instanceof Error) throw response;
      return response ?? { stdout: "", stderr: "" };
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.queues.get(key) ?? Promise.resolve()) as Promise<void>;
    const next = prev.then(fn, fn);
    this.queues.set(key, next.then(noop, noop));
    return next;
  }

  private getQueueKey(args: string[], opts?: GitExecOptions): string {
    const cIdx = args.indexOf("-C");
    if (cIdx !== -1 && cIdx + 1 < args.length) return args[cIdx + 1]!;
    return opts?.cwd ?? "__global__";
  }

  /** Strip a leading `-C <path>` pair from args for response-key normalisation. */
  private stripCArg(args: string[]): string[] {
    if (args[0] === "-C" && args.length >= 2) return args.slice(2);
    return args;
  }

  private responseKey(args: string[]): string {
    return JSON.stringify(args);
  }
}
