import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Dirent } from "fs";

vi.mock("fs", () => ({
  readdirSync: vi.fn(),
}));
vi.mock("os", () => ({
  homedir: vi.fn(),
}));

import { listSkills } from "../skills.js";
import { readdirSync } from "fs";
import { homedir } from "os";

function makeDirent(name: string, isDir: boolean): Dirent {
  return { name, isDirectory: () => isDir } as unknown as Dirent;
}

describe("listSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue("/home/test");
  });

  it("returns skill names from subdirectories of ~/.claude/skills/", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("commit", true),
      makeDirent("review-pr", true),
      makeDirent("tdd", true),
    ] as unknown as ReturnType<typeof readdirSync>);

    expect(listSkills()).toEqual(["commit", "review-pr", "tdd"]);
  });

  it("ignores files (non-directories)", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("commit", true),
      makeDirent("README.md", false),
    ] as unknown as ReturnType<typeof readdirSync>);

    expect(listSkills()).toEqual(["commit"]);
  });

  it("returns [] when ~/.claude/skills/ does not exist", () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(listSkills()).toEqual([]);
  });

  it("returns [] when ~/.claude/skills/ exists but is empty", () => {
    vi.mocked(readdirSync).mockReturnValue([]);
    expect(listSkills()).toEqual([]);
  });
});
