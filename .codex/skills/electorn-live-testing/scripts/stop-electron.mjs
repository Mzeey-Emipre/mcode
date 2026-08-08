import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const SESSION_FILE_NAME = "electron-live-testing.json";

/** Stops only the Electron process tree recorded for this worktree. */
export function stopElectron(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const sessionFile = join(root, ".dev", SESSION_FILE_NAME);
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

  if (process.platform === "win32") {
    const stopped = spawnSync(
      "taskkill.exe",
      ["/PID", String(record.pid), "/T", "/F"],
      { encoding: "utf8" },
    );
    if (stopped.status !== 0) {
      throw new Error(`Could not stop Electron process tree: ${stopped.stderr.trim()}`);
    }
  } else {
    process.kill(record.pid, "SIGTERM");
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
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`Could not inspect recorded Electron PID: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
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
