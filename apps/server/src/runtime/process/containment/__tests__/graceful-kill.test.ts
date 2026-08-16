import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { gracefulKillProcessTree } from "../process-kill.js";
import type { GracefulKillDeps } from "../process-kill.js";

/**
 * Creates a controllable sleep: each call returns a promise that resolves
 * only when the returned `tick()` function is called. This replaces fake
 * timers and works with bun's vitest compatibility layer.
 */
function makeControllableSleep() {
  const resolvers: Array<() => void> = [];
  const sleep = (_ms: number): Promise<void> =>
    new Promise<void>((resolve) => resolvers.push(resolve));
  const tick = () => resolvers.shift()?.();
  return { sleep, tick };
}

describe("gracefulKillProcessTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Unix path", () => {
    it("sends SIGHUP first, then SIGTERM after 2s if alive, then SIGKILL after another 2s", async () => {
      const processKill = vi.fn();
      const { sleep, tick } = makeControllableSleep();
      const deps: GracefulKillDeps = { processKill, sleep, platform: "linux" };

      const promise = gracefulKillProcessTree(1234, deps);

      // SIGHUP should be sent immediately (to process group -pid)
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGHUP");

      // Advance past first sleep → liveness probe → SIGTERM
      tick(); // first 2s sleep resolves
      await Promise.resolve(); // let the promise chain advance
      await Promise.resolve();

      expect(processKill).toHaveBeenCalledWith(1234, 0); // liveness probe
      expect(processKill).toHaveBeenCalledWith(-1234, "SIGTERM");

      // Advance past second sleep → liveness probe → SIGKILL
      tick(); // second 2s sleep resolves
      await Promise.resolve();
      await Promise.resolve();

      expect(processKill).toHaveBeenCalledWith(-1234, "SIGKILL");

      await promise;

      // SIGHUP + probe(0) + SIGTERM + probe(0) + SIGKILL = 5 calls
      expect(processKill).toHaveBeenCalledTimes(5);
    });

    it("short-circuits after SIGHUP if process exits (liveness probe throws ESRCH)", async () => {
      const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      let callCount = 0;
      const processKill = vi.fn((_pid: number, signal: string | number) => {
        callCount++;
        // Second call is the liveness probe (signal 0) — process gone
        if (signal === 0) throw esrch;
      });

      const { sleep, tick } = makeControllableSleep();
      const deps: GracefulKillDeps = { processKill, sleep, platform: "linux" };

      const promise = gracefulKillProcessTree(1234, deps);

      expect(processKill).toHaveBeenCalledWith(-1234, "SIGHUP");

      tick(); // first sleep resolves → probe runs → throws ESRCH → return
      await promise;

      // SIGHUP + probe(0) — then short-circuit
      expect(processKill).toHaveBeenCalledWith(1234, 0);
      expect(processKill).not.toHaveBeenCalledWith(-1234, "SIGTERM");
      expect(processKill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
      expect(callCount).toBe(2);
    });

    it("short-circuits after SIGTERM if process exits (second liveness probe throws ESRCH)", async () => {
      const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      let termSent = false;
      const processKill = vi.fn((_pid: number, signal: string | number) => {
        if (signal === "SIGTERM") termSent = true;
        // Second liveness probe (after SIGTERM) → ESRCH
        if (signal === 0 && termSent) throw esrch;
      });

      const { sleep, tick } = makeControllableSleep();
      const deps: GracefulKillDeps = { processKill, sleep, platform: "linux" };

      const promise = gracefulKillProcessTree(1234, deps);

      tick(); // first sleep → first probe (alive) → SIGTERM sent
      await Promise.resolve();
      await Promise.resolve();

      expect(processKill).toHaveBeenCalledWith(-1234, "SIGTERM");

      tick(); // second sleep → second probe → throws ESRCH → return
      await promise;

      // SIGKILL should NOT be sent
      expect(processKill).not.toHaveBeenCalledWith(-1234, "SIGKILL");
    });

    it("resolves without throwing even if processKill always throws", async () => {
      const processKill = vi.fn(() => {
        throw new Error("unexpected error");
      });

      const { sleep } = makeControllableSleep();
      const deps: GracefulKillDeps = { processKill, sleep, platform: "linux" };

      // processKill throws on SIGHUP — function should catch and return
      await expect(gracefulKillProcessTree(1234, deps)).resolves.toBeUndefined();
    });

    it("guards against pid <= 0 - resolves without calling processKill", async () => {
      const processKill = vi.fn();
      const { sleep } = makeControllableSleep();
      const deps: GracefulKillDeps = { processKill, sleep, platform: "linux" };

      await gracefulKillProcessTree(0, deps);

      expect(processKill).not.toHaveBeenCalled();
    });
  });

  describe("Windows path", () => {
    it("sends taskkill without /F first, then with /F after 2s if alive", async () => {
      // First call throws (process still alive), second call resolves
      const execFile = vi
        .fn()
        .mockRejectedValueOnce(new Error("still alive"))
        .mockResolvedValueOnce({ stdout: "", stderr: "" });

      const { sleep, tick } = makeControllableSleep();
      const deps: GracefulKillDeps = { execFile, sleep, platform: "win32" };

      const promise = gracefulKillProcessTree(1234, deps);
      await Promise.resolve(); // let first taskkill attempt settle

      expect(execFile).toHaveBeenCalledWith(
        "taskkill",
        ["/T", "/PID", "1234"],
        expect.any(Object),
      );

      tick(); // 2s sleep resolves → second taskkill with /F
      await Promise.resolve();
      await Promise.resolve();
      await promise;

      expect(execFile).toHaveBeenCalledWith(
        "taskkill",
        ["/T", "/F", "/PID", "1234"],
        expect.any(Object),
      );
      expect(execFile).toHaveBeenCalledTimes(2);
    });

    it("short-circuits if first taskkill succeeds (exits 0)", async () => {
      const execFile = vi
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" });

      const { sleep } = makeControllableSleep();
      const deps: GracefulKillDeps = { execFile, sleep, platform: "win32" };

      await gracefulKillProcessTree(1234, deps);

      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile).not.toHaveBeenCalledWith(
        "taskkill",
        expect.arrayContaining(["/F"]),
        expect.any(Object),
      );
    });
  });
});
