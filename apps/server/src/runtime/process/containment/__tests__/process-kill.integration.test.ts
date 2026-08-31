import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { killProcessTree } from "../process-kill.js";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const spawnedRoots = new Set<number>();

async function isRunning(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  return stdout.includes(`"${pid}"`);
}

describe.runIf(process.platform === "win32")("killProcessTree integration", () => {
  afterEach(async () => {
    await Promise.all([...spawnedRoots].map((pid) => killProcessTree(pid, { platform: hostRuntime.platform }).catch(() => undefined)));
    spawnedRoots.clear();
  });

  it("terminates a real idle process within the bounded close window", async () => {
    const root = NodeChildProcess.spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"],
      { stdio: "ignore" },
    );
    if (!root.pid) throw new Error("Root process did not start");
    spawnedRoots.add(root.pid);
    expect(await isRunning(root.pid)).toBe(true);

    const startedAt = performance.now();
    await killProcessTree(root.pid, { platform: hostRuntime.platform });
    const durationMs = performance.now() - startedAt;
    spawnedRoots.delete(root.pid);

    expect(durationMs).toBeLessThan(12_000);
    await expect.poll(() => isRunning(root.pid!), { timeout: 5_000 }).toBe(false);
  }, 30_000);

  it("terminates a real root process and its descendant", async () => {
    const root = NodeChildProcess.spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output $child.Id; Start-Sleep -Seconds 60",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!root.pid) throw new Error("Root process did not start");
    spawnedRoots.add(root.pid);
    const childPid = await new Promise<number>((resolve, reject) => {
      root.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
      root.once("error", reject);
    });
    spawnedRoots.add(childPid);
    expect(await isRunning(root.pid)).toBe(true);
    expect(await isRunning(childPid)).toBe(true);

    const startedAt = performance.now();
    await killProcessTree(root.pid, { platform: hostRuntime.platform });
    const durationMs = performance.now() - startedAt;
    spawnedRoots.delete(root.pid);
    spawnedRoots.delete(childPid);

    expect(durationMs).toBeLessThan(12_000);
    await expect.poll(() => isRunning(root.pid!), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => isRunning(childPid), { timeout: 5_000 }).toBe(false);
  }, 60_000);
});
