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
  logger: { warn: vi.fn(), debug: vi.fn() },
}));

import { killProcessTree } from "../services/process-kill";
import { logger } from "@mcode/shared";

describe("killProcessTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("does not throw when taskkill fails (process already exited)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      mockExecFile.mockRejectedValue(new Error("process not found"));

      await expect(killProcessTree(1234)).resolves.toBeUndefined();
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
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await killProcessTree(5678);

      expect(killSpy).toHaveBeenCalledWith(-5678, "SIGKILL");
      expect(mockExecFile).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does not throw when Unix kill fails (process already exited)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    try {
      await expect(killProcessTree(5678)).resolves.toBeUndefined();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ pid: 5678 }),
      );
    } finally {
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does nothing when pid is 0 on Unix", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await killProcessTree(0);

      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does nothing when pid is 0 on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await killProcessTree(0);

      expect(mockExecFile).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does nothing when pid is negative on Unix", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await killProcessTree(-1);

      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
