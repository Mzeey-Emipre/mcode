import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { JobObject } from "./job-object.js";
import { WindowsProcessScopeFactory } from "./windows-process-scope.js";

describe.runIf(process.platform === "win32")("WindowsProcessScope integration", () => {
  it("terminates one nested process tree without affecting another", async () => {
    const globalJob = new JobObject();
    const factory = new WindowsProcessScopeFactory();
    const scopeA = factory.create();
    const scopeB = factory.create();
    const processA = spawnTree();
    const processB = spawnTree();

    try {
      expect(globalJob.assign(processA.pid!)).toBe(true);
      expect(scopeA.assign(processA.pid!).ok).toBe(true);
      expect(globalJob.assign(processB.pid!)).toBe(true);
      expect(scopeB.assign(processB.pid!).ok).toBe(true);

      await waitForMembership(scopeA, 2);
      await waitForMembership(scopeB, 2);
      expect(scopeA.terminate(1).ok).toBe(true);
      await expect(scopeA.waitForEmpty(1_900)).resolves.toEqual({ ok: true });
      expect(await hasExited(processA, 100)).toBe(true);
      expect(await hasExited(processB, 100)).toBe(false);
    } finally {
      scopeA.close();
      scopeB.terminate(1);
      await scopeB.waitForEmpty(1_900);
      scopeB.close();
      globalJob.close();
      processA.kill();
      processB.kill();
    }
  }, 15_000);
});

function spawnTree(): ChildProcess {
  return spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 30",
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

async function waitForMembership(
  scope: ReturnType<WindowsProcessScopeFactory["create"]>,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const snapshot = scope.queryProcessIds();
    if (snapshot.ok && snapshot.processIds.length >= expected) return;
    await delay(20);
  }
  expect(scope.queryProcessIds().processIds.length).toBeGreaterThanOrEqual(expected);
}

async function hasExited(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => process.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}
