import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { terminateProcessTree } from "./process-tree.mjs";

const { spawnSync } = NodeChildProcess;
const { existsSync, readFileSync, rmSync } = NodeFS;
const { join, resolve } = NodePath;

const SESSION_FILE_NAME = "electron-live-testing.json";

/** Stops only the Electron process tree recorded for this worktree. */
export function stopElectron(repoRoot = process.cwd(), options = {}) {
  const root = resolve(repoRoot);
  const sessionFileName = options.sessionFileName ?? SESSION_FILE_NAME;
  if (!/^electron-[a-z0-9-]+\.json$/.test(sessionFileName)) {
    throw new Error("sessionFileName must be a safe Electron session file name");
  }
  const sessionFile = join(root, ".dev", sessionFileName);
  if (!existsSync(sessionFile)) return { status: "not-running" };

  const record = JSON.parse(readFileSync(sessionFile, "utf8"));
  validateRecord(record, root);
  const commandLine = readCommandLine(record.pid);
  if (!commandLine) {
    rmSync(sessionFile, { force: true });
    return { pid: record.pid, status: "already-stopped" };
  }

  const normalizedCommand = commandLine.toLowerCase();
  const expectedExecutable = resolve(record.executablePath).toLowerCase();
  const expectedPort = `--remote-debugging-port=${record.debugPort}`;
  if (!normalizedCommand.includes(expectedExecutable) || !normalizedCommand.includes(expectedPort)) {
    throw new Error("Recorded PID no longer matches the owned Electron command");
  }

  const stopped = terminateProcessTree(record.pid);
  if (!stopped.ok) {
    throw new Error(`Could not stop Electron process tree: ${stopped.error}`);
  }

  rmSync(sessionFile, { force: true });
  return { pid: record.pid, status: "stopped" };
}

function readCommandLine(pid) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`Could not inspect recorded Electron PID: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function validateRecord(record, root) {
  if (
    !record ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isInteger(record.debugPort) ||
    record.debugPort <= 0 ||
    record.debugPort > 65_535 ||
    typeof record.executablePath !== "string" ||
    typeof record.repoRoot !== "string" ||
    resolve(record.repoRoot).toLowerCase() !== root.toLowerCase()
  ) {
    throw new Error("Electron session record is invalid");
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(stopElectron(), null, 2));
}
