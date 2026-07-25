import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return { ...actual, promisify: () => mockExecFile };
});

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import {
  killProcessTree,
  findDescendantsByName,
  killDescendantsByName,
  listDirectChildren,
} from "../services/process-kill";
import { logger } from "@mcode/shared";

function stableThenGone(stableReads = 2): (pid: number) => Promise<string | null> {
  let reads = 0;
  return async (pid) => ++reads <= stableReads ? `start-${pid}` : null;
}

describe("killProcessTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockReset();
  });

  it("calls taskkill with /T /F on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

      await killProcessTree(1234, {
        platform: "win32",
        execFile: mockExecFile,
        getProcessStartMarker: stableThenGone(),
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        "taskkill",
        ["/T", "/F", "/PID", "1234"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("rejects when taskkill fails unexpectedly", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockRejectedValueOnce(new Error("process not found"));

      await expect(killProcessTree(1234, {
        platform: "win32",
        execFile: mockExecFile,
        getProcessStartMarker: stableThenGone(),
      })).rejects.toThrow("process not found");
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ pid: 1234 }),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("sends SIGKILL to process group on Unix", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      mockExecFile.mockRejectedValue(
        Object.assign(new Error("no matches"), { code: 1 }),
      );
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid > 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      });

      await killProcessTree(5678, {
        platform: "linux",
        processKill: killSpy,
        execFile: mockExecFile,
        getProcessStartMarker: stableThenGone(),
      });

      expect(killSpy).toHaveBeenCalledWith(-5678, "SIGKILL");
      killSpy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does not throw when Unix kill fails (process already exited)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      mockExecFile.mockRejectedValue(
        Object.assign(new Error("no matches"), { code: 1 }),
      );
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });

      await expect(killProcessTree(5678, {
        platform: "linux",
        processKill: killSpy,
        execFile: mockExecFile,
        getProcessStartMarker: stableThenGone(),
      })).resolves.toBeUndefined();
      // ESRCH means process already gone - expected; logged at debug, not warn.
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ pid: 5678 }),
      );
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
      killSpy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("polls captured identities until every process is absent", async () => {
    let now = 0;
    let markerReads = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const processKill = vi.fn((targetPid: number) => {
      if (targetPid < 0) return;
      return;
    });
    mockExecFile.mockRejectedValue(
      Object.assign(new Error("no matches"), { code: 1 }),
    );

    await killProcessTree(5678, {
      platform: "linux",
      processKill,
      sleep,
      now: () => now,
      execFile: mockExecFile,
      getProcessStartMarker: async () => {
        markerReads += 1;
        return markerReads < 6 ? "start-5678" : null;
      },
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(processKill).toHaveBeenCalledWith(-5678, "SIGKILL");
  });

  it("explicitly kills an escaped descendant deepest-first after the root group signal", async () => {
    mockExecFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("5678")) return { stdout: "6789\n", stderr: "" };
      if (args.includes("6789")) return { stdout: "7890\n", stderr: "" };
      throw Object.assign(new Error("no matches"), { code: 1 });
    });
    const alive = new Set([5678, 6789, 7890]);
    const calls: Array<[number, string | number]> = [];
    const processKill = vi.fn((targetPid: number, signal: string | number) => {
      calls.push([targetPid, signal]);
      if (targetPid === -5678) {
        alive.delete(5678);
        return;
      }
      if (signal === "SIGKILL") {
        alive.delete(targetPid);
        return;
      }
      if (!alive.has(targetPid)) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });

    await killProcessTree(5678, {
      platform: "linux",
      processKill,
      execFile: mockExecFile,
      getProcessStartMarker: async (pid) => alive.has(pid) ? `start-${pid}` : null,
    });

    expect(calls).toContainEqual([-5678, "SIGKILL"]);
    expect(calls).toContainEqual([6789, "SIGKILL"]);
    expect(calls).toContainEqual([7890, "SIGKILL"]);
    expect(calls.findIndex(([pid, signal]) => pid === 7890 && signal === "SIGKILL")).toBeLessThan(
      calls.findIndex(([pid, signal]) => pid === 6789 && signal === "SIGKILL"),
    );
  });

  it("never signals a captured PID after its start marker changes", async () => {
    mockExecFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("5678")) return { stdout: "6789\n", stderr: "" };
      throw Object.assign(new Error("no matches"), { code: 1 });
    });
    const markerReads = new Map<number, number>();
    const processKill = vi.fn((targetPid: number, signal: string | number) => {
      if (targetPid === -5678) return;
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });

    await killProcessTree(5678, {
      platform: "linux",
      processKill,
      execFile: mockExecFile,
      getProcessStartMarker: async (pid) => {
        const read = (markerReads.get(pid) ?? 0) + 1;
        markerReads.set(pid, read);
        if (pid === 5678 && read > 1) return null;
        return pid === 6789 && read > 1 ? "replacement" : `start-${pid}`;
      },
    });

    expect(processKill).not.toHaveBeenCalledWith(6789, "SIGKILL");
  });

  it("does not signal a Unix root group after the captured root is replaced", async () => {
    mockExecFile.mockRejectedValue(
      Object.assign(new Error("no matches"), { code: 1 }),
    );
    let markerRead = 0;
    const processKill = vi.fn();

    await killProcessTree(5678, {
      platform: "linux",
      processKill,
      execFile: mockExecFile,
      getProcessStartMarker: async () => ++markerRead === 1 ? "original" : "replacement",
    });

    expect(processKill).not.toHaveBeenCalledWith(-5678, "SIGKILL");
    expect(processKill).not.toHaveBeenCalledWith(5678, "SIGKILL");
  });

  it("does not taskkill a Windows root after the captured root is replaced", async () => {
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
    let markerRead = 0;

    await killProcessTree(1234, {
      platform: "win32",
      processKill: vi.fn(),
      execFile: mockExecFile,
      getProcessStartMarker: async () => ++markerRead === 1 ? "original" : "replacement",
    });

    expect(mockExecFile).not.toHaveBeenCalledWith(
      "taskkill",
      expect.arrayContaining(["1234"]),
      expect.any(Object),
    );
  });

  it("rejects when a captured process remains after the verification timeout", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    mockExecFile.mockRejectedValue(
      Object.assign(new Error("no matches"), { code: 1 }),
    );

    await expect(
      killProcessTree(5678, {
        platform: "linux",
        processKill: vi.fn(),
        sleep,
        now: () => now,
        execFile: mockExecFile,
      }),
    ).rejects.toThrow("termination verification timed out");

    expect(sleep).toHaveBeenCalledTimes(40);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "killProcessTree: termination verification timed out",
      expect.objectContaining({ pid: 5678, remainingPids: [5678] }),
    );
  });

  it("kills and verifies on Windows without invoking wmic", async () => {
    const processKill = vi.fn(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

    await killProcessTree(1234, {
      platform: "win32",
      processKill,
      execFile: mockExecFile,
      getProcessStartMarker: stableThenGone(),
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(mockExecFile.mock.calls.some(([command]) => command === "wmic")).toBe(false);
  });

  it("runs taskkill then rejects honestly when CIM enumeration is unavailable", async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error("powershell unavailable"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      killProcessTree(1234, {
        platform: "win32",
        processKill: vi.fn(),
        getProcessStartMarker: stableThenGone(),
        execFile: mockExecFile,
      }),
    ).rejects.toThrow("descendant verification was unavailable");

    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.any(Object),
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "killProcessTree: descendant verification unavailable",
      expect.objectContaining({ pid: 1234, capturedProcessCount: 1 }),
    );
  });

  it("does nothing when pid is 0 on Unix", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      await killProcessTree(0);

      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

describe("findDescendantsByName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockReset();
  });

  it("returns matching PIDs from PowerShell CIM output on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            { Name: "claude.exe", ProcessId: 5555 },
            { Name: "node.exe", ProcessId: 6666 },
          ]),
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ Name: "claude.exe", ProcessId: 7777 }),
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
        });

      const pids = await findDescendantsByName(1234, "claude.exe");

      expect(pids).toContain(5555);
      expect(pids).toContain(7777);
      expect(pids).not.toContain(6666);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns empty array when no descendants match", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile.mockResolvedValue({
        stdout: "",
        stderr: "",
      });

      const pids = await findDescendantsByName(1234, "claude.exe");

      expect(pids).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns empty array when PowerShell CIM fails", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile.mockRejectedValue(new Error("powershell unavailable"));

      const pids = await findDescendantsByName(1234, "claude.exe");

      expect(pids).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

describe("listDirectChildren", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockReset();
  });

  it("treats pgrep exit code 1 as an idle process with no children", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      mockExecFile.mockRejectedValue(Object.assign(new Error("no matches"), { code: 1 }));

      await expect(listDirectChildren(1234)).resolves.toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

describe("killDescendantsByName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockReset();
  });

  it("finds and kills matching descendants on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      // First call: findDescendantsByName queries children
      mockExecFile
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ Name: "claude.exe", ProcessId: 5555 }),
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "start-5555",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "start-5555",
          stderr: "",
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" });

      await killDescendantsByName(1234, "claude.exe");

      expect(mockExecFile).toHaveBeenCalledWith(
        "taskkill",
        ["/T", "/F", "/PID", "5555"],
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does nothing when no descendants match", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile.mockResolvedValue({
        stdout: "",
        stderr: "",
      });

      await killDescendantsByName(1234, "claude.exe");

      // Only PowerShell CIM enumeration runs when no descendants match.
      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).not.toBe("taskkill");
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
