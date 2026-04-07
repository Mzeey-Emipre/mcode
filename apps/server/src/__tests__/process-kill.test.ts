import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFile,
}));

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), debug: vi.fn() },
}));

import { killProcessTree } from "../services/process-kill";

describe("killProcessTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls taskkill with /T /F on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

    await killProcessTree(1234);

    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "1234"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("does not throw when taskkill fails (process already exited)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExecFile.mockRejectedValue(new Error("process not found"));

    await expect(killProcessTree(1234)).resolves.toBeUndefined();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("sends SIGKILL to process group on Unix", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await killProcessTree(5678);

    expect(killSpy).toHaveBeenCalledWith(-5678, "SIGKILL");
    killSpy.mockRestore();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("does not throw when Unix kill fails (process already exited)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });

    await expect(killProcessTree(5678)).resolves.toBeUndefined();
    killSpy.mockRestore();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
});
