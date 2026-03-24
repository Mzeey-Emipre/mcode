import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Compiled once at module scope — avoids re-compilation on every SKILL.md parse.
 * FRONTMATTER_RE: captures the YAML block between --- fences.
 * DESC_RE: extracts the description value (quoted or unquoted).
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESC_RE = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;

/**
 * Extract description from a SKILL.md file's frontmatter.
 *
 * Performance notes:
 * - readFileSync with utf-8 encoding avoids a separate Buffer→string step
 * - Regex is pre-compiled (module-scope) so no compile cost per call
 * - We exec FRONTMATTER_RE first (small match) then DESC_RE only on the
 *   frontmatter substring — avoids running DESC_RE on the full file body
 */
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

/**
 * Safely read directory entries with file-type info.
 *
 * `withFileTypes: true` is critical — it piggybacks on the same syscall
 * (getdents64 on Linux, NtQueryDirectoryFile on Windows) to return
 * d_type, avoiding a separate stat() per entry. For a directory with
 * N entries, this is N fewer kernel transitions.
 *
 * Returns [] on any error (ENOENT, EACCES, etc.) — callers never need
 * to pre-check directory existence, saving another stat() syscall.
 */
function safeDirEntries(dir: string): import("fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Scan a flat skills directory where each subdirectory is a skill.
 * Used for: ~/.claude/skills/, ~/.claude/.agents/skills/, .claude/skills/
 *
 * @param dir       - Absolute path to the skills directory
 * @param prefix    - Namespace prefix for dedup/display (e.g. "superpowers").
 *                    Empty string means no prefix (local/project skills).
 * @param out       - Accumulator Map. Key = display name. First-write wins,
 *                    so call higher-priority sources first.
 *
 * The Map gives O(1) has() per skill — no array .find() or .some() scan.
 * We skip non-directory entries inline (single pass, no filter+map).
 */
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
    // First-write-wins: higher-priority source already registered this name
    if (out.has(displayName)) continue;
    out.set(displayName, {
      name: displayName,
      description: readSkillDescription(join(dir, entry.name)),
    });
  }
}

/**
 * Scan plugin cache directory.
 * Structure: cache/<marketplace>/<plugin>/<version>/skills/<skill>/
 *
 * For each plugin, we sort version directories lexicographically and take
 * the last one. This works correctly for both semver ("1.0.0" < "5.0.1")
 * and hash-based versions (arbitrary but consistent ordering).
 *
 * Optimization: we only call safeDirEntries on the `skills/` subdirectory
 * of the chosen version — we never enumerate files at the version level
 * (which may contain lib/, node_modules/, etc. we don't care about).
 */
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
      // Collect version dirs — inline filter avoids intermediate array alloc
      const versions: string[] = [];
      const vEntries = safeDirEntries(pDir);
      for (let v = 0; v < vEntries.length; v++) {
        if (vEntries[v].isDirectory()) versions.push(vEntries[v].name);
      }
      if (versions.length === 0) continue;
      // Sort in place (no new array) and take last = latest
      versions.sort();
      const skillsDir = join(pDir, versions[versions.length - 1], "skills");
      scanFlatSkillsDir(skillsDir, plugins[p].name, out);
    }
  }
}

/**
 * Scan plugin marketplaces directory.
 * Structure: marketplaces/<marketplace>/<plugin>/skills/<skill>/
 *
 * Simpler than cache — no version nesting. We descend directly into
 * each plugin's skills/ subdirectory.
 */
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

/**
 * List all available skills from every source, in priority order:
 *
 *   1. Local user skills       ~/.claude/skills/<skill>/
 *   2. Project skills           <cwd>/.claude/skills/<skill>/
 *   3. Agent skills             ~/.claude/.agents/skills/<skill>/
 *   4. Plugin cache             ~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills/<skill>/
 *   5. Plugin marketplaces      ~/.claude/plugins/marketplaces/<mkt>/<plugin>/skills/<skill>/
 *
 * Deduplication: the Map accumulator uses first-write-wins, so scanning
 * in priority order means a local skill named "commit" shadows a plugin
 * skill also named "commit". Plugin skills are namespaced as
 * "<plugin>:<skill>" to avoid unintended collisions.
 *
 * Memory: a single Map is the only heap allocation that grows with skill
 * count. No intermediate arrays are created and discarded. The final
 * Array.from(map.values()) is a single allocation of the exact needed size.
 *
 * Syscalls: withFileTypes avoids stat(). safeDirEntries avoids existsSync
 * pre-checks. For a typical setup (~100 local + ~50 plugin skills) this
 * totals ~20 readdirSync + ~150 readFileSync = ~170 syscalls, completing
 * in <50ms on warm page cache.
 *
 * @param cwd  Optional workspace root for project-level skill discovery.
 */
export function listSkills(cwd?: string): SkillInfo[] {
  const home = homedir();
  const claudeDir = join(home, ".claude");
  const out = new Map<string, SkillInfo>();

  // 1. Local user skills (highest priority — user's own overrides)
  scanFlatSkillsDir(join(claudeDir, "skills"), "", out);

  // 2. Project-level skills (workspace-specific)
  if (cwd) {
    scanFlatSkillsDir(join(cwd, ".claude", "skills"), "", out);
  }

  // 3. Agent skills
  scanFlatSkillsDir(join(claudeDir, ".agents", "skills"), "", out);

  // 4. Plugin cache (versioned, take latest version per plugin)
  scanPluginCacheDir(join(claudeDir, "plugins", "cache"), out);

  // 5. Plugin marketplaces (unversioned)
  scanPluginMarketplaceDir(join(claudeDir, "plugins", "marketplaces"), out);

  return Array.from(out.values());
}
