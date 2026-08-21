import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupOwnedRun,
  findPackagedDesktop,
  isOwnedServerLock,
  resolveOwnedDesktopSpawnOptions,
  runPackagedReliabilityScenario,
} from "../desktop-packaging/package-validation/desktop-reliability-test.mjs";

function lock(pid, startedAt = `2026-01-01T00:00:0${pid}.000Z`) {
  return {
    port: 19700,
    authToken: "a".repeat(64),
    pid,
    startedAt,
    version: "test",
  };
}

function operations(overrides = {}) {
  return {
    readLock: vi.fn(),
    readAuthSecret: vi.fn(() => "a".repeat(64)),
    fetch: vi.fn(async () => ({ ok: true })),
    killPidTree: vi.fn(async () => undefined),
    killProcessTree: vi.fn(async () => undefined),
    waitForProcessExit: vi.fn(async () => undefined),
    removeRunRoot: vi.fn(),
    pathExists: vi.fn(() => false),
    platform: "linux",
    ...overrides,
  };
}

describe("packaged reliability cleanup", () => {
  it("reports the exact missing-artifact failure on direct CLI invocation", async () => {
    if (findPackagedDesktop()) return;
    await expect(runPackagedReliabilityScenario()).rejects.toThrow(
      "Packaged Desktop executable not found. Run the target package task first.",
    );

    const scriptPath = fileURLToPath(new URL("../desktop-packaging/package-validation/desktop-reliability-test.mjs", import.meta.url));
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const result = await runCli("bun", [scriptPath], repoRoot);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Packaged Desktop executable not found. Run the target package task first.");
  });

  it("kills the owned POSIX server group, Desktop tree, and run directory", async () => {
    const serverLock = lock(901);
    const ops = operations({
      readLock: vi.fn()
        .mockReturnValueOnce(serverLock)
        .mockReturnValueOnce(serverLock)
        .mockReturnValueOnce(null),
    });

    await cleanupOwnedRun({ pid: 902 }, "C:/run/data", "C:/run", {
      expectedServerAuthToken: serverLock.authToken,
      ...ops,
    });

    expect(ops.killPidTree).toHaveBeenCalledWith(901, "SIGTERM", {
      graceMs: 500,
      useProcessGroup: true,
    });
    expect(ops.killProcessTree).toHaveBeenCalledWith({ pid: 902 }, { graceMs: 500, useProcessGroup: true });
    expect(ops.removeRunRoot).toHaveBeenCalledWith("C:/run");
  });

  it("continues Desktop and directory cleanup when server termination fails", async () => {
    const ops = operations({
      readLock: vi.fn().mockReturnValue(lock(903)),
      killPidTree: vi.fn(async () => { throw new Error("server kill failed"); }),
    });

    await expect(
      cleanupOwnedRun({ pid: 904 }, "C:/run/data", "C:/run", {
        expectedServerAuthToken: "a".repeat(64),
        ...ops,
      }),
    ).rejects.toThrow("Reliability harness cleanup failed");

    expect(ops.killProcessTree).toHaveBeenCalledWith({ pid: 904 }, { graceMs: 500, useProcessGroup: true });
    expect(ops.removeRunRoot).toHaveBeenCalledWith("C:/run");
  });

  it("accepts only a lock carrying the authenticated isolated-run identity", () => {
    expect(isOwnedServerLock(lock(905), "a".repeat(64))).toBe(true);
    expect(isOwnedServerLock(lock(905), "b".repeat(64))).toBe(false);
  });

  it("follows a replaced owned lock instead of orphaning the recovered server", async () => {
    const original = lock(906);
    const recovered = lock(907, "2026-01-01T00:00:07.000Z");
    const ops = operations({
      readLock: vi.fn()
        .mockReturnValueOnce(original)
        .mockReturnValueOnce(recovered)
        .mockReturnValueOnce(recovered)
        .mockReturnValueOnce(null),
    });

    await cleanupOwnedRun({ pid: 908 }, "C:/run/data", "C:/run", {
      expectedServerAuthToken: original.authToken,
      ...ops,
    });

    expect(ops.killPidTree).toHaveBeenCalledWith(907, "SIGTERM", {
      graceMs: 500,
      useProcessGroup: true,
    });
    expect(ops.killPidTree).not.toHaveBeenCalledWith(906, "SIGTERM", expect.anything());
  });

  it("detaches Desktop only on POSIX so its process group is owned", () => {
    expect(resolveOwnedDesktopSpawnOptions("linux")).toEqual({ detached: true });
    expect(resolveOwnedDesktopSpawnOptions("win32")).toEqual({ detached: false });
  });
});

function runCli(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, output }));
  });
}
