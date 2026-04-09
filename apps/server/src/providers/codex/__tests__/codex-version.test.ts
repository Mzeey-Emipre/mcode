import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "child_process";
import { meetsMinVersion, checkCodexVersion, clearVersionCache } from "../codex-version.js";

const mockSpawnSync = vi.mocked(spawnSync);

describe("meetsMinVersion", () => {
  it("returns true when version meets minimum", () => {
    expect(meetsMinVersion("0.37.0", "0.37.0")).toBe(true);
  });

  it("returns false when version is below minimum", () => {
    expect(meetsMinVersion("0.36.9", "0.37.0")).toBe(false);
  });

  it("returns true when major version is higher", () => {
    expect(meetsMinVersion("1.0.0", "0.37.0")).toBe(true);
  });

  it("returns true for much higher minor version", () => {
    expect(meetsMinVersion("0.118.0", "0.37.0")).toBe(true);
  });

  it("returns true for patch increment", () => {
    expect(meetsMinVersion("0.37.1", "0.37.0")).toBe(true);
  });

  it("returns false for malformed version string", () => {
    expect(meetsMinVersion("abc", "0.37.0")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(meetsMinVersion("", "0.37.0")).toBe(false);
  });
});

describe("checkCodexVersion error messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVersionCache();
  });

  it("default path error contains 'CLI not found'", () => {
    mockSpawnSync.mockReturnValue({
      error: new Error("ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("codex");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("CLI not found");
  });

  it("custom path error contains 'not found at'", () => {
    mockSpawnSync.mockReturnValue({
      error: new Error("ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("/custom/path/codex");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('not found at "/custom/path/codex"');
  });

  it("timeout error contains 'timed out'", () => {
    const timeoutError = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    mockSpawnSync.mockReturnValue({
      error: timeoutError,
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("codex");

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error.toLowerCase()).toContain("timed out");
  });

  it("returns ok:true and version when CLI succeeds", () => {
    mockSpawnSync.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "codex 0.118.0 (build xyz)",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    });

    const result = checkCodexVersion("codex");

    expect(result.ok).toBe(true);
    expect((result as { ok: true; version: string }).version).toBe("0.118.0");
  });

  it("rejects cliPath with shell metacharacters without calling spawnSync", () => {
    mockSpawnSync.mockClear();

    const dangerous = ["codex; rm -rf /", "`$(rm -rf /)`", "codex'--bad", "path with spaces/codex"];
    for (const cliPath of dangerous) {
      const result = checkCodexVersion(cliPath);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain("invalid characters");
    }
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns error when CLI exits with non-zero status", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 123,
      status: 1,
      signal: null,
      output: [null, "", ""],
      stdout: "",
      stderr: "unknown error",
      error: undefined,
    });
    const result = checkCodexVersion("codex");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("CLI not found");
  });
});
