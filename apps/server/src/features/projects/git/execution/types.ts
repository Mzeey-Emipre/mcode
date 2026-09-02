/**
 * Core types for the git executor abstraction.
 */

/** Options accepted by {@link GitExecutor.exec}. */
export interface GitExecOptions {
  /** Working directory to pass as the CWD of the spawned process. */
  cwd?: string;
  /** Timeout in milliseconds. Defaults to RealGitExecutor.DEFAULT_TIMEOUT (10 s). */
  timeout?: number;
  /** Environment variables to merge into the subprocess environment. */
  env?: NodeJS.ProcessEnv;
  /** Receive stdout chunks while Git runs. Enables the observed execution path. */
  onStdout?: (chunk: string) => void;
  /** Receive stderr chunks while Git runs. Enables the observed execution path. */
  onStderr?: (chunk: string) => void;
}

/** Stdout/stderr pair returned by a successful git invocation. */
export interface GitExecResult {
  /** The raw stdout string (UTF-8). */
  stdout: string;
  /** The raw stderr string (UTF-8). */
  stderr: string;
}

/**
 * Abstraction over running `git <args>`.
 * Inject this interface so tests can swap in {@link FakeGitExecutor} without
 * spawning real processes.
 */
export interface GitExecutor {
  /**
   * Run `git` with the given argument list.
   * Rejects with an error when git exits non-zero, mirroring the behaviour of
   * the promisified `child_process.execFile` it wraps.
   */
  exec(args: string[], opts?: GitExecOptions): Promise<GitExecResult>;
}
