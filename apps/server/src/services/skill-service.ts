/**
 * Skill scanning service.
 * Discovers skills from user, project, agent, and plugin directories.
 * Extracted from apps/desktop/src/main/skills.ts.
 */

import { injectable } from "tsyringe";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { SkillInfo } from "@mcode/contracts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESC_RE = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;

/** Extract description from a SKILL.md file's frontmatter. */
function readSkillDescription(skillDir: string): string {
  try {
    const content = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    const fm = FRONTMATTER_RE.exec(content);
    if (!fm) return "";
    const desc = DESC_RE.exec(fm[1]);
    if (!desc) return "";
    return (desc[1] ?? desc[2] ?? desc[3] ?? "").trim();
  } catch {
    return "";
  }
}

/** Safely read directory entries with file-type info. Returns [] on any error. */
function safeDirEntries(dir: string): import("fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Scan a flat skills directory where each subdirectory is a skill. */
function scanFlatSkillsDir(
  dir: string,
  prefix: string,
  out: Map<string, SkillInfo>,
): void {
  const entries = safeDirEntries(dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.isDirectory()) continue;
    const displayName = prefix ? `${prefix}:${entry.name}` : entry.name;
    if (out.has(displayName)) continue;
    out.set(displayName, {
      name: displayName,
      description: readSkillDescription(join(dir, entry.name)),
    });
  }
}

/** Scan plugin cache directory (versioned, takes latest version per plugin). */
function scanPluginCacheDir(
  cacheDir: string,
  out: Map<string, SkillInfo>,
): void {
  const marketplaces = safeDirEntries(cacheDir);
  for (let m = 0; m < marketplaces.length; m++) {
    if (!marketplaces[m].isDirectory()) continue;
    const mDir = join(cacheDir, marketplaces[m].name);
    const plugins = safeDirEntries(mDir);
    for (let p = 0; p < plugins.length; p++) {
      if (!plugins[p].isDirectory()) continue;
      const pDir = join(mDir, plugins[p].name);
      const versions: string[] = [];
      const vEntries = safeDirEntries(pDir);
      for (let v = 0; v < vEntries.length; v++) {
        if (vEntries[v].isDirectory()) versions.push(vEntries[v].name);
      }
      if (versions.length === 0) continue;
      versions.sort();
      const skillsDir = join(
        pDir,
        versions[versions.length - 1],
        "skills",
      );
      scanFlatSkillsDir(skillsDir, plugins[p].name, out);
    }
  }
}

/** Scan plugin marketplaces directory (unversioned). */
function scanPluginMarketplaceDir(
  marketplacesDir: string,
  out: Map<string, SkillInfo>,
): void {
  const marketplaces = safeDirEntries(marketplacesDir);
  for (let m = 0; m < marketplaces.length; m++) {
    if (!marketplaces[m].isDirectory()) continue;
    const mDir = join(marketplacesDir, marketplaces[m].name);
    const plugins = safeDirEntries(mDir);
    for (let p = 0; p < plugins.length; p++) {
      if (!plugins[p].isDirectory()) continue;
      const skillsDir = join(mDir, plugins[p].name, "skills");
      scanFlatSkillsDir(skillsDir, plugins[p].name, out);
    }
  }
}

/** Scans the filesystem for available skills from all sources. */
@injectable()
export class SkillService {
  /**
   * List all available skills from every source, in priority order:
   * 1. Local user skills (~/.claude/skills/)
   * 2. Project skills (<cwd>/.claude/skills/)
   * 3. Agent skills (~/.claude/.agents/skills/)
   * 4. Plugin cache (~/.claude/plugins/cache/)
   * 5. Plugin marketplaces (~/.claude/plugins/marketplaces/)
   */
  list(cwd?: string): SkillInfo[] {
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const out = new Map<string, SkillInfo>();

    scanFlatSkillsDir(join(claudeDir, "skills"), "", out);

    if (cwd) {
      scanFlatSkillsDir(join(cwd, ".claude", "skills"), "", out);
    }

    scanFlatSkillsDir(join(claudeDir, ".agents", "skills"), "", out);
    scanPluginCacheDir(join(claudeDir, "plugins", "cache"), out);
    scanPluginMarketplaceDir(
      join(claudeDir, "plugins", "marketplaces"),
      out,
    );

    return Array.from(out.values());
  }
}
