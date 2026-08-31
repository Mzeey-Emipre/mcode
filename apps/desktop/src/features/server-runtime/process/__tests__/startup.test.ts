import { describe, expect, it, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  acquireStartupLock,
  createStartupLockDependencies,
  releaseStartupLock,
  type StartupLockDependencies,
} from "../startup.js";

describe("acquireStartupLock", () => {
  it("reclaims a timed-out startup lock before it starts a server", async () => {
    let now = 0;
    const abandonedOwner = { pid: 1234, token: "abandoned" };
    const acquiredOwner = { pid: 5678, token: "replacement" };
    const dependencies: StartupLockDependencies = {
      createLock: vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(acquiredOwner),
      releaseLock: vi.fn(),
      readLockOwner: vi.fn().mockReturnValue(abandonedOwner),
      isOwnerAlive: vi.fn().mockReturnValue(false),
      findExistingServer: vi.fn().mockResolvedValue(null),
      wait: vi.fn(async () => {
        now = 10_000;
      }),
      now: () => now,
    };

    await expect(acquireStartupLock(dependencies)).resolves.toEqual({
      kind: "acquired",
      owner: acquiredOwner,
    });

    expect(dependencies.findExistingServer).toHaveBeenCalledOnce();
    expect(dependencies.isOwnerAlive).toHaveBeenCalledWith(abandonedOwner.pid);
    expect(dependencies.releaseLock).toHaveBeenCalledWith(abandonedOwner);
    expect(dependencies.createLock).toHaveBeenCalledTimes(2);
  });

  it("does not let a late owner release a sentinel reacquired by another owner", async () => {
    const tempDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-startup-lock-"));
    const sentinelPath = NodePath.join(tempDirectory, "server.starting");
    const dependencies = createStartupLockDependencies(
      sentinelPath,
      async () => null,
    );

    try {
      const first = await acquireStartupLock(dependencies);
      expect(first.kind).toBe("acquired");
      if (first.kind !== "acquired") return;

      releaseStartupLock(sentinelPath, first.owner);
      const second = await acquireStartupLock(dependencies);
      expect(second.kind).toBe("acquired");
      if (second.kind !== "acquired") return;

      releaseStartupLock(sentinelPath, first.owner);

      expect(NodeFS.existsSync(sentinelPath)).toBe(true);
      releaseStartupLock(sentinelPath, second.owner);
    } finally {
      NodeFS.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("does not reclaim a startup sentinel whose owner remains alive", async () => {
    let now = 0;
    const owner = { pid: 1234, token: "live-owner" };
    const dependencies: StartupLockDependencies = {
      createLock: vi.fn().mockReturnValue(null),
      releaseLock: vi.fn(),
      readLockOwner: vi.fn().mockReturnValue(owner),
      isOwnerAlive: vi.fn().mockReturnValue(true),
      findExistingServer: vi.fn().mockResolvedValue(null),
      wait: vi.fn(async () => {
        now = 10_000;
      }),
      now: () => now,
    };

    await expect(acquireStartupLock(dependencies)).rejects.toThrow(
      "still running",
    );

    expect(dependencies.releaseLock).not.toHaveBeenCalled();
  });
});
