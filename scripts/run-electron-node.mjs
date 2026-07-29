/** Runs a JavaScript CLI with the workspace Electron runtime and SQLite binding. */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { killPidTree, killProcessTree } from "./kill-process-tree.mjs";

/** Maximum time one Electron CLI invocation may run before its owned process tree is killed. */
export const ELECTRON_PROCESS_TIMEOUT_MS = 10 * 60 * 1_000;

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
    const isWindows = process.platform === "win32";
    const child = spawn(electronPath, args, {
      cwd,
      env,
      shell: false,
      detached: !isWindows,
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

    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });

    const signalHandlers = new Map();
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      signalHandlers.clear();
    };

    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      clearTimeout(timeoutHandle);
      clearTimeout(forcedSettlementHandle);
      resolveProcess({
        status,
        signal,
        ...(spawnError ? { error: spawnError } : {}),
        timedOut,
      });
    };

    const forwardSignal = (signal) => {
      if (settled || !child.pid) return;
      try {
        void Promise.resolve(killPidTree(child.pid, signal, {
          useProcessGroup: !isWindows,
          child,
        })).catch((error) => {
          spawnError ??= error;
        });
      } catch (error) {
        spawnError ??= error;
      }
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => forwardSignal(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

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
      Promise.resolve(killProcessTree(child, { useProcessGroup: !isWindows }))
        .catch(() => undefined)
        .finally(() => {
          if (settled) return;
          try {
            killPidTree(child.pid, "SIGKILL", {
              graceMs: 0,
              useProcessGroup: !isWindows,
              child,
            });
          } catch (error) {
            spawnError ??= error;
          }
          try {
            child.kill();
          } catch {
            // The forced settlement below still closes the adapter if the child race is unusual.
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
  process.exitCode = result.status ?? 1;
}
