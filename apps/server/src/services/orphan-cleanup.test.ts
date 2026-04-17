import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { killOrphanedServer, type OrphanCleanupDeps } from "./orphan-cleanup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<OrphanCleanupDeps> = {}): OrphanCleanupDeps {
  return {
    lockFilePath: "/nonexistent/server.lock",
    logger: { warn: vi.fn(), debug: vi.fn() },
    processKill: vi.fn(),
    execSync: vi.fn(),
    // Default: process name is "node" so kill proceeds unless overridden.
    getProcessName: vi.fn().mockReturnValue("node"),
    currentPid: 12345,
    platform: "linux",
    ...overrides,
  };
}

function writeTempLock(dir: string, content: object): string {
  const path = join(dir, "server.lock");
  writeFileSync(path, JSON.stringify(content), { encoding: "utf-8" });
  return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("killOrphanedServer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `orphan-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { unlinkSync(join(tmpDir, "server.lock")); } catch { /* ok */ }
  });

  it("does nothing when lock file does not exist", () => {
    const deps = makeDeps({ lockFilePath: join(tmpDir, "server.lock") });
    killOrphanedServer(deps);
    expect(deps.processKill).not.toHaveBeenCalled();
    expect(deps.execSync).not.toHaveBeenCalled();
  });

  it("does nothing when lock file has no pid", () => {
    const lockFilePath = writeTempLock(tmpDir, { port: 19400 });
    const deps = makeDeps({ lockFilePath });
    killOrphanedServer(deps);
    expect(deps.processKill).not.toHaveBeenCalled();
  });

  it("rejects string PID to prevent command injection", () => {
    const lockFilePath = writeTempLock(tmpDir, { pid: "1234; whoami", port: 19400 });
    const deps = makeDeps({ lockFilePath });
    killOrphanedServer(deps);
    expect(deps.processKill).not.toHaveBeenCalled();
  });

  it("does nothing when lock file pid matches current process", () => {
    const lockFilePath = writeTempLock(tmpDir, { pid: 12345 });
    const deps = makeDeps({ lockFilePath, currentPid: 12345 });
    killOrphanedServer(deps);
    // processKill should never be called — no liveness probe, no kill
    expect(deps.processKill).not.toHaveBeenCalled();
  });

  it("does nothing when the old process is already dead", () => {
    const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
    // Signal-0 probe throws, simulating a dead process
    const processKill = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const deps = makeDeps({ lockFilePath, currentPid: 12345, processKill });
    killOrphanedServer(deps);
    // Only the liveness probe (signal 0) should have been attempted
    expect(processKill).toHaveBeenCalledTimes(1);
    expect(processKill).toHaveBeenCalledWith(99999, 0);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("kills process group on Unix when old process is alive", () => {
    const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
    const processKill = vi.fn().mockImplementation((_pid: number, signal: number | string) => {
      // Signal 0 probe succeeds (process is alive), kill calls also succeed
      if (signal !== 0) return;
    });
    const deps = makeDeps({ lockFilePath, currentPid: 12345, platform: "linux", processKill });
    killOrphanedServer(deps);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Found orphaned server process, killing",
      { pid: 99999 },
    );
    // Should kill process group (negative PID) with SIGTERM
    expect(processKill).toHaveBeenCalledWith(-99999, "SIGTERM");
  });

  it("falls back to killing the process directly on Unix when group kill fails", () => {
    const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
    const processKill = vi.fn().mockImplementation((pid: number, signal: number | string) => {
      if (signal === 0) return; // probe: alive
      if (pid === -99999) throw new Error("EPERM"); // group kill fails
      // direct kill succeeds
    });
    const deps = makeDeps({ lockFilePath, currentPid: 12345, platform: "linux", processKill });
    killOrphanedServer(deps);
    expect(processKill).toHaveBeenCalledWith(-99999, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(99999, "SIGTERM");
  });

  it("uses taskkill on Windows when old process is alive", () => {
    const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
    const processKill = vi.fn(); // signal-0 probe succeeds (no throw)
    const execSync = vi.fn();
    const deps = makeDeps({
      lockFilePath,
      currentPid: 12345,
      platform: "win32",
      processKill,
      execSync,
    });
    killOrphanedServer(deps);
    expect(execSync).toHaveBeenCalledWith("taskkill /T /F /PID 99999", { stdio: "ignore", timeout: 5000 });
  });

  it("logs a warning but does not throw when lock file contains invalid JSON", () => {
    const lockFilePath = join(tmpDir, "server.lock");
    writeFileSync(lockFilePath, "not-json", "utf-8");
    const deps = makeDeps({ lockFilePath, currentPid: 12345 });
    expect(() => killOrphanedServer(deps)).not.toThrow();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Failed to clean up orphaned server",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  describe("process image name verification", () => {
    it("skips kill when getProcessName returns an unrelated process name", () => {
      const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
      const processKill = vi.fn(); // signal-0 probe succeeds (no throw)
      const getProcessName = vi.fn().mockReturnValue("chrome.exe");
      const deps = makeDeps({ lockFilePath, currentPid: 12345, processKill, getProcessName });
      killOrphanedServer(deps);
      // Should warn but NOT kill
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "Orphaned lock PID does not belong to a known server process; skipping kill",
        expect.objectContaining({ pid: 99999, name: "chrome.exe" }),
      );
      expect(processKill).toHaveBeenCalledTimes(1); // only signal-0 probe
      expect(processKill).not.toHaveBeenCalledWith(-99999, "SIGTERM");
    });

    it("proceeds with kill when getProcessName returns 'node'", () => {
      const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
      const processKill = vi.fn();
      const getProcessName = vi.fn().mockReturnValue("node");
      const deps = makeDeps({ lockFilePath, currentPid: 12345, platform: "linux", processKill, getProcessName });
      killOrphanedServer(deps);
      expect(processKill).toHaveBeenCalledWith(-99999, "SIGTERM");
    });

    it("proceeds with kill when getProcessName returns 'bun.exe'", () => {
      const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
      const processKill = vi.fn();
      const execSync = vi.fn();
      const getProcessName = vi.fn().mockReturnValue("bun.exe");
      const deps = makeDeps({ lockFilePath, currentPid: 12345, platform: "win32", processKill, execSync, getProcessName });
      killOrphanedServer(deps);
      expect(execSync).toHaveBeenCalledWith("taskkill /T /F /PID 99999", { stdio: "ignore", timeout: 5000 });
    });

    it("proceeds with kill when getProcessName returns null (name cannot be determined)", () => {
      const lockFilePath = writeTempLock(tmpDir, { pid: 99999 });
      const processKill = vi.fn();
      const getProcessName = vi.fn().mockReturnValue(null);
      const deps = makeDeps({ lockFilePath, currentPid: 12345, platform: "linux", processKill, getProcessName });
      killOrphanedServer(deps);
      // Should still kill because we can't verify, and fail-open is safer
      // for zombie prevention than fail-closed.
      expect(processKill).toHaveBeenCalledWith(-99999, "SIGTERM");
    });
  });

  it("kills a real child process and verifies it is dead afterward", async () => {
    // Spawn a real long-lived process so we can safely kill it
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const childPid = child.pid!;

    const lockFilePath = writeTempLock(tmpDir, { pid: childPid });

    // Use actual process.kill (no mock) to exercise the real kill path
    const deps: OrphanCleanupDeps = {
      lockFilePath,
      logger: { warn: vi.fn(), debug: vi.fn() },
      currentPid: process.pid,
      platform: process.platform,
    };

    killOrphanedServer(deps);

    // Wait a moment for the OS to clean up
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the child is dead: signal 0 should now throw
    let dead = false;
    try {
      process.kill(childPid, 0);
    } catch {
      dead = true;
    }
    expect(dead).toBe(true);
  });
});
