/** Runs a JavaScript CLI with the workspace Electron runtime and SQLite binding. */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

/** Maximum time one Electron CLI invocation may run before its owned process tree is killed. */
export const ELECTRON_PROCESS_TIMEOUT_MS = 10 * 60 * 1_000;

/** Maximum time allowed for the Windows process-tree terminator to settle. */
const PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const electronRequire = createRequire(resolve(workspaceRoot, "apps", "desktop", "package.json"));
const serverRequire = createRequire(resolve(workspaceRoot, "apps", "server", "package.json"));

function resolveElectronBinding() {
  const betterSqliteDir = dirname(serverRequire.resolve("better-sqlite3/package.json"));
  const bindingPath = join(
    betterSqliteDir,
    "build",
    "Release",
    "better_sqlite3.electron.node",
  );
  if (!existsSync(bindingPath)) {
    throw new Error(`Workspace Electron better-sqlite3 binding not found: ${bindingPath}`);
  }
  return bindingPath;
}

function resolveWorkspaceCli(args) {
  if (args[0] !== "--workspace-cli") return args;

  const [_, packageName, entryFile, ...entryArgs] = args;
  if (!packageName || !entryFile) {
    throw new Error("Expected a package name and CLI entry after --workspace-cli.");
  }

  const packageDir = dirname(serverRequire.resolve(`${packageName}/package.json`));
  const cliEntry = resolve(packageDir, entryFile);
  const packageRelativeEntry = relative(packageDir, cliEntry);
  if (
    isAbsolute(entryFile)
    || packageRelativeEntry === ".."
    || packageRelativeEntry.startsWith(`..${sep}`)
    || isAbsolute(packageRelativeEntry)
  ) {
    throw new Error("Workspace CLI entry must stay inside its package directory.");
  }
  if (!existsSync(cliEntry)) {
    throw new Error(`Workspace CLI entry not found: ${cliEntry}`);
  }

  return [cliEntry, ...entryArgs];
}

/**
 * Terminates only the Electron child and descendants without blocking Bun's event loop.
 *
 * @param {import("child_process").ChildProcess} child
 * @returns {Promise<void>}
 */
function terminateProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return Promise.resolve();
  }

  return new Promise((resolveTermination) => {
    const terminator = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    let timeoutHandle;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolveTermination();
    };
    timeoutHandle = setTimeout(() => {
      try {
        terminator.kill();
      } catch {
        // The terminator may have already exited.
      }
      finish();
    }, PROCESS_TREE_KILL_TIMEOUT_MS);
    terminator.once("error", finish);
    terminator.once("close", finish);
  });
}

/**
 * Runs Electron asynchronously so Bun can drain both child output pipes while the
 * Electron process starts and exits.
 *
 * @param {string} electronPath
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {Promise<{ status: number | null, signal: NodeJS.Signals | null, error?: Error, timedOut: boolean }>}
 */
export function runElectronProcess(electronPath, args, { cwd, env, timeoutMs = ELECTRON_PROCESS_TIMEOUT_MS }) {
  return new Promise((resolveProcess) => {
    const child = spawn(electronPath, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timeoutHandle;
    let forcedSettlementHandle;
    let spawnError;
    let timedOut = false;
    let exitStatus;
    let exitSignal;

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(forcedSettlementHandle);
      resolveProcess({
        status,
        signal,
        ...(spawnError ? { error: spawnError } : {}),
        timedOut,
      });
    };

    child.once("error", (error) => {
      spawnError = error;
      settle(1, null);
    });
    child.once("exit", (status, signal) => {
      exitStatus = status;
      exitSignal = signal;
    });
    child.once("close", (status, signal) => {
      settle(
        timedOut ? 1 : exitStatus ?? status,
        timedOut ? "SIGTERM" : exitSignal ?? signal,
      );
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).then(() => {
        if (settled) return;
        try {
          child.kill();
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        forcedSettlementHandle = setTimeout(() => settle(1, "SIGTERM"), 1_000);
      });
    }, timeoutMs);
  });
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : null;
const moduleScript = resolve(fileURLToPath(import.meta.url));
const isMain = invokedScript && (
  process.platform === "win32"
    ? invokedScript.toLowerCase() === moduleScript.toLowerCase()
    : invokedScript === moduleScript
);

if (isMain) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length === 0) {
    throw new Error("Expected a JavaScript CLI entry and its arguments.");
  }

  const result = await runElectronProcess(electronRequire("electron"), resolveWorkspaceCli(cliArgs), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BETTER_SQLITE3_BINDING: resolveElectronBinding(),
    },
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
