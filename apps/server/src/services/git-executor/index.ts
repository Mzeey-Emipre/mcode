/**
 * Git executor module.
 * Provides an injectable abstraction over spawning git subprocesses with
 * per-repo serialisation, configurable timeouts, and a transparent cache for
 * cheap rev-parse results.
 */

export type { GitExecutor, GitExecOptions, GitExecResult } from "./types.js";
export { RealGitExecutor } from "./real-git-executor.js";
export { FakeGitExecutor } from "./fake-git-executor.js";
