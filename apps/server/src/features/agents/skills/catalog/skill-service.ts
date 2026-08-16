/**
 * Skill and command scanning service.
 * Walks user, project, agent, and plugin directories looking for both
 * `skills/` (each subdirectory is a skill) and provider command directories.
 * Codex capabilities are intentionally excluded and enter through the provider catalog.
 */

import { injectable } from "tsyringe";
import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { logger } from "@mcode/shared";
import type { SkillInfo, SkillSource, SkillDiagnostics } from "@mcode/contracts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESC_RE = /^description:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;
const NAME_RE = /^name:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m;

interface ScanContext {
  out: SkillInfo[];
  diag: SkillDiagnostics;
}

interface SkillFileMetadata {
  name: string | undefined;
  description: string;
}

/** Source priority: lower number = higher priority (overrides on duplicate name). */
const SOURCE_PRIORITY: Record<SkillSource, number> = {
  user: 0,
  project: 1,
  agent: 2,
  plugin: 3,
};

/** Extract `description:` from the leading YAML frontmatter of a markdown file. */
function readSkillFileMetadata(filePath: string): SkillFileMetadata {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fm = FRONTMATTER_RE.exec(content);
    if (!fm) return { name: undefined, description: "" };
    const name = NAME_RE.exec(fm[1]);
    const desc = DESC_RE.exec(fm[1]);
    return {
      name: name ? (name[1] ?? name[2] ?? name[3] ?? "").trim() : undefined,
      description: desc ? (desc[1] ?? desc[2] ?? desc[3] ?? "").trim() : "",
    };
  } catch {
    return { name: undefined, description: "" };
  }
}

/** Extract `description:` from the leading YAML frontmatter of a markdown file. */
function readDescription(filePath: string): string {
  return readSkillFileMetadata(filePath).description;
}

/** Read a directory, recording each scan attempt in diagnostics. Never throws. */
function scanDir(ctx: ScanContext, dir: string): Dirent[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
    ctx.diag.scanned.push({ path: dir, existed: true, entries: entries.length });
    return entries;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      ctx.diag.scanned.push({ path: dir, existed: false, entries: 0 });
    } else {
      ctx.diag.errors.push({ path: dir, message: error.message });
      logger.debug("SkillService: scan error", { dir, message: error.message });
    }
    return [];
  }
}

/** Walk a flat skills directory: each subdir with `SKILL.md` is a skill. */
function scanSkillsDir(
  ctx: ScanContext,
  dir: string,
  prefix: string,
  source: SkillSource,
  providers: string[],
): void {
  for (const entry of scanDir(ctx, dir)) {
    if (!entry.isDirectory()) continue;
    // Only treat a subdir as a skill if it has SKILL.md. Helper folders
    // (e.g., `_shared/`, `node_modules/`) and partially installed plugin
    // dirs would otherwise become empty slash-command entries.
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const metadata = readSkillFileMetadata(skillFile);
    const name = prefix ? `${prefix}:${entry.name}` : entry.name;
    ctx.out.push({
      name,
      description: metadata.description,
      kind: "skill",
      source,
      providers,
      nativeName: metadata.name || entry.name,
      path: skillFile,
    });
    ctx.diag.totalSkills++;
  }
}

/** Walk a flat commands directory: each *.md is a command. */
function scanCommandsDir(
  ctx: ScanContext,
  dir: string,
  prefix: string,
  source: SkillSource,
  providers: string[],
): void {
  for (const entry of scanDir(ctx, dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const baseName = entry.name.slice(0, -3);
    const name = prefix ? `${prefix}:${baseName}` : baseName;
    ctx.out.push({
      name,
      description: readDescription(join(dir, entry.name)),
      kind: "command",
      source,
      providers,
      nativeName: baseName,
      path: join(dir, entry.name),
    });
    ctx.diag.totalCommands++;
  }
}

/**
 * Scan every known surface inside one plugin version directory.
 * Plugins live under `~/.claude/plugins/` — Claude's own infrastructure — so they
 * are always tagged with whatever `providers` the caller passes (always `["claude"]`).
 * Provider-specific subdirs authored by the plugin (`.agents/`, `.codex/`, etc.) are
 * intentionally ignored here: a plugin installed through Claude's system does not
 * automatically become available to other providers. Cross-provider access requires
 * the user to place skills in the provider-specific user directories (`~/.codex/`,
 * `~/.agents/`, etc.) explicitly.
 */
function scanPluginVersionDir(
  ctx: ScanContext,
  versionDir: string,
  pluginName: string,
  providers: string[],
): void {
  // Both bare and `.claude`-prefixed shapes are observed in the wild.
  for (const sub of ["", ".claude"]) {
    const base = sub ? join(versionDir, sub) : versionDir;
    scanSkillsDir(ctx, join(base, "skills"), pluginName, "plugin", providers);
    scanCommandsDir(ctx, join(base, "commands"), pluginName, "plugin", providers);
  }
}

/** Numeric collator orders `2.1.0` before `10.0.0` instead of lexically.
 *  Avoids pulling in the `semver` dep just for plugin-cache version selection. */
const VERSION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Walk plugin cache: cache/<marketplace>/<plugin>/<version>/. */
function scanPluginCacheDir(ctx: ScanContext, cacheDir: string, providers: string[]): void {
  for (const mp of scanDir(ctx, cacheDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = join(cacheDir, mp.name);
    for (const plugin of scanDir(ctx, mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(mpDir, plugin.name);
      const versions = scanDir(ctx, pluginDir)
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(VERSION_COLLATOR.compare);
      if (versions.length === 0) continue;
      scanPluginVersionDir(ctx, join(pluginDir, versions[versions.length - 1]), plugin.name, providers);
    }
  }
}

/**
 * Walk plugin marketplaces: each marketplace directory IS the plugin version root.
 *
 * Marketplace installs are git-checkout style repos where the marketplace dir itself
 * contains the plugin content (skills/, commands/, .agents/, .claude/, etc.).
 * They do NOT follow a <marketplace>/<plugin>/<version>/ nesting — the marketplace
 * name IS the plugin name, and the directory IS the version dir. Treating subdirs
 * as separate "plugins" would produce wrong prefixes (e.g. ".agents:adapt" instead
 * of "impeccable:adapt") and duplicate entries alongside the cache scan.
 */
function scanPluginMarketplaceDir(ctx: ScanContext, marketplacesDir: string, providers: string[]): void {
  for (const mp of scanDir(ctx, marketplacesDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = join(marketplacesDir, mp.name);
    // Use the marketplace name as the plugin prefix; the dir itself is the version dir.
    scanPluginVersionDir(ctx, mpDir, mp.name, providers);
  }
}

function pathSegmentsUnder(root: string, filePath: string): string[] | null {
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const fileNorm = filePath.replace(/\\/g, "/");
  const rootLower = rootNorm.toLowerCase();
  const fileLower = fileNorm.toLowerCase();
  if (fileLower !== rootLower && !fileLower.startsWith(`${rootLower}/`)) return null;
  return fileNorm.slice(rootNorm.length + 1).split("/").filter(Boolean);
}

/** Returns the Codex plugin name encoded in a skill path, when the path has one. */
export function codexPluginNameFromSkillPath(filePath: string, home = homedir()): string | undefined {
  const cacheSegments = pathSegmentsUnder(join(home, ".codex", "plugins", "cache"), filePath);
  if (cacheSegments && cacheSegments.length >= 2) return cacheSegments[1];

  const runtimeSegments = pathSegmentsUnder(
    join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "plugins"),
    filePath,
  );
  if (runtimeSegments) {
    const pluginsIdx = runtimeSegments.findIndex((segment) => segment.toLowerCase() === "plugins");
    const pluginName = pluginsIdx >= 0 ? runtimeSegments[pluginsIdx + 1] : undefined;
    if (pluginName) return pluginName;
  }

  return undefined;
}

/**
 * Scan one Cursor plugin install directory (hash-named version folder).
 * Extends Claude-shaped layouts with Cursor-native `.cursor/skills`,
 * `.cursor/commands`, and peer `workflow-skills/` trees.
 */
function scanCursorPluginVersionDir(
  ctx: ScanContext,
  versionDir: string,
  pluginName: string,
  providers: string[],
): void {
  scanPluginVersionDir(ctx, versionDir, pluginName, providers);
  const cursorBase = join(versionDir, ".cursor");
  scanSkillsDir(ctx, join(cursorBase, "skills"), pluginName, "plugin", providers);
  scanCommandsDir(ctx, join(cursorBase, "commands"), pluginName, "plugin", providers);
  scanSkillsDir(ctx, join(versionDir, "workflow-skills"), pluginName, "plugin", providers);
  scanSkillsDir(ctx, join(cursorBase, "workflow-skills"), pluginName, "plugin", providers);
}

/**
 * Walk Cursor plugin caches (`~/.cursor/plugins/cache`, `local`): cache/<mp>/<plugin>/<hash>/.
 * Version dirs are opaque hashes (not semver); pick the newest by directory mtime.
 */
function scanCursorPluginCacheDir(ctx: ScanContext, cacheDir: string, providers: string[]): void {
  for (const mp of scanDir(ctx, cacheDir)) {
    if (!mp.isDirectory()) continue;
    const mpDir = join(cacheDir, mp.name);
    for (const plugin of scanDir(ctx, mpDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(mpDir, plugin.name);
      const versionDirs = scanDir(ctx, pluginDir).filter((e) => e.isDirectory());
      if (versionDirs.length === 0) continue;
      let best: { name: string; mtime: number } | null = null;
      for (const e of versionDirs) {
        const p = join(pluginDir, e.name);
        let mtime = 0;
        try {
          mtime = statSync(p).mtimeMs;
        } catch {
          /* stale symlink / race — treat as 0 */
        }
        if (!best || mtime > best.mtime) {
          best = { name: e.name, mtime };
        }
      }
      if (best) {
        scanCursorPluginVersionDir(ctx, join(pluginDir, best.name), plugin.name, providers);
      }
    }
  }
}

/**
 * Resolve the Copilot user-level agents directory.
 *
 * @returns The platform-specific path to Copilot's user-level agents directory.
 *   - Windows: `%APPDATA%\GitHub Copilot\agents`
 *   - macOS/Linux: `~/.config/github-copilot/agents`
 */
export function copilotUserAgentsDir(): string {
  if (platform() === "win32") {
    const appData =
      process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "GitHub Copilot", "agents");
  }
  return join(homedir(), ".config", "github-copilot", "agents");
}

/** Drives a single directory scan: which path, what source, which providers, and whether to scan for skills, commands, or both. */
interface ScanRoot {
  path: string;
  source: SkillSource;
  providers: string[];
  /** "skills" scans for subdirs with SKILL.md, "commands" scans for *.md files, "both" does both. */
  kind: "skills" | "commands" | "both";
  /** Optional namespace prefix applied to markdown command files. */
  prefix?: string;
}

/** Build the ordered list of directories to scan for skills and commands. */
function buildScanRoots(home: string, cwd?: string): ScanRoot[] {
  const claudeDir = join(home, ".claude");
  const copilotDir = join(home, ".copilot");
  const cursorDir = join(home, ".cursor");

  const roots: ScanRoot[] = [
    // Claude ecosystem
    { path: join(claudeDir, "skills"), source: "user", providers: ["claude"], kind: "skills" },
    { path: join(claudeDir, "commands"), source: "user", providers: ["claude"], kind: "commands" },
    { path: join(claudeDir, ".agents", "skills"), source: "agent", providers: ["claude"], kind: "skills" },

    // Copilot ecosystem
    { path: join(copilotDir, "skills"), source: "user", providers: ["copilot"], kind: "skills" },
    { path: join(copilotDir, "commands"), source: "user", providers: ["copilot"], kind: "commands" },

    // Cursor CLI ecosystem (cursor-agent discovers workspace rules separately; these roots drive Mcode UI listing)
    { path: join(cursorDir, "skills"), source: "user", providers: ["cursor"], kind: "skills" },
    { path: join(cursorDir, "commands"), source: "user", providers: ["cursor"], kind: "commands" },

    // Copilot user-level agents (OS-native config path)
    { path: copilotUserAgentsDir(), source: "user", providers: ["copilot"], kind: "both" },
  ];

  if (cwd) {
    roots.push(
      // Claude project-level
      { path: join(cwd, ".claude", "skills"), source: "project", providers: ["claude"], kind: "skills" },
      { path: join(cwd, ".claude", "commands"), source: "project", providers: ["claude"], kind: "commands" },

      // Copilot project-level agents
      { path: join(cwd, ".github", "agents"), source: "project", providers: ["copilot"], kind: "both" },
      { path: join(cwd, ".copilot", "agents"), source: "project", providers: ["copilot"], kind: "both" },

      // Cursor project-level
      { path: join(cwd, ".cursor", "skills"), source: "project", providers: ["cursor"], kind: "skills" },
      { path: join(cwd, ".cursor", "commands"), source: "project", providers: ["cursor"], kind: "commands" },
    );
  }

  return roots;
}

/** Discovers skills and commands across user, project, agent, and plugin sources. */
@injectable()
export class SkillService {
  /** Cached result; null means cold or invalidated. */
  private cache: SkillInfo[] | null = null;
  private cachedCwd: string | undefined = undefined;
  private subscribers = new Set<() => void>();

  /**
   * List discoverable skills and commands from disk.
   * When `providerId` is given, only entries whose `providers` array includes
   * that id are returned. Deduplication by name (higher-priority source wins)
   * is applied per filtered set, so the same name can coexist across providers.
   */
  list(cwd?: string, providerId?: string): SkillInfo[] {
    if (this.cache && this.cachedCwd === cwd) {
      return this.filterAndDedup(this.cache, providerId);
    }
    const result = this.scan(cwd);
    this.cache = result.items;
    this.cachedCwd = cwd;
    return this.filterAndDedup(result.items, providerId);
  }

  /** Force a full rescan and return per-path diagnostics. Provider-agnostic. */
  diagnose(cwd?: string): SkillDiagnostics {
    const result = this.scan(cwd);
    this.cache = result.items;
    this.cachedCwd = cwd;
    return result.diag;
  }

  /** Clear the in-memory cache and notify subscribers. Subscriber errors are isolated. */
  invalidate(): void {
    this.cache = null;
    this.cachedCwd = undefined;
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug("SkillService: subscriber threw", { message });
      }
    }
  }

  /** Register a callback fired whenever the cache is invalidated. Returns an unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Filter entries by provider, then deduplicate by name within the filtered
   * set using source priority (user > project > agent > plugin).
   * Deduplication is intentionally scoped to the filtered set so that a skill
   * named "deploy" can independently exist for both claude and codex.
   */
  private filterAndDedup(items: SkillInfo[], providerId?: string): SkillInfo[] {
    const filtered = providerId
      ? items.filter((s) => s.providers.includes(providerId))
      : items;

    const seen = new Map<string, SkillInfo>();
    for (const item of filtered) {
      const existing = seen.get(item.name);
      if (!existing || SOURCE_PRIORITY[item.source] < SOURCE_PRIORITY[existing.source]) {
        seen.set(item.name, item);
      }
    }

    return Array.from(seen.values());
  }

  private scan(cwd?: string): { items: SkillInfo[]; diag: SkillDiagnostics } {
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const cursorDir = join(home, ".cursor");
    const ctx: ScanContext = {
      out: [],
      diag: { scanned: [], errors: [], totalSkills: 0, totalCommands: 0 },
    };

    const roots = buildScanRoots(home, cwd);
    for (const root of roots) {
      if (root.kind === "skills" || root.kind === "both") {
        scanSkillsDir(ctx, root.path, "", root.source, root.providers);
      }
      if (root.kind === "commands" || root.kind === "both") {
        scanCommandsDir(ctx, root.path, root.prefix ?? "", root.source, root.providers);
      }
    }

    // Claude plugin infrastructure (semver-sorted cache + marketplace checkouts)
    scanPluginCacheDir(ctx, join(claudeDir, "plugins", "cache"), ["claude"]);
    scanPluginMarketplaceDir(ctx, join(claudeDir, "plugins", "marketplaces"), ["claude"]);

    // Cursor plugin installs (mtime-selected hash dirs under ~/.cursor/plugins)
    scanCursorPluginCacheDir(ctx, join(cursorDir, "plugins", "cache"), ["cursor"]);
    scanCursorPluginCacheDir(ctx, join(cursorDir, "plugins", "local"), ["cursor"]);

    return { items: ctx.out, diag: ctx.diag };
  }
}
