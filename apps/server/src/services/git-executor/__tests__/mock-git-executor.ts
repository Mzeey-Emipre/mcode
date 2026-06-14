import { vi, type Mock } from "vitest";
import type { GitExecutor, GitExecOptions, GitExecResult } from "../types.js";

/** Vitest-backed {@link GitExecutor} for GitService unit tests. */
export function createMockGitExecutor(): {
  executor: GitExecutor;
  execFn: Mock<(args: string[], opts?: GitExecOptions) => Promise<GitExecResult>>;
} {
  const execFn = vi.fn(async (_args: string[], _opts?: GitExecOptions): Promise<GitExecResult> => ({
    stdout: "",
    stderr: "",
  }));
  return { executor: { exec: execFn }, execFn };
}
