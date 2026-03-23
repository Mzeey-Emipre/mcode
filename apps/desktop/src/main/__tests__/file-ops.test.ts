import { describe, it, expect, vi, beforeEach } from "vitest";
import { listWorkspaceFiles, readFileContent, resolveWorkingDir } from "../file-ops.js";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { execFileSync } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";

describe("listWorkspaceFiles", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns git-tracked files as array of relative paths", () => {
    vi.mocked(execFileSync).mockReturnValue(
      Buffer.from("src/index.ts\nsrc/app.ts\npackage.json\n")
    );
    const result = listWorkspaceFiles("/workspace");
    expect(result).toEqual(["src/index.ts", "src/app.ts", "package.json"]);
    expect(execFileSync).toHaveBeenCalledWith(
      "git", ["ls-files"], { cwd: "/workspace", maxBuffer: 10 * 1024 * 1024 }
    );
  });

  it("filters empty lines", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("a.ts\n\nb.ts\n"));
    expect(listWorkspaceFiles("/workspace")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("readFileContent", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reads file content from workspace root", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ size: 100 } as any);
    vi.mocked(readFileSync).mockReturnValue("file content");
    const result = readFileContent("/workspace", "src/index.ts");
    expect(result).toBe("file content");
  });

  it("rejects files exceeding size limit", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ size: 300 * 1024 } as any);
    expect(() => readFileContent("/workspace", "src/big.ts")).toThrow("File too large");
  });

  it("rejects paths with ..", () => {
    expect(() => readFileContent("/workspace", "../etc/passwd")).toThrow("Invalid file path");
  });

  it("rejects absolute paths", () => {
    expect(() => readFileContent("/workspace", "/etc/passwd")).toThrow("Invalid file path");
  });

  it("rejects paths that resolve to sibling directories", () => {
    // /workspace-evil passes startsWith("/workspace") without the sep fix
    expect(() => readFileContent("/workspace", "../../workspace-evil/secret")).toThrow();
  });

  it("throws when file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => readFileContent("/workspace", "src/missing.ts")).toThrow("File not found");
  });

  it("wraps git ls-files errors with domain message", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("git not found");
    });
    expect(() => listWorkspaceFiles("/workspace")).toThrow("Failed to list files");
  });
});

describe("resolveWorkingDir", () => {
  it("returns worktree path for worktree threads", () => {
    const thread = { mode: "worktree", worktree_path: "/wt/path" };
    const workspace = { path: "/ws/path" };
    expect(resolveWorkingDir(workspace as any, thread as any)).toBe("/wt/path");
  });

  it("returns workspace path for direct threads", () => {
    const thread = { mode: "direct", worktree_path: null };
    const workspace = { path: "/ws/path" };
    expect(resolveWorkingDir(workspace as any, thread as any)).toBe("/ws/path");
  });

  it("returns workspace path when no thread provided", () => {
    const workspace = { path: "/ws/path" };
    expect(resolveWorkingDir(workspace as any, null)).toBe("/ws/path");
  });
});
