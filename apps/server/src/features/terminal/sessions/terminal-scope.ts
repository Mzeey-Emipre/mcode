import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TerminalScopeSchema, type TerminalScope } from "@mcode/contracts";

/** Dependencies that resolve a Terminal scope to its current checkout. */
export interface TerminalScopeResolverDependencies {
  readonly workspaces: { findById(id: string): { readonly id: string; readonly path: string } | null };
  readonly threads: {
    findById(id: string): {
      readonly id: string;
      readonly workspace_id: string;
      readonly mode: string;
      readonly worktree_path: string | null;
    } | null;
  };
  readonly resolveWorkingDir: (workspacePath: string, mode: string, worktreePath: string | null) => string;
  readonly validateWorkingDirectory?: (path: string) => boolean;
}

/** Raised when a Terminal scope cannot resolve to an existing checkout. */
export class TerminalScopeResolutionError extends Error {
  constructor() {
    super("The Terminal scope is invalid");
    this.name = "TerminalScopeResolutionError";
  }
}

/** Resolves a validated Terminal scope to the current workspace or Thread checkout. */
export function resolveTerminalScope(
  scope: TerminalScope,
  deps: TerminalScopeResolverDependencies,
): string {
  const parsed = TerminalScopeSchema().parse(scope);
  const workspace = deps.workspaces.findById(parsed.workspaceId);
  if (!workspace) throw new TerminalScopeResolutionError();
  let cwd = workspace.path;
  if (parsed.kind === "thread") {
    const thread = deps.threads.findById(parsed.threadId);
    if (!thread || thread.workspace_id !== parsed.workspaceId) {
      throw new TerminalScopeResolutionError();
    }
    cwd = deps.resolveWorkingDir(workspace.path, thread.mode, thread.worktree_path);
  }
  const validate = deps.validateWorkingDirectory ?? isExistingAbsoluteDirectory;
  if (!validate(cwd)) throw new TerminalScopeResolutionError();
  return cwd;
}

function isExistingAbsoluteDirectory(path: string): boolean {
  if (!isAbsolute(path) || !existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
