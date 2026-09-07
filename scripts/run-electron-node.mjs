/** Runs a JavaScript CLI with the workspace Electron runtime. */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { killPidTree, killProcessTree } from "./kill-process-tree.mjs";

/** Maximum time one Electron CLI invocation may run before its owned process tree is killed. */
export const ELECTRON_PROCESS_TIMEOUT_MS = 10 * 60 * 1_000;

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const workspaceRoot = NodePath.resolve(scriptDir, "..");
const electronRequire = NodeModule.createRequire(NodePath.resolve(workspaceRoot, "apps", "desktop", "package.json"));
const serverRequire = NodeModule.createRequire(NodePath.resolve(workspaceRoot, "apps", "server", "package.json"));

function resolveWorkspaceCli(args) {
  if (args[0] !== "--workspace-cli") return args;

  const [_, packageName, entryFile, ...entryArgs] = args;
  if (!packageName || !entryFile) {
    throw new Error("Expected a package name and CLI entry after --workspace-cli.");
  }

  const packageDir = NodePath.dirname(serverRequire.resolve(`${packageName}/package.json`));
  const cliEntry = NodePath.resolve(packageDir, entryFile);
  const packageRelativeEntry = NodePath.relative(packageDir, cliEntry);
  if (
    NodePath.isAbsolute(entryFile)
    || packageRelativeEntry === ".."
    || packageRelativeEntry.startsWith(`..${NodePath.sep}`)
    || NodePath.isAbsolute(packageRelativeEntry)
  ) {
    throw new Error("Workspace CLI entry must stay inside its package directory.");
  }
  if (!NodeFS.existsSync(cliEntry)) {
    throw new Error(`Workspace CLI entry not found: ${cliEntry}`);
  }

  return [cliEntry, ...entryArgs];
}

/**
 * Runs Electron asynchronously while inheriting the caller's output handles.
 * Keeping Windows children attached preserves ownership until their descendants
 * have been terminated by the wrapper's scoped process-tree kill.
 *
 * @param {string} electronPath
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {Promise<{ status: number | null, signal: NodeJS.Signals | null, error?: Error, timedOut: boolean }>}
 */
export function runElectronProcess(electronPath, args, { cwd, env, timeoutMs = ELECTRON_PROCESS_TIMEOUT_MS }) {
  return new Promise((resolveProcess) => {
    const isWindows = process.platform === "win32";
    const child = NodeChildProcess.spawn(electronPath, args, {
      cwd,
      env,
      shell: false,
      detached: !isWindows,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let settled = false;
    let timeoutHandle;
    let forcedSettlementHandle;
    let spawnError;
    let timedOut = false;

    const recordError = (error) => {
      spawnError ??= error instanceof Error ? error : new Error(String(error));
    };

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
  const electronDir = NodePath.dirname(electronRequire.resolve("electron/package.json"));
  const executable = NodeFS.readFileSync(NodePath.join(electronDir, "path.txt"), "utf8").trim();
  return NodePath.resolve(electronDir, "dist", executable);
}

const invokedScript = process.argv[1] ? NodePath.resolve(process.argv[1]) : null;
const moduleScript = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
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
    },
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
