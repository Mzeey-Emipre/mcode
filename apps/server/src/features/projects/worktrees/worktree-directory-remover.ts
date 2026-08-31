import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";

/** Default hard limit for a recursive worktree directory removal. */
export const DEFAULT_WORKTREE_REMOVAL_TIMEOUT_MS = 30_000;

/** Maximum time allowed for confirming that a timed-out remover was killed. */
const KILL_CONFIRMATION_TIMEOUT_MS = 1_000;

const REMOVE_SCRIPT = [
  "require('node:fs/promises').rm(process.argv[1], { recursive: true, force: true })",
  ".catch((error) => { console.error(error); process.exitCode = 1; });",
].join(" ");

/** Dependencies used by the bounded child-process deletion boundary. */
export interface WorktreeDirectoryRemoverDependencies {
  spawn?: typeof NodeChildProcess.spawn;
  killTree?: (child: NodeChildProcess.ChildProcess) => void | Promise<void>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/** Removes one validated worktree directory in an isolated child process. */
@injectable()
export class WorktreeDirectoryRemover {
  private readonly dependencies: Omit<Required<WorktreeDirectoryRemoverDependencies>, "platform"> & {
    readonly platform: NodeJS.Platform | undefined;
  };

  constructor(
    @inject("WorktreeDirectoryRemoverDependencies", { isOptional: true })
    dependencies: WorktreeDirectoryRemoverDependencies = {},
  ) {
    this.dependencies = {
      spawn: NodeChildProcess.spawn,
      killTree: (child) => killChildTree(child, this.requirePlatform()),
      platform: dependencies.platform,
      timeoutMs: DEFAULT_WORKTREE_REMOVAL_TIMEOUT_MS,
      ...dependencies,
    };
  }

  /**
   * Remove a directory without allowing recursive filesystem work to block
   * the server event loop indefinitely.
   *
   * @param targetPath Absolute worktree directory path.
   * @param timeoutMs Optional test override for the hard child limit.
   */
  async remove(targetPath: string, timeoutMs = this.dependencies.timeoutMs): Promise<void> {
    const platform = this.requirePlatform();
    const target = validateRemovalTarget(targetPath, platform);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid worktree removal timeout: ${timeoutMs}`);
    }

    const child = this.dependencies.spawn(process.execPath, ["-e", REMOVE_SCRIPT, target], {
      cwd: NodePath.parse(target).dir,
      shell: false,
      windowsHide: true,
      detached: platform !== "win32",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let timedOut = false;
      let resolveClose!: () => void;
      const closePromise = new Promise<void>((resolveClosePromise) => {
        resolveClose = resolveClosePromise;
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void (async () => {
          const timeoutError = new Error(
            `Worktree directory removal timed out after ${timeoutMs}ms: ${target}`,
          );
          try {
            await this.dependencies.killTree(child);
          } catch {
            // The removal already exceeded its deadline. Return the timeout
            // after the kill attempt even if the OS reports a stale PID.
          }
          await Promise.race([
            closePromise,
            new Promise<void>((resolveConfirmation) => {
              setTimeout(resolveConfirmation, KILL_CONFIRMATION_TIMEOUT_MS);
            }),
          ]);
          finish(timeoutError);
        })();
      }, timeoutMs);

      child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      child.once("close", (code, signal) => {
        resolveClose();
        if (timedOut) return;
        if (code === 0) {
          finish();
          return;
        }
        finish(new Error(
          `Worktree directory removal failed${signal ? ` (${signal})` : ` with exit code ${code}`}: ${target}`,
        ));
      });
    });
  }

  private requirePlatform(): NodeJS.Platform {
    if (this.dependencies.platform) return this.dependencies.platform;
    throw new Error("Worktree directory remover platform is required");
  }
}

/** Validate a child-process deletion target at the filesystem boundary. */
export function validateRemovalTarget(targetPath: string, platform: NodeJS.Platform): string {
  if (typeof targetPath !== "string" || !NodePath.isAbsolute(targetPath)) {
    throw new Error(`Worktree removal target must be absolute: ${targetPath}`);
  }
  const target = NodePath.resolve(targetPath);
  if (target === NodePath.parse(target).root) {
    throw new Error(`Refusing to remove filesystem root: ${target}`);
  }
  const protectedPaths = [
    { path: NodePath.resolve(process.cwd()), label: "server working directory" },
    { path: NodePath.resolve(process.execPath), label: "server executable" },
  ];
  for (const protectedPath of protectedPaths) {
    if (isEqualOrAncestor(target, protectedPath.path, platform)) {
      throw new Error(`Refusing to remove the ${protectedPath.label}: ${target}`);
    }
  }
  return target;
}

/** Terminate the isolated remover and all of its descendants. */
async function killChildTree(child: NodeChildProcess.ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (!child.pid) return;
  if (platform === "win32") {
    await new Promise<void>((resolvePromise) => {
      const killer = NodeChildProcess.spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try { killer.kill(); } catch { /* already stopped */ }
        resolvePromise();
      }, KILL_CONFIRMATION_TIMEOUT_MS);
      killer.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      killer.once("error", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/** Compare path ancestry with Windows case-insensitive semantics. */
function isEqualOrAncestor(candidate: string, protectedPath: string, platform: NodeJS.Platform): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate, platform);
  const normalizedProtectedPath = normalizePathForComparison(protectedPath, platform);
  if (normalizedCandidate === normalizedProtectedPath) return true;
  const separator = platform === "win32" ? "\\" : "/";
  return normalizedProtectedPath.startsWith(
    normalizedCandidate.endsWith(separator) ? normalizedCandidate : `${normalizedCandidate}${separator}`,
  );
}

/** Normalize path text for lexical ancestry checks. */
function normalizePathForComparison(path: string, platform: NodeJS.Platform): string {
  const normalized = NodePath.resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
