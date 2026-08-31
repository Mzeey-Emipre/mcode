import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { JobObject } from "../job-object.js";
import { WindowsProcessScopeFactory } from "../windows-process-scope.js";

describe.runIf(process.platform === "win32")("WindowsProcessScope integration", () => {
  it("terminates one nested process tree without affecting another", async () => {
    const globalJob = new JobObject(hostRuntime);
    const factory = new WindowsProcessScopeFactory(hostRuntime);
    const scopeA = factory.create();
    const scopeB = factory.create();
    const processA = spawnTree();
    const processB = spawnTree();

    try {
      expect(globalJob.assign(processA.pid!)).toBe(true);
      expect(scopeA.assign(processA.pid!).ok).toBe(true);
      expect((await scopeA.reconcile(processA.pid!)).ok).toBe(true);
      expect(globalJob.assign(processB.pid!)).toBe(true);
      expect(scopeB.assign(processB.pid!).ok).toBe(true);
      expect((await scopeB.reconcile(processB.pid!)).ok).toBe(true);

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

  it("reconciles and terminates a descendant created before root assignment", async () => {
    const globalJob = new JobObject(hostRuntime);
    const scope = new WindowsProcessScopeFactory(hostRuntime).create();
    const root = NodeChildProcess.spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p=Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden -PassThru; Write-Output $p.Id; Start-Sleep -Seconds 30",
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    const childPid = await readFirstPid(root);

    try {
      expect(globalJob.assign(root.pid!)).toBe(true);
      expect(scope.assign(root.pid!).ok).toBe(true);
      expect((await scope.reconcile(root.pid!)).ok).toBe(true);
      expect(scope.queryProcessIds().processIds).toEqual(
        expect.arrayContaining([root.pid!, childPid]),
      );

      expect(scope.terminate(1).ok).toBe(true);
      await expect(scope.waitForEmpty(1_900)).resolves.toEqual({ ok: true });
      expect(await hasExited(root, 100)).toBe(true);
      expect(processIsAlive(childPid)).toBe(false);
    } finally {
      scope.close();
      globalJob.close();
      root.kill();
      try { process.kill(childPid); } catch { /* already gone */ }
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

async function readFirstPid(process: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("child PID output timed out")), 3_000);
    process.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/\d+/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[0]));
    });
    process.once("error", reject);
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
