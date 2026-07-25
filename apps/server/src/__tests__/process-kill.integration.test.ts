import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { killProcessTree } from "../services/process-kill";

const execFileAsync = promisify(execFile);
const spawnedRoots = new Set<number>();

async function isRunning(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  return stdout.includes(`"${pid}"`);
}

describe.runIf(process.platform === "win32")("killProcessTree integration", () => {
  afterEach(async () => {
    await Promise.all([...spawnedRoots].map((pid) => killProcessTree(pid).catch(() => undefined)));
    spawnedRoots.clear();
  });

  it("terminates a real root process and its descendant", async () => {
    const root = spawn(
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
    expect(await isRunning(root.pid)).toBe(true);
    expect(await isRunning(childPid)).toBe(true);

    await killProcessTree(root.pid);
    spawnedRoots.delete(root.pid);

    await expect.poll(() => isRunning(root.pid!), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => isRunning(childPid), { timeout: 5_000 }).toBe(false);
  }, 60_000);
});
