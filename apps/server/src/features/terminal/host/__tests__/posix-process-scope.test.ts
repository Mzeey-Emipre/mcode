import { describe, expect, it, vi } from "vitest";
import {
  createPosixProcessScope,
  reapPosixProcessSession,
  type PosixProcessScopeDependencies,
} from "../posix-process-scope.js";

function createDependencies(
  overrides: Partial<PosixProcessScopeDependencies> = {},
): PosixProcessScopeDependencies {
  let monotonicMs = 0;
  return {
    readProcessTable: vi.fn(async () => [
      { pid: 400, processGroupId: 400, sessionId: 400 },
    ]),
    signalProcessGroup: vi.fn(),
    monotonicNow: () => monotonicMs,
    sleep: vi.fn(async (durationMs: number) => {
      monotonicMs += durationMs;
    }),
    ...overrides,
  };
}

describe("POSIX PTY process scope", () => {
  it("fails closed unless the PTY root leads its process group", async () => {
    const dependencies = createDependencies({
      readProcessTable: vi.fn(async () => [
        { pid: 400, processGroupId: 399, sessionId: 400 },
      ]),
    });
    const scope = createPosixProcessScope(400, dependencies);

    await expect(scope.establish()).resolves.toBe(false);
    expect(dependencies.signalProcessGroup).not.toHaveBeenCalled();
  });

  it("polls until the PTY root appears as its session leader", async () => {
    const readProcessTable = vi
      .fn<PosixProcessScopeDependencies["readProcessTable"]>()
      .mockResolvedValueOnce([
        { pid: 400, processGroupId: 399, sessionId: 400 },
      ])
      .mockResolvedValueOnce([
        { pid: 400, processGroupId: 400, sessionId: 400 },
      ]);
    const dependencies = createDependencies({ readProcessTable });
    const scope = createPosixProcessScope(400, dependencies);

    await expect(scope.establish()).resolves.toBe(true);
    expect(dependencies.sleep).toHaveBeenCalledTimes(1);
    expect(dependencies.sleep).toHaveBeenCalledWith(25);
  });

  it("inspects every member of the contained process group", async () => {
    const dependencies = createDependencies({
      readProcessTable: vi.fn(async () => [
        { pid: 400, processGroupId: 400, sessionId: 400 },
        { pid: 401, processGroupId: 401, sessionId: 400 },
        { pid: 402, processGroupId: 402, sessionId: 402 },
      ]),
    });
    const scope = createPosixProcessScope(400, dependencies);

    await expect(scope.establish()).resolves.toBe(true);
    await expect(scope.hasChildren()).resolves.toBe(true);
  });

  it("uses the graceful signal ladder before forcing a process group", async () => {
    const liveProcessGroups = new Set([400, 401]);
    const dependencies = createDependencies({
      signalProcessGroup: vi.fn((processGroupId, signal) => {
        if (signal === "SIGKILL") liveProcessGroups.delete(processGroupId);
      }),
      readProcessTable: vi.fn(async () =>
        [...liveProcessGroups].map((processGroupId) => ({
          pid: processGroupId,
          processGroupId,
          sessionId: 400,
        })),
      ),
    });
    const scope = createPosixProcessScope(400, dependencies);

    await expect(scope.establish()).resolves.toBe(true);
    await expect(scope.close(true)).resolves.toBeUndefined();
    expect(dependencies.signalProcessGroup).toHaveBeenNthCalledWith(
      2,
      401,
      "SIGHUP",
    );
    expect(dependencies.signalProcessGroup).toHaveBeenNthCalledWith(
      3,
      400,
      "SIGHUP",
    );
    expect(dependencies.signalProcessGroup).toHaveBeenNthCalledWith(
      4,
      401,
      "SIGTERM",
    );
    expect(dependencies.signalProcessGroup).toHaveBeenNthCalledWith(
      5,
      400,
      "SIGTERM",
    );
    expect(dependencies.signalProcessGroup).toHaveBeenNthCalledWith(
      6,
      401,
      "SIGKILL",
    );
    expect(dependencies.signalProcessGroup).toHaveBeenNthCalledWith(
      7,
      400,
      "SIGKILL",
    );
  });

  it("force-closes a process group without sending graceful signals", async () => {
    const liveProcessGroups = new Set([400, 401]);
    const dependencies = createDependencies({
      signalProcessGroup: vi.fn((processGroupId, signal) => {
        if (signal === "SIGKILL") liveProcessGroups.delete(processGroupId);
      }),
      readProcessTable: vi.fn(async () =>
        [...liveProcessGroups].map((processGroupId) => ({
          pid: processGroupId,
          processGroupId,
          sessionId: 400,
        })),
      ),
    });
    const scope = createPosixProcessScope(400, dependencies);

    await expect(scope.establish()).resolves.toBe(true);
    await expect(scope.close()).resolves.toBeUndefined();

    expect(dependencies.signalProcessGroup).toHaveBeenCalledWith(401, "SIGKILL");
    expect(dependencies.signalProcessGroup).not.toHaveBeenCalledWith(401, "SIGHUP");
    expect(dependencies.signalProcessGroup).not.toHaveBeenCalledWith(401, "SIGTERM");
  });

  it("does not force a process group that exits after SIGTERM", async () => {
    const liveProcessGroups = new Set([400, 401]);
    const dependencies = createDependencies({
      signalProcessGroup: vi.fn((processGroupId, signal) => {
        if (signal === "SIGTERM") liveProcessGroups.delete(processGroupId);
      }),
      readProcessTable: vi.fn(async () =>
        [...liveProcessGroups].map((processGroupId) => ({
          pid: processGroupId,
          processGroupId,
          sessionId: 400,
        })),
      ),
    });
    const scope = createPosixProcessScope(400, dependencies);

    await expect(scope.establish()).resolves.toBe(true);
    await expect(scope.close(true)).resolves.toBeUndefined();

    expect(dependencies.signalProcessGroup).toHaveBeenCalledWith(401, "SIGTERM");
    expect(dependencies.signalProcessGroup).not.toHaveBeenCalledWith(401, "SIGKILL");
  });

  it("does not dispose process groups that left the session", async () => {
    const readProcessTable = vi
      .fn<PosixProcessScopeDependencies["readProcessTable"]>()
      .mockResolvedValueOnce([
        { pid: 400, processGroupId: 400, sessionId: 400 },
      ])
      .mockResolvedValueOnce([
        { pid: 400, processGroupId: 400, sessionId: 400 },
        { pid: 401, processGroupId: 401, sessionId: 400 },
      ])
      .mockResolvedValueOnce([
        { pid: 400, processGroupId: 400, sessionId: 400 },
      ]);
    const dependencies = createDependencies({ readProcessTable });
    const scope = createPosixProcessScope(400, dependencies);

    await expect(scope.establish()).resolves.toBe(true);
    await expect(scope.hasChildren()).resolves.toBe(true);
    await expect(scope.hasChildren()).resolves.toBe(false);
    scope.dispose();

    expect(dependencies.signalProcessGroup).not.toHaveBeenCalledWith(
      401,
      "SIGKILL",
    );
  });

  it("reaps surviving process groups after the PTY root exits", async () => {
    const liveProcessGroups = new Set([401, 402]);
    const dependencies = createDependencies({
      signalProcessGroup: vi.fn((processGroupId, signal) => {
        if (signal === "SIGKILL") liveProcessGroups.delete(processGroupId);
      }),
      readProcessTable: vi.fn(async () =>
        [...liveProcessGroups].map((processGroupId) => ({
          pid: processGroupId,
          processGroupId,
          sessionId: 400,
        })),
      ),
    });

    await expect(
      reapPosixProcessSession(400, "400", dependencies),
    ).resolves.toBeUndefined();
    expect(dependencies.signalProcessGroup).toHaveBeenCalledWith(
      401,
      "SIGKILL",
    );
    expect(dependencies.signalProcessGroup).toHaveBeenCalledWith(
      402,
      "SIGKILL",
    );
  });

  it("rejects a cleanup record with a mismatched process group", async () => {
    const dependencies = createDependencies();

    await expect(
      reapPosixProcessSession(400, "401", dependencies),
    ).rejects.toThrow("process identity does not match");
    expect(dependencies.readProcessTable).not.toHaveBeenCalled();
  });
});
