import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Dirent } from "fs";

vi.mock("fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock("os", () => ({
  homedir: vi.fn(),
}));

import { listSkills } from "../skills.js";
import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";

function makeDirent(name: string, isDir: boolean): Dirent {
  return { name, isDirectory: () => isDir } as unknown as Dirent;
}

function makeSkillMd(description: string): string {
  return `---\nname: test\ndescription: "${description}"\n---\n\n# Content`;
}

describe("listSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue("/home/test");
    // Default: no SKILL.md found
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("returns skill info from subdirectories of ~/.claude/skills/", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("commit", true),
      makeDirent("review-pr", true),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(makeSkillMd("Create a commit"))
      .mockReturnValueOnce(makeSkillMd("Review a pull request"));

    expect(listSkills()).toEqual([
      { name: "commit", description: "Create a commit" },
      { name: "review-pr", description: "Review a pull request" },
    ]);
  });

  it("returns empty description when SKILL.md is missing", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("no-skill-md", true),
    ] as unknown as ReturnType<typeof readdirSync>);
    // readFileSync already throws by default in beforeEach

    expect(listSkills()).toEqual([{ name: "no-skill-md", description: "" }]);
  });

  it("ignores files (non-directories)", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("commit", true),
      makeDirent("README.md", false),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(makeSkillMd("Create a commit"));

    expect(listSkills()).toEqual([{ name: "commit", description: "Create a commit" }]);
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

  it("handles skills with unquoted descriptions", () => {
    vi.mocked(readdirSync).mockReturnValue([
      makeDirent("tdd", true),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      `---\nname: tdd\ndescription: Write tests first\n---\n\n# TDD`,
    );

    expect(listSkills()).toEqual([{ name: "tdd", description: "Write tests first" }]);
  });
});
