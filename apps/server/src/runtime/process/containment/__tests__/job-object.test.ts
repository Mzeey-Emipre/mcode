import { describe, it, expect } from "vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { JobObject } from "../job-object.js";

describe("JobObject", () => {
  describe("on non-Windows platforms", () => {
    it("constructs without throwing and is a no-op", () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        const job = new JobObject({ ...hostRuntime, platform: "linux" });
        expect(() => job.assign(12345)).not.toThrow();
        expect(() => job.close()).not.toThrow();
        expect(job.isWindowsJob).toBe(false);
      } finally {
        Object.defineProperty(process, "platform", { value: original });
      }
    });
  });
});

describe.runIf(process.platform === "win32")("JobObject (Windows)", () => {
  it("kills assigned children when the job closes", async () => {
    const job = new JobObject(hostRuntime);
    expect(job.isWindowsJob).toBe(true);

    // Spawn a long-running child (ping localhost loops for ~30s)
    const child = NodeChildProcess.spawn("ping", ["-n", "30", "127.0.0.1"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.pid).toBeGreaterThan(0);

    job.assign(child.pid!);

    // Closing the job should terminate the assigned child within ~1s.
    job.close();
    const exitedWithin = await Promise.race([
      new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
      delay(2000).then(() => false),
    ]);

    try {
      expect(exitedWithin).toBe(true);
    } finally {
      child.kill();
    }
  }, 10_000);

  it("assign() is idempotent and tolerant of dead PIDs", () => {
    const job = new JobObject(hostRuntime);
    expect(() => job.assign(999_999_999)).not.toThrow();
    job.close();
  });

  it("setDescription does not throw on a live process", async () => {
    const job = new JobObject(hostRuntime);
    const child = NodeChildProcess.spawn("ping", ["-n", "10", "127.0.0.1"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      expect(() => job.setDescription(child.pid!, "Mcode Test Process")).not.toThrow();
    } finally {
      child.kill();
      job.close();
    }
  });

  it("setDescription is a no-op for dead PIDs", () => {
    const job = new JobObject(hostRuntime);
    expect(() => job.setDescription(999_999_999, "Ghost")).not.toThrow();
    job.close();
  });
});
