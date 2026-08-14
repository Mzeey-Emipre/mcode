import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { isProviderVersionAtLeast } from "@mcode/providers";

/** Which discovery strategy produced a resolution (for diagnostics + banner copy). */
export type CopilotCliSource = "configured" | "npm-global" | "path-shim";

/** A successful resolution: an absolute, spawnable entry plus the detected version. */
export interface CopilotCliFound {
  source: CopilotCliSource;
  /** Absolute path passed to the SDK as `cliPath` (the CLI's index.js, or the configured path). */
  entry: string;
  /** Detected version (e.g. "1.0.24"), or null when it could not be read. */
  version: string | null;
}

/** No strategy resolved; carries a user-facing install message. */
export interface CopilotCliNotFound {
  source: "not-found";
  entry: null;
  version: null;
  message: string;
}

/** The outcome of resolving the Copilot CLI: a found entry or a not-found message. */
export type CopilotCliResolution = CopilotCliFound | CopilotCliNotFound;

/** Filesystem/process access behind one seam so the resolver is testable without spawning. */
export interface CopilotCliResolverIO {
  /** True when a path exists on disk. */
  exists(p: string): boolean;
  /** UTF-8 file contents, or null when unreadable. */
  readFile(p: string): string | null;
  /** Run a command; trimmed stdout, or null on spawn error / non-zero exit. */
  exec(command: string, args: string[]): string | null;
  /** Host platform; selects the win32 vs posix PATH branch. */
  platform: NodeJS.Platform;
}

/** @deprecated Use {@link CopilotCliResolverIO}. */
export type ResolverIO = CopilotCliResolverIO;

/** Inputs the resolver needs from the caller. */
export interface CopilotCliResolveContext {
  /** The user-configured CLI path (`settings.provider.cli.copilot`), if any. */
  configuredPath?: string;
}

/** @deprecated Use {@link CopilotCliResolveContext}. */
export type ResolveContext = CopilotCliResolveContext;

interface Strategy {
  source: CopilotCliSource;
  resolve(ctx: CopilotCliResolveContext, io: CopilotCliResolverIO): { entry: string; version: string | null } | null;
}

/** Shell control characters that must not appear in a CLI path passed to `shell: true`. */
const SHELL_METACHAR_RE = /[;&|`$<>\"'\n\r]/;

/** TTL for cached resolution results (5 minutes). */
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cached resolution results keyed by trimmed configured path (empty string for auto-discovery). */
const resolutionCache = new Map<string, { resolution: CopilotCliResolution; checkedAt: number }>();

/** Semver triplet matcher (matches "1.0.24" in "GitHub Copilot CLI 1.0.24."). */
const VERSION_RE = /\b(\d+\.\d+\.\d+)(?!\.\d)/;

/** Extracts a semver triplet from `<entry> --version` output, or null. */
function parseVersion(out: string): string | null {
  const m = out.match(VERSION_RE);
  return m ? m[1]! : null;
}

/** Minimum 0.0.x build that accepts the SDK's programmatic spawn flags. */
const MIN_COPILOT_CLI_0X = "0.0.403";

/** Minimum 1.x line accepted for SDK integration (headless may be omitted from --help). */
const MIN_COPILOT_CLI_1X = "1.0.0";

/**
 * True when the located CLI can host the Copilot SDK. Uses semver first because
 * 1.x builds support `--headless` at runtime even when `--help` only lists `--acp`.
 */
function supportsSdkCompatibleCli(
  entry: string,
  version: string | null,
  io: CopilotCliResolverIO,
): boolean {
  if (version) {
    if (isProviderVersionAtLeast(version, MIN_COPILOT_CLI_1X)) return true;
    if (isProviderVersionAtLeast(version, MIN_COPILOT_CLI_0X)) return true;
  }
  const help = io.exec(entry, ["--help"]);
  if (help != null && (/--headless\b/.test(help) || /--acp\b/.test(help))) return true;
  return false;
}

/**
 * Returns a not-found resolution when the located CLI is too old for the SDK.
 */
function tooOldForSdk(
  entry: string,
  version: string | null,
  io: CopilotCliResolverIO,
): CopilotCliNotFound | null {
  if (supportsSdkCompatibleCli(entry, version, io)) return null;
  return {
    source: "not-found",
    entry: null,
    version: null,
    message: formatCopilotUpgradeMessage(version),
  };
}

/**
 * User-facing message when a located CLI is too old for the Copilot SDK.
 */
export function formatCopilotUpgradeMessage(version: string | null): string {
  const versionLabel = version ?? "unknown";
  return (
    `GitHub Copilot CLI ${versionLabel} is too old for Mcode. ` +
    `Update to ${MIN_COPILOT_CLI_1X} or newer (or ${MIN_COPILOT_CLI_0X}+ on the 0.0.x line).\n\n` +
    "Update with: npm install -g @github/copilot@latest"
  );
}

/**
 * Resolves a `@github/copilot` package directory to its absolute `index.js`
 * entry (the JS entry point the SDK runs with node) and version. Returns null
 * when the package's `index.js` is missing or the package name does not match.
 * Shared by the npm-global and path-shim strategies.
 */
function resolvePackageEntry(
  pkgDir: string,
  io: CopilotCliResolverIO,
): { entry: string; version: string | null } | null {
  const entry = join(pkgDir, "index.js");
  if (!io.exists(entry)) return null;
  const raw = io.readFile(join(pkgDir, "package.json"));
  let version: string | null = null;
  if (raw) {
    try {
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name !== "@github/copilot") return null;
      version = typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      return null;
    }
  } else {
    return null;
  }
  return { entry, version };
}

/**
 * Attempts configured-path resolution. Returns not-found for invalid shell
 * metacharacters, null to fall through when the path is missing or unreachable,
 * or a configured resolution when the path exists and responds to `--version`.
 */
function tryConfiguredPath(
  configuredPath: string,
  io: CopilotCliResolverIO,
): CopilotCliFound | CopilotCliNotFound | null {
  if (SHELL_METACHAR_RE.test(configuredPath)) {
    return {
      source: "not-found",
      entry: null,
      version: null,
      message:
        `GitHub Copilot CLI path contains invalid characters: "${configuredPath}". ` +
        "Check the path in Settings > Provider > Copilot CLI path.",
    };
  }
  if (!io.exists(configuredPath)) return null;
  const out = io.exec(configuredPath, ["--version"]);
  if (!out) return null;
  return { source: "configured", entry: configuredPath, version: parseVersion(out) };
}

/**
 * 2. `@github/copilot` resolved via `npm root -g`. The primary auto-discovery
 * route: it finds the global install the SDK's own search misses, and yields
 * the absolute index.js the SDK runs with node.
 */
const npmGlobalStrategy: Strategy = {
  source: "npm-global",
  resolve(_ctx, io) {
    const root = io.exec("npm", ["root", "-g"]);
    if (!root) return null;
    return resolvePackageEntry(join(root, "@github", "copilot"), io);
  },
};

/** Returns the first command source on PATH: PowerShell-aware on win32, `which` on posix. */
function locateOnPath(io: CopilotCliResolverIO): string | null {
  if (io.platform === "win32") {
    // `where.exe` cannot see ExternalScript/.ps1 shims; Get-Command can. Prefer
    // it, fall back to `where` for .cmd/.exe shims.
    const viaPwsh = io.exec("powershell", ["-NoProfile", "-Command", "(Get-Command copilot).Source"]);
    if (viaPwsh) return viaPwsh.split(/\r?\n/)[0]?.trim() ?? null;
    const viaWhere = io.exec("where", ["copilot"]);
    return viaWhere ? (viaWhere.split(/\r?\n/)[0]?.trim() ?? null) : null;
  }
  const viaWhich = io.exec("which", ["copilot"]);
  return viaWhich ? (viaWhich.split(/\r?\n/)[0]?.trim() ?? null) : null;
}

/**
 * 3. PATH/shim fallback. Resolves `copilot` on PATH (PowerShell-aware on win32
 * so .ps1 ExternalScripts are visible), then follows to the adjacent
 * `node_modules/@github/copilot/index.js`. Covers non-standard layouts the
 * npm-global root does not surface.
 */
const pathShimStrategy: Strategy = {
  source: "path-shim",
  resolve(_ctx, io) {
    const shim = locateOnPath(io);
    if (!shim) return null;
    return resolvePackageEntry(join(dirname(shim), "node_modules", "@github", "copilot"), io);
  },
};

/** Auto-discovery strategies, tried in priority order after configured-path handling. */
const AUTO_STRATEGIES: Strategy[] = [npmGlobalStrategy, pathShimStrategy];

/** Builds the not-found resolution, disambiguating `@github/copilot` from `gh copilot`. */
function notFound(io: CopilotCliResolverIO): CopilotCliNotFound {
  const ghExts = io.exec("gh", ["extension", "list"]);
  const hasGhCopilot = ghExts != null && /copilot/i.test(ghExts);
  return {
    source: "not-found",
    entry: null,
    version: null,
    message: formatCopilotNotFoundMessage(hasGhCopilot),
  };
}

/**
 * Returns the user-facing install message when the Copilot CLI cannot be used.
 * When `hasGhCopilot` is omitted, probes `gh extension list` via `io`.
 */
export function formatCopilotNotFoundMessage(
  hasGhCopilot?: boolean,
  io?: CopilotCliResolverIO,
): string {
  let ghInstalled = hasGhCopilot;
  if (ghInstalled === undefined && io != null) {
    const ghExts = io.exec("gh", ["extension", "list"]);
    ghInstalled = ghExts != null && /copilot/i.test(ghExts);
  }
  ghInstalled ??= false;
  const base =
    "GitHub Copilot CLI not found. Install it with: npm install -g @github/copilot\n\n" +
    "Or set a custom path in Settings > Provider > Copilot CLI path.";
  const disambig = ghInstalled === true
    ? "\n\nNote: the `gh copilot` GitHub CLI extension is installed, which is different " +
      "from the `@github/copilot` npm package Mcode needs."
    : "";
  return base + disambig;
}

/** Cache key for resolution results: trimmed configured path, or empty for auto-discovery. */
function resolutionCacheKey(ctx: CopilotCliResolveContext): string {
  return ctx.configuredPath?.trim() ?? "";
}

/**
 * Resolves the Copilot CLI by trying configured path first, then auto-discovery
 * strategies in priority order. Returns a not-found resolution with an install
 * message when none succeed. Reports a raw version only; min-version policy is
 * intentionally not handled here (see ADR-0001).
 */
export function resolveCopilotCli(
  ctx: CopilotCliResolveContext,
  io: CopilotCliResolverIO,
): CopilotCliResolution {
  const cacheKey = resolutionCacheKey(ctx);
  const cached = resolutionCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < RESOLUTION_CACHE_TTL_MS) {
    return cached.resolution;
  }

  const configured = ctx.configuredPath?.trim();
  let resolution: CopilotCliResolution;
  if (configured) {
    const configuredResult = tryConfiguredPath(configured, io);
    if (configuredResult?.source === "not-found") {
      resolution = configuredResult;
    } else if (configuredResult) {
      resolution = configuredResult;
    } else {
      resolution = resolveAutoDiscovery(ctx, io);
    }
  } else {
    resolution = resolveAutoDiscovery(ctx, io);
  }

  if (resolution.source !== "not-found") {
    const outdated = tooOldForSdk(resolution.entry, resolution.version, io);
    if (outdated) resolution = outdated;
  }

  resolutionCache.set(cacheKey, { resolution, checkedAt: Date.now() });
  return resolution;
}

/** Runs npm-global and path-shim strategies, falling back to not-found. */
function resolveAutoDiscovery(
  ctx: CopilotCliResolveContext,
  io: CopilotCliResolverIO,
): CopilotCliResolution {
  for (const strategy of AUTO_STRATEGIES) {
    const r = strategy.resolve(ctx, io);
    if (r) return { source: strategy.source, entry: r.entry, version: r.version };
  }
  return notFound(io);
}

/** Clears cached resolution results. Exposed for testing only. */
export function clearResolutionCache(): void {
  resolutionCache.clear();
}

/** Real adapter: Node fs + spawnSync. `shell:true` on win32 resolves `.cmd`/`.ps1` shims for probes. */
export function createNodeResolverIO(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): CopilotCliResolverIO {
  return {
    platform,
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exec: (command, args) => {
      const r = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: platform === "win32",
        env,
      });
      if (r.error || r.status !== 0) return null;
      const out = (r.stdout ?? "").trim();
      return out.length > 0 ? out : null;
    },
  };
}
