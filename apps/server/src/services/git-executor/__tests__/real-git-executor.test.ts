import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { RealGitExecutor } from "../real-git-executor.js";

describe("RealGitExecutor", () => {
  let executor: RealGitExecutor;

  beforeEach(() => {
    execFileMock.mockReset();
    executor = new RealGitExecutor();
  });

  it("serialises concurrent calls for the same cwd", async () => {
    const order: number[] = [];
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const id = order.length + 1;
      setTimeout(() => {
        order.push(id);
        cb(null, { stdout: `out-${id}`, stderr: "" });
      }, 10);
    });

    const [first, second] = await Promise.all([
      executor.exec(["-C", "/repo", "status", "--porcelain"]),
      executor.exec(["-C", "/repo", "rev-parse", "HEAD"]),
    ]);

    expect(order).toEqual([1, 2]);
    expect(first.stdout).toBe("out-1");
    expect(second.stdout).toBe("out-2");
  });

  it("caches rev-parse --git-dir only inside the queue", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, { stdout: "/repo/.git\n", stderr: "" });
    });

    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);
    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates rev-parse cache after mutating commands", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const argv = args as string[];
      if (argv.includes("--git-dir")) {
        cb(null, { stdout: "/repo/.git\n", stderr: "" });
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });

    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);
    await executor.exec(["-C", "/repo", "add", "-A"]);
    await executor.exec(["-C", "/repo", "rev-parse", "--git-dir"]);

    expect(execFileMock).toHaveBeenCalledTimes(3);
  });
});
