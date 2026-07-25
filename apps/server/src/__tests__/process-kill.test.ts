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

      await killProcessTree(1234);

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
        .mockResolvedValueOnce({ stdout: "Name,ProcessId\r\n", stderr: "" })
        .mockRejectedValueOnce(new Error("process not found"));

      await expect(killProcessTree(1234)).rejects.toThrow("process not found");
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

      await killProcessTree(5678);

      expect(killSpy).toHaveBeenCalledWith(-5678, "SIGKILL");
      expect(mockExecFile).toHaveBeenCalledWith(
        "pgrep",
        ["-P", "5678"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
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

      await expect(killProcessTree(5678)).resolves.toBeUndefined();
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
    let probes = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const processKill = vi.fn((targetPid: number) => {
      if (targetPid < 0) return;
      probes += 1;
      if (probes < 3) return;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
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
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(processKill).toHaveBeenCalledWith(-5678, "SIGKILL");
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

  it("returns matching PIDs from wmic output on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      // wmic outputs CSV-like lines: first call for direct children, recursive
      mockExecFile
        .mockResolvedValueOnce({
          stdout: "Name,ProcessId\r\nclaude.exe,5555\r\nnode.exe,6666\r\n",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "Name,ProcessId\r\n",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "Name,ProcessId\r\nclaude.exe,7777\r\n",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "Name,ProcessId\r\n",
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
        stdout: "Name,ProcessId\r\n",
        stderr: "",
      });

      const pids = await findDescendantsByName(1234, "claude.exe");

      expect(pids).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns empty array when wmic fails", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile.mockRejectedValue(new Error("wmic not found"));

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
          stdout: "Name,ProcessId\r\nclaude.exe,5555\r\n",
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: "Name,ProcessId\r\n",
          stderr: "",
        })
        // Second call: taskkill for the found PID
        .mockResolvedValueOnce({ stdout: "", stderr: "" });

      await killDescendantsByName(1234, "claude.exe");

      // Last call should be taskkill
      const lastCall = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe("taskkill");
      expect(lastCall?.[1]).toEqual(["/T", "/F", "/PID", "5555"]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does nothing when no descendants match", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile.mockResolvedValue({
        stdout: "Name,ProcessId\r\n",
        stderr: "",
      });

      await killDescendantsByName(1234, "claude.exe");

      // Only the wmic query calls, no taskkill
      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).not.toBe("taskkill");
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
