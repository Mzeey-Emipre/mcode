/** Runs a JavaScript CLI with the workspace Electron runtime and SQLite binding. */

import { spawn } from "child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "fs";
import { createRequire } from "module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
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
 * Runs Electron asynchronously and forwards captured output after the child exits.
 * Detached Windows runs use files so descendants cannot keep the wrapper open.
 *
 * @param {string} electronPath
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {Promise<{ status: number | null, signal: NodeJS.Signals | null, error?: Error, timedOut: boolean }>}
 */
export function runElectronProcess(electronPath, args, { cwd, env, timeoutMs = ELECTRON_PROCESS_TIMEOUT_MS }) {
  return new Promise((resolveProcess) => {
    const isWindows = process.platform === "win32";
    const useDetachedFiles = isWindows && args[0] !== "--workspace-cli";
    const outputDir = useDetachedFiles ? mkdtempSync(join(tmpdir(), "mcode-electron-node-")) : null;
    const stdoutFd = outputDir ? openSync(join(outputDir, "stdout"), "w") : null;
    const stderrFd = outputDir ? openSync(join(outputDir, "stderr"), "w") : null;
    const child = spawn(electronPath, args, {
      cwd,
      env,
      shell: false,
      detached: useDetachedFiles || !isWindows,
      windowsHide: true,
      stdio: ["ignore", stdoutFd ?? "inherit", stderrFd ?? "inherit"],
    });
    if (useDetachedFiles) child.unref();
    let settled = false;
    let timeoutHandle;
    let forcedSettlementHandle;
    let spawnError;
    let timedOut = false;
    let outputClosed = false;

    const recordError = (error) => {
      spawnError ??= error instanceof Error ? error : new Error(String(error));
    };

    const flushOutput = () => {
      if (!outputDir || stdoutFd === null || stderrFd === null || outputClosed) return;
      outputClosed = true;
      try { closeSync(stdoutFd); } catch (error) { recordError(error); }
      try { closeSync(stderrFd); } catch (error) { recordError(error); }
      try {
        const stdout = readFileSync(join(outputDir, "stdout"));
        if (stdout.length > 0) process.stdout.write(stdout);
      } catch (error) { recordError(error); }
      try {
        const stderr = readFileSync(join(outputDir, "stderr"));
        if (stderr.length > 0) process.stderr.write(stderr);
      } catch (error) { recordError(error); }
      try { rmSync(outputDir, { recursive: true, force: true }); } catch (error) { recordError(error); }
    };

    const signalHandlers = new Map();
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      signalHandlers.clear();
    };

    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      flushOutput();
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
      settle(
        timedOut ? 1 : status,
        timedOut ? "SIGTERM" : signal,
      );
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      Promise.resolve(killProcessTree(child, { useProcessGroup: !isWindows }))
        .catch(recordError)
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
          } catch (error) { recordError(error); }
          forcedSettlementHandle = setTimeout(() => settle(1, "SIGTERM"), 1_000);
        });
    }, timeoutMs);
  });
}

function resolveElectronBinary() {
  const electronDir = dirname(electronRequire.resolve("electron/package.json"));
  const executable = readFileSync(join(electronDir, "path.txt"), "utf8").trim();
  return resolve(electronDir, "dist", executable);
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

  const result = await runElectronProcess(resolveElectronBinary(), resolveWorkspaceCli(cliArgs), {
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
