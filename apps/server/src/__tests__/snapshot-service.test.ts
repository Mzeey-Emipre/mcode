import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockExecFile, mockUnlink } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockUnlink: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

vi.mock("node:fs/promises", () => ({
  unlink: mockUnlink,
}));

import { SnapshotService } from "../services/snapshot-service";

describe("SnapshotService.captureRef", () => {
  let service: SnapshotService;
  const cwd = "/repo";
  const treeSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const gitDir = "/repo/.git";

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnlink.mockResolvedValue(undefined);
    service = new SnapshotService();
  });

  it("returns the tree SHA from write-tree after read-tree + add -A", async () => {
    // 1. rev-parse --git-dir
    mockExecFile.mockResolvedValueOnce({ stdout: `${gitDir}\n`, stderr: "" });
    // 2. read-tree HEAD
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // 3. add -A
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // 4. write-tree
    mockExecFile.mockResolvedValueOnce({ stdout: `${treeSha}\n`, stderr: "" });

    const result = await service.captureRef(cwd);

    expect(result).toBe(treeSha);
    expect(mockExecFile).toHaveBeenCalledTimes(4);

    // Verify command sequence
    expect(mockExecFile.mock.calls[0][1]).toEqual(["-C", cwd, "rev-parse", "--git-dir"]);
    expect(mockExecFile.mock.calls[1][1]).toEqual(["-C", cwd, "read-tree", "HEAD"]);
    expect(mockExecFile.mock.calls[2][1]).toEqual(["-C", cwd, "add", "-A"]);
    expect(mockExecFile.mock.calls[3][1]).toEqual(["-C", cwd, "write-tree"]);

    // Verify all index-touching commands use GIT_INDEX_FILE
    for (const callIdx of [1, 2, 3]) {
      expect(mockExecFile.mock.calls[callIdx][2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({ GIT_INDEX_FILE: expect.stringContaining(`${gitDir}/mcode-index-`) }),
        }),
      );
    }

    // No commit-tree call
    const commitTreeCall = mockExecFile.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("commit-tree"),
    );
    expect(commitTreeCall).toBeUndefined();
  });

  it("unborn repo: skips read-tree failure and proceeds with empty index", async () => {
    // 1. rev-parse --git-dir
    mockExecFile.mockResolvedValueOnce({ stdout: `${gitDir}\n`, stderr: "" });
    // 2. read-tree HEAD fails (unborn repo)
    mockExecFile.mockRejectedValueOnce(new Error("fatal: Not a valid object name HEAD"));
    // 3. add -A (proceeds with empty index)
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // 4. write-tree
    mockExecFile.mockResolvedValueOnce({ stdout: `${treeSha}\n`, stderr: "" });

    const result = await service.captureRef(cwd);

    expect(result).toBe(treeSha);
    expect(mockExecFile).toHaveBeenCalledTimes(4);

    // add -A was still called after read-tree failed
    expect(mockExecFile.mock.calls[2][1]).toEqual(["-C", cwd, "add", "-A"]);
  });

  it("throws when rev-parse --git-dir fails (not a git repo)", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("not a git repo"));

    await expect(service.captureRef(cwd)).rejects.toThrow("not a git repo");
  });

  it("throws when add -A fails (disk full, permissions)", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: `${gitDir}\n`, stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFile.mockRejectedValueOnce(new Error("add failed"));

    await expect(service.captureRef(cwd)).rejects.toThrow("add failed");
  });

  it("throws when write-tree fails", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: `${gitDir}\n`, stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFile.mockRejectedValueOnce(new Error("write-tree failed"));

    await expect(service.captureRef(cwd)).rejects.toThrow("write-tree failed");
  });

  it("resolves relative git-dir path against cwd", async () => {
    // rev-parse --git-dir returns relative ".git"
    mockExecFile.mockResolvedValueOnce({ stdout: ".git\n", stderr: "" });
    // read-tree HEAD
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // add -A
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // write-tree
    mockExecFile.mockResolvedValueOnce({ stdout: `${treeSha}\n`, stderr: "" });

    const result = await service.captureRef(cwd);
    expect(result).toBe(treeSha);

    // Verify temp index path contains both the resolved .git dir and mcode-index- prefix.
    // join() produces backslashes on Windows, so use regex to accept either separator.
    const indexPath = mockExecFile.mock.calls[1][2].env.GIT_INDEX_FILE as string;
    expect(indexPath).toMatch(/\.git/);
    expect(indexPath).toMatch(/mcode-index-/);
  });

  it("cleans up temp index on success", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: `${gitDir}\n`, stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: `${treeSha}\n`, stderr: "" });

    await service.captureRef(cwd);

    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(`${gitDir}/mcode-index-`));
  });

  it("cleans up temp index even when add -A throws", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: `${gitDir}\n`, stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFile.mockRejectedValueOnce(new Error("add -A failed"));

    await expect(service.captureRef(cwd)).rejects.toThrow();

    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(`${gitDir}/mcode-index-`));
  });

  it("cleans up temp index when read-tree fails (unborn repo path)", async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: `${gitDir}\n`, stderr: "" });
    mockExecFile.mockRejectedValueOnce(new Error("not a valid object name HEAD"));
    mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFile.mockResolvedValueOnce({ stdout: `${treeSha}\n`, stderr: "" });

    await service.captureRef(cwd);

    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(`${gitDir}/mcode-index-`));
  });

  it("does not attempt unlink when rev-parse --git-dir fails (no tmpIndex created)", async () => {
    mockExecFile.mockRejectedValueOnce(new Error("not a git repo"));

    await expect(service.captureRef(cwd)).rejects.toThrow();

    expect(mockUnlink).not.toHaveBeenCalled();
  });
});
