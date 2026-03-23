import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("which", () => ({
  default: { sync: vi.fn() },
}));

vi.mock("os", () => ({
  homedir: vi.fn(),
}));

import { discoverConfig, spawnEnv } from "../config.js";
import { existsSync } from "fs";
import which from "which";
import { homedir } from "os";

describe("discoverConfig", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.MCODE_CLAUDE_PATH;
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue("/home/test");
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.MCODE_CLAUDE_PATH;
    } else {
      process.env.MCODE_CLAUDE_PATH = savedEnv;
    }
  });

  it("returns all true when config exists everywhere", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(which.sync).mockReturnValue("/usr/bin/claude");
    const config = discoverConfig("/workspace");
    expect(config.has_user_config).toBe(true);
    expect(config.has_project_config).toBe(true);
    expect(config.has_user_claude_md).toBe(true);
    expect(config.has_project_claude_md).toBe(true);
    expect(config.cli_available).toBe(true);
  });

  it("returns all false for bare workspace", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(which.sync).mockImplementation(() => {
      throw new Error("not found");
    });
    const config = discoverConfig("/bare");
    expect(config.has_user_config).toBe(false);
    expect(config.has_project_config).toBe(false);
    expect(config.has_user_claude_md).toBe(false);
    expect(config.has_project_claude_md).toBe(false);
    expect(config.cli_available).toBe(false);
  });

  it("detects CLAUDE.md at workspace root", () => {
    vi.mocked(existsSync).mockImplementation((path: string | unknown) => {
      return String(path).endsWith("CLAUDE.md") && !String(path).includes(".claude");
    });
    vi.mocked(which.sync).mockImplementation(() => {
      throw new Error("not found");
    });
    const config = discoverConfig("/workspace");
    expect(config.has_project_claude_md).toBe(true);
  });

  it("respects MCODE_CLAUDE_PATH env override", () => {
    process.env.MCODE_CLAUDE_PATH = "/custom/claude";
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(which.sync).mockReturnValue("/custom/claude");
    const config = discoverConfig("/workspace");
    expect(config.cli_path).toBe("/custom/claude");
  });
});

describe("spawnEnv", () => {
  it("includes HOME from os.homedir()", () => {
    vi.mocked(homedir).mockReturnValue("/home/tester");
    const env = spawnEnv();
    expect(env.HOME).toBe("/home/tester");
  });

  it("omits HOME when homedir() returns empty string", () => {
    vi.mocked(homedir).mockReturnValue("");
    const env = spawnEnv();
    expect(env.HOME).toBeUndefined();
  });
});
