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
} from "../process-kill.js";
import { logger } from "@mcode/shared";

function stableThenGone(stableReads = 2): (pid: number) => Promise<string | null> {
  let reads = 0;
  return async (pid) => ++reads <= stableReads ? `start-${pid}` : null;
}

const ROOT_SNAPSHOT = [
  { pid: 1234, parentPid: 1, startMarker: "root", name: "pwsh.exe" },
] as const;

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
        getWindowsProcessSnapshot: vi.fn().mockResolvedValue(ROOT_SNAPSHOT),
        isProcessAlive: () => false,
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
      mockExecFile.mockRejectedValue(new Error("process not found"));

      await expect(killProcessTree(1234, {
        platform: "win32",
        execFile: mockExecFile,
        getWindowsProcessSnapshot: vi.fn().mockResolvedValue(ROOT_SNAPSHOT),
        isProcessAlive: () => false,
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

  it("batches default Unix verification markers once per poll", async () => {
    let batchRead = 0;
    mockExecFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === "pgrep" && args.includes("5678")) {
        return { stdout: "6789\n", stderr: "" };
      }
      if (command === "pgrep") {
        throw Object.assign(new Error("no matches"), { code: 1 });
      }
      if (command === "ps" && args.includes("pid=,lstart=")) {
        batchRead += 1;
        return batchRead === 1
          ? { stdout: "5678 Mon Jan  1 00:00:00 2024\n6789 replacement\n", stderr: "" }
          : { stdout: "", stderr: "" };
      }
      return { stdout: "Mon Jan  1 00:00:00 2024\n", stderr: "" };
    });
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await killProcessTree(5678, {
      platform: "linux",
      execFile: mockExecFile,
    });

    const batchCalls = mockExecFile.mock.calls.filter(
      ([command, args]) => command === "ps" && args.includes("pid=,lstart="),
    );
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0]?.[1]).toContain("5678,6789");
    expect(batchCalls[1]?.[1]).toContain("5678");
    expect(batchCalls[1]?.[1]).not.toContain("6789");
    processKill.mockRestore();
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
    const snapshot = vi.fn()
      .mockResolvedValueOnce(ROOT_SNAPSHOT)
      .mockResolvedValueOnce([
        { pid: 1234, parentPid: 1, startMarker: "replacement", name: "other.exe" },
      ]);

    await killProcessTree(1234, {
      platform: "win32",
      processKill: vi.fn(),
      execFile: mockExecFile,
      getWindowsProcessSnapshot: snapshot,
      isProcessAlive: () => false,
    });

    expect(mockExecFile).not.toHaveBeenCalledWith(
      "taskkill",
      expect.arrayContaining(["1234"]),
      expect.any(Object),
    );
  });

  it("captures a multi-process Windows tree with one snapshot", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce([
        { pid: 1234, parentPid: 1, startMarker: "root", name: "pwsh.exe" },
        { pid: 2345, parentPid: 1234, startMarker: "child", name: "node.exe" },
        { pid: 3456, parentPid: 2345, startMarker: "grandchild", name: "cmd.exe" },
      ])
      .mockResolvedValueOnce([
        { pid: 1234, parentPid: 1, startMarker: "root", name: "pwsh.exe" },
        { pid: 2345, parentPid: 1234, startMarker: "child", name: "node.exe" },
        { pid: 3456, parentPid: 2345, startMarker: "grandchild", name: "cmd.exe" },
      ]);
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

    await killProcessTree(1234, {
      platform: "win32",
      execFile: mockExecFile,
      getWindowsProcessSnapshot: snapshot,
      isProcessAlive: () => false,
    });

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.any(Object),
    );
  });

  it("verifies multiple already-gone Windows identities without marker CIM commands", async () => {
    const snapshot = vi.fn().mockResolvedValue([
      { pid: 1234, parentPid: 1, startMarker: "root", name: "pwsh.exe" },
      { pid: 2345, parentPid: 1234, startMarker: "child", name: "node.exe" },
    ]);
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

    await killProcessTree(1234, {
      platform: "win32",
      execFile: mockExecFile,
      getWindowsProcessSnapshot: snapshot,
      isProcessAlive: () => false,
    });

    expect(
      mockExecFile.mock.calls.filter(([command]) => command === "powershell.exe"),
    ).toEqual([]);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("classifies Windows survivors and reused PIDs with one post-kill snapshot", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce([
        { pid: 1234, parentPid: 1, startMarker: "root", name: "pwsh.exe" },
        { pid: 2345, parentPid: 1234, startMarker: "child", name: "node.exe" },
        { pid: 3456, parentPid: 1234, startMarker: "old", name: "cmd.exe" },
      ])
      .mockResolvedValueOnce([
        { pid: 1234, parentPid: 1, startMarker: "root", name: "pwsh.exe" },
        { pid: 2345, parentPid: 1234, startMarker: "child", name: "node.exe" },
        { pid: 3456, parentPid: 1234, startMarker: "old", name: "cmd.exe" },
      ])
      .mockResolvedValueOnce([
        { pid: 2345, parentPid: 1, startMarker: "child", name: "node.exe" },
        { pid: 3456, parentPid: 1, startMarker: "replacement", name: "other.exe" },
      ]);
    const apparentlyAlive = new Set<number>();
    mockExecFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === "taskkill" && args.includes("/T")) {
        apparentlyAlive.add(2345);
        apparentlyAlive.add(3456);
      }
      if (command === "taskkill" && args.includes("/F") && !args.includes("/T")) {
        apparentlyAlive.delete(Number(args.at(-1)));
      }
      return { stdout: "", stderr: "" };
    });

    await killProcessTree(1234, {
      platform: "win32",
      execFile: mockExecFile,
      getWindowsProcessSnapshot: snapshot,
      isProcessAlive: (pid) => apparentlyAlive.has(pid),
    });

    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/PID", "2345"],
      expect.any(Object),
    );
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/PID", "3456"],
      expect.any(Object),
    );
  });

  it("treats a missing Windows process after taskkill as successful termination", async () => {
    const snapshot = vi.fn().mockResolvedValue([
      { pid: 1234, parentPid: 1, startMarker: "root", name: "pwsh.exe" },
    ]);
    mockExecFile.mockRejectedValue(
      Object.assign(new Error("not found"), { code: 128 }),
    );

    await expect(killProcessTree(1234, {
      platform: "win32",
      execFile: mockExecFile,
      getWindowsProcessSnapshot: snapshot,
      isProcessAlive: () => false,
    })).resolves.toBeUndefined();
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
      getWindowsProcessSnapshot: vi.fn().mockResolvedValue(ROOT_SNAPSHOT),
      isProcessAlive: () => false,
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(mockExecFile.mock.calls.some(([command]) => command === "wmic")).toBe(false);
  });

  it("rejects before taskkill when CIM enumeration is unavailable", async () => {
    mockExecFile.mockRejectedValue(new Error("powershell unavailable"));

    await expect(
      killProcessTree(1234, {
        platform: "win32",
        processKill: vi.fn(),
        execFile: mockExecFile,
      }),
    ).rejects.toThrow("powershell unavailable");

    expect(mockExecFile).not.toHaveBeenCalledWith(
      "taskkill",
      expect.any(Array),
      expect.any(Object),
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
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
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
          stdout: JSON.stringify({
            Name: "claude.exe",
            ProcessId: 5555,
            ParentProcessId: 1234,
            CreationDate: "start-5555",
          }),
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            Name: "claude.exe",
            ProcessId: 5555,
            ParentProcessId: 1234,
            CreationDate: "start-5555",
          }),
          stderr: "",
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "" });

      await killDescendantsByName(1234, "claude.exe");

      expect(mockExecFile).toHaveBeenCalledWith(
        "taskkill",
        ["/T", "/F", "/PID", "5555"],
        expect.any(Object),
      );
    } finally {
      killSpy.mockRestore();
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
