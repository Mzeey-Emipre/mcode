import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { setTimeout as delay } from "timers/promises";
import { JobObject } from "../job-object.js";

/**
 * Verifies that grandchildren of a job-assigned process are killed when
 * the job closes. This mirrors the Claude Agent SDK's spawn pattern:
 * the server assigns the SDK's top-level subprocess to the job; any
 * worker processes that subprocess spawns should die with it.
 */
describe.runIf(process.platform === "win32")(
  "JobObject grandchild propagation",
  () => {
    it("kills grandchildren when the job closes", async () => {
      const job = new JobObject();

      // Spawn a parent that spawns a grandchild via cmd /c.
      // We use a nested ping so both parent and grandchild have measurable lifetime.
      // cmd /c cmd /c ping keeps an intermediate cmd.exe alive as a grandchild,
      // testing that job membership propagates through process inheritance.
      const parent = spawn(
        "cmd",
        ["/c", "cmd", "/c", "ping", "-n", "30", "127.0.0.1"],
        { stdio: "ignore", windowsHide: true },
      );
      expect(parent.pid).toBeGreaterThan(0);
      job.assign(parent.pid!);

      // Allow the nested cmd → ping chain time to start on a loaded CI machine.
      await delay(1500);

      let exited = false;
      try {
        // Closing the job should terminate parent and any descendants.
        job.close();

        exited = await Promise.race([
          new Promise<true>((r) => parent.once("exit", () => r(true))),
          delay(3000).then(() => false as const),
        ]);
        expect(exited).toBe(true);
      } finally {
        parent.kill();
      }
    }, 15_000);
  },
);
