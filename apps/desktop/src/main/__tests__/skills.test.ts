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
import { join } from "path";

const HOME = "/home/test";
const CLAUDE_DIR = join(HOME, ".claude");

/** Normalize path to forward slashes for cross-platform mock matching. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function makeDirent(name: string, isDir: boolean): Dirent {
  return { name, isDirectory: () => isDir } as unknown as Dirent;
}

function makeSkillMd(description: string): string {
  return `---\nname: test\ndescription: "${description}"\n---\n\n# Content`;
}

/**
 * Helper: configure readdirSync to return specific entries for specific paths.
 * Paths not in the map throw ENOENT (simulating non-existent directories).
 * All keys are normalized to forward slashes for cross-platform matching.
 */
function mockDirs(mapping: Record<string, Dirent[]>): void {
  // Normalize keys up front so callers can use mixed-slash paths
  const normalized = new Map<string, Dirent[]>();
  for (const [k, v] of Object.entries(mapping)) normalized.set(norm(k), v);

  vi.mocked(readdirSync).mockImplementation(((dir: string) => {
    const entries = normalized.get(norm(dir));
    if (entries) return entries;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as typeof readdirSync);
}

/**
 * Helper: configure readFileSync to return SKILL.md content based on path.
 * All keys are normalized to forward slashes for cross-platform matching.
 */
function mockSkillFiles(mapping: Record<string, string>): void {
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(mapping)) normalized.set(norm(k), v);

  vi.mocked(readFileSync).mockImplementation(((filePath: string) => {
    const content = normalized.get(norm(filePath));
    if (content !== undefined) return content;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as typeof readFileSync);
}

describe("listSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue(HOME);
    // Default: all directories missing, all files missing
    vi.mocked(readdirSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  // ── Local skills (~/.claude/skills/) ──────────────────────────────

  it("returns skill info from local ~/.claude/skills/", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [
        makeDirent("commit", true),
        makeDirent("review-pr", true),
      ],
    });
    mockSkillFiles({
      [`${CLAUDE_DIR}/skills/commit/SKILL.md`]: makeSkillMd("Create a commit"),
      [`${CLAUDE_DIR}/skills/review-pr/SKILL.md`]: makeSkillMd("Review a pull request"),
    });

    expect(listSkills()).toEqual([
      { name: "commit", description: "Create a commit" },
      { name: "review-pr", description: "Review a pull request" },
    ]);
  });

  it("returns empty description when SKILL.md is missing", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [makeDirent("no-skill-md", true)],
    });

    expect(listSkills()).toEqual([{ name: "no-skill-md", description: "" }]);
  });

  it("ignores files (non-directories)", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [
        makeDirent("commit", true),
        makeDirent("README.md", false),
      ],
    });
    mockSkillFiles({
      [`${CLAUDE_DIR}/skills/commit/SKILL.md`]: makeSkillMd("Create a commit"),
    });

    expect(listSkills()).toEqual([{ name: "commit", description: "Create a commit" }]);
  });

  it("returns [] when no directories exist", () => {
    expect(listSkills()).toEqual([]);
  });

  it("returns [] when ~/.claude/skills/ is empty", () => {
    mockDirs({ [`${CLAUDE_DIR}/skills`]: [] });
    expect(listSkills()).toEqual([]);
  });

  it("handles skills with unquoted descriptions", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [makeDirent("tdd", true)],
    });
    mockSkillFiles({
      [`${CLAUDE_DIR}/skills/tdd/SKILL.md`]: `---\nname: tdd\ndescription: Write tests first\n---\n\n# TDD`,
    });

    expect(listSkills()).toEqual([{ name: "tdd", description: "Write tests first" }]);
  });

  // ── Project-level skills (<cwd>/.claude/skills/) ──────────────────

  it("discovers project-level skills when cwd is provided", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [],
      ["/workspace/.claude/skills"]: [makeDirent("lint", true)],
    });
    mockSkillFiles({
      ["/workspace/.claude/skills/lint/SKILL.md"]: makeSkillMd("Run linter"),
    });

    expect(listSkills("/workspace")).toEqual([
      { name: "lint", description: "Run linter" },
    ]);
  });

  it("skips project skills when cwd is not provided", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [],
    });

    // No project skills should appear
    expect(listSkills()).toEqual([]);
  });

  // ── Agent skills (~/.claude/.agents/skills/) ──────────────────────

  it("discovers agent skills from ~/.claude/.agents/skills/", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [],
      [`${CLAUDE_DIR}/.agents/skills`]: [makeDirent("deep-research", true)],
    });
    mockSkillFiles({
      [`${CLAUDE_DIR}/.agents/skills/deep-research/SKILL.md`]: makeSkillMd("Deep research"),
    });

    expect(listSkills()).toEqual([
      { name: "deep-research", description: "Deep research" },
    ]);
  });

  // ── Plugin cache (~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills/) ─

  it("discovers plugin cache skills with namespace prefix", () => {
    const cacheBase = `${CLAUDE_DIR}/plugins/cache`;
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [],
      [`${CLAUDE_DIR}/.agents/skills`]: [],
      [cacheBase]: [makeDirent("superpowers-marketplace", true)],
      [`${cacheBase}/superpowers-marketplace`]: [makeDirent("superpowers", true)],
      [`${cacheBase}/superpowers-marketplace/superpowers`]: [
        makeDirent("5.0.1", true),
      ],
      [`${cacheBase}/superpowers-marketplace/superpowers/5.0.1/skills`]: [
        makeDirent("project-manager", true),
      ],
    });
    mockSkillFiles({
      [`${cacheBase}/superpowers-marketplace/superpowers/5.0.1/skills/project-manager/SKILL.md`]:
        makeSkillMd("Manage projects"),
    });

    expect(listSkills()).toEqual([
      { name: "superpowers:project-manager", description: "Manage projects" },
    ]);
  });

  it("takes the latest version from plugin cache (lexicographic sort)", () => {
    const cacheBase = `${CLAUDE_DIR}/plugins/cache`;
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [],
      [`${CLAUDE_DIR}/.agents/skills`]: [],
      [cacheBase]: [makeDirent("official", true)],
      [`${cacheBase}/official`]: [makeDirent("myplugin", true)],
      [`${cacheBase}/official/myplugin`]: [
        makeDirent("1.0.0", true),
        makeDirent("2.0.0", true),
      ],
      // Only define skills for 2.0.0 — if 1.0.0 were picked, test would get wrong result
      [`${cacheBase}/official/myplugin/2.0.0/skills`]: [
        makeDirent("deploy", true),
      ],
    });
    mockSkillFiles({
      [`${cacheBase}/official/myplugin/2.0.0/skills/deploy/SKILL.md`]:
        makeSkillMd("Deploy app"),
    });

    expect(listSkills()).toEqual([
      { name: "myplugin:deploy", description: "Deploy app" },
    ]);
  });

  // ── Plugin marketplaces (~/.claude/plugins/marketplaces/<mkt>/<plugin>/skills/) ─

  it("discovers plugin marketplace skills with namespace prefix", () => {
    const mktBase = `${CLAUDE_DIR}/plugins/marketplaces`;
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [],
      [`${CLAUDE_DIR}/.agents/skills`]: [],
      [`${CLAUDE_DIR}/plugins/cache`]: [],
      [mktBase]: [makeDirent("official", true)],
      [`${mktBase}/official`]: [makeDirent("hookify", true)],
      [`${mktBase}/official/hookify/skills`]: [makeDirent("auto-hook", true)],
    });
    mockSkillFiles({
      [`${mktBase}/official/hookify/skills/auto-hook/SKILL.md`]:
        makeSkillMd("Auto-generate hooks"),
    });

    expect(listSkills()).toEqual([
      { name: "hookify:auto-hook", description: "Auto-generate hooks" },
    ]);
  });

  // ── Priority / deduplication ──────────────────────────────────────

  it("local skills take priority over agent skills with the same name", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [makeDirent("deep-research", true)],
      [`${CLAUDE_DIR}/.agents/skills`]: [makeDirent("deep-research", true)],
    });
    mockSkillFiles({
      [`${CLAUDE_DIR}/skills/deep-research/SKILL.md`]: makeSkillMd("Local version"),
      [`${CLAUDE_DIR}/.agents/skills/deep-research/SKILL.md`]: makeSkillMd("Agent version"),
    });

    const skills = listSkills();
    expect(skills).toEqual([
      { name: "deep-research", description: "Local version" },
    ]);
  });

  it("project skills take priority over agent skills", () => {
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [],
      ["/workspace/.claude/skills"]: [makeDirent("lint", true)],
      [`${CLAUDE_DIR}/.agents/skills`]: [makeDirent("lint", true)],
    });
    mockSkillFiles({
      ["/workspace/.claude/skills/lint/SKILL.md"]: makeSkillMd("Project lint"),
      [`${CLAUDE_DIR}/.agents/skills/lint/SKILL.md`]: makeSkillMd("Agent lint"),
    });

    const skills = listSkills("/workspace");
    expect(skills).toEqual([
      { name: "lint", description: "Project lint" },
    ]);
  });

  it("plugin skills don't collide with local skills (different namespace)", () => {
    const cacheBase = `${CLAUDE_DIR}/plugins/cache`;
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [makeDirent("commit", true)],
      [`${CLAUDE_DIR}/.agents/skills`]: [],
      [cacheBase]: [makeDirent("official", true)],
      [`${cacheBase}/official`]: [makeDirent("myplugin", true)],
      [`${cacheBase}/official/myplugin`]: [makeDirent("1.0.0", true)],
      [`${cacheBase}/official/myplugin/1.0.0/skills`]: [
        makeDirent("commit", true),
      ],
    });
    mockSkillFiles({
      [`${CLAUDE_DIR}/skills/commit/SKILL.md`]: makeSkillMd("Local commit"),
      [`${cacheBase}/official/myplugin/1.0.0/skills/commit/SKILL.md`]:
        makeSkillMd("Plugin commit"),
    });

    const skills = listSkills();
    expect(skills).toHaveLength(2);
    expect(skills).toContainEqual({ name: "commit", description: "Local commit" });
    expect(skills).toContainEqual({ name: "myplugin:commit", description: "Plugin commit" });
  });

  // ── Multi-source aggregation ──────────────────────────────────────

  it("aggregates skills from all sources", () => {
    const cacheBase = `${CLAUDE_DIR}/plugins/cache`;
    const mktBase = `${CLAUDE_DIR}/plugins/marketplaces`;
    mockDirs({
      [`${CLAUDE_DIR}/skills`]: [makeDirent("commit", true)],
      ["/workspace/.claude/skills"]: [makeDirent("lint", true)],
      [`${CLAUDE_DIR}/.agents/skills`]: [makeDirent("deep-research", true)],
      [cacheBase]: [makeDirent("official", true)],
      [`${cacheBase}/official`]: [makeDirent("sp", true)],
      [`${cacheBase}/official/sp`]: [makeDirent("1.0.0", true)],
      [`${cacheBase}/official/sp/1.0.0/skills`]: [makeDirent("pm", true)],
      [mktBase]: [makeDirent("official", true)],
      [`${mktBase}/official`]: [makeDirent("hookify", true)],
      [`${mktBase}/official/hookify/skills`]: [makeDirent("auto-hook", true)],
    });
    mockSkillFiles({
      [`${CLAUDE_DIR}/skills/commit/SKILL.md`]: makeSkillMd("Commit"),
      ["/workspace/.claude/skills/lint/SKILL.md"]: makeSkillMd("Lint"),
      [`${CLAUDE_DIR}/.agents/skills/deep-research/SKILL.md`]: makeSkillMd("Research"),
      [`${cacheBase}/official/sp/1.0.0/skills/pm/SKILL.md`]: makeSkillMd("PM"),
      [`${mktBase}/official/hookify/skills/auto-hook/SKILL.md`]: makeSkillMd("Hooks"),
    });

    const skills = listSkills("/workspace");
    expect(skills).toHaveLength(5);
    expect(skills.map((s) => s.name)).toEqual([
      "commit",
      "lint",
      "deep-research",
      "sp:pm",
      "hookify:auto-hook",
    ]);
  });
});
