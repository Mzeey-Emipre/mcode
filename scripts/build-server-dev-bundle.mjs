/**
 * One-shot dev server bundle: `apps/server` tsc emit (`emitDecoratorMetadata`)
 * followed by esbuild CJS bundle to `apps/desktop/dist/server/server.cjs`, plus
 * Claude SDK native CLI binary beside it. Shared by desktop dev orchestration and
 * `scripts/dev-web.mjs` (no `--import tsx` at runtime).
 */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Monorepo root when this script lives at `<root>/scripts/`. */
export function repoRootFromScript() {
  return resolve(__dirname, "..");
}

/**
 * Resolve the bundled `typescript` compiler entry for `execFile(process.execPath, [...])`.
 *
 * @param serverRoot Usually `apps/server` (passed so worktrees/monorepo roots resolve reliably).
 */
export function resolveServerTscBin(serverRoot = resolve(repoRootFromScript(), "apps/server")) {
  const localTsc = resolve(serverRoot, "node_modules/typescript/bin/tsc");
  const rootTsc = resolve(serverRoot, "../../node_modules/typescript/bin/tsc");
  return existsSync(localTsc) ? localTsc : rootTsc;
}

/**
 * Compile apps/server → dist-tsc via tsc (same project as packaged builds).
 *
 * @param {string} [serverRoot] Root of `apps/server` (directory with `package.json`).
 */
export function compileServerWithTsc(serverRoot = resolve(repoRootFromScript(), "apps/server")) {
  const tscBin = resolveServerTscBin(serverRoot);
  execFileSync(process.execPath, [tscBin, "--project", resolve(serverRoot, "tsconfig.build.json")], {
    cwd: serverRoot,
    stdio: "inherit",
  });
}

/**
 * Map electron-builder platform names to npm `process.platform` values.
 *
 * @param {string} electronPlatformName
 * @returns {NodeJS.Platform}
 */
export function electronPlatformToNpm(electronPlatformName) {
  if (electronPlatformName === "win32") return "win32";
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") return "darwin";
  if (electronPlatformName === "linux") return "linux";
  throw new Error(`Unsupported electron platform: ${electronPlatformName}`);
}

/**
 * Map electron-builder `Arch` values (string or numeric enum) to npm `process.arch`.
 *
 * @param {string | number} electronArch
 * @returns {NodeJS.Architecture}
 */
export function electronArchToNpm(electronArch) {
  if (typeof electronArch === "string") {
    if (electronArch === "armv7l") return "arm";
    return /** @type {NodeJS.Architecture} */ (electronArch);
  }
  switch (electronArch) {
    case 0:
      return "ia32";
    case 1:
      return "x64";
    case 2:
      return "arm";
    case 3:
      return "arm64";
    case 4:
      throw new Error("electron-builder Arch.universal is not supported for Claude SDK platform packages");
    default:
      throw new Error(`Unsupported electron-builder arch: ${electronArch}`);
  }
}

/**
 * Resolve the on-disk `dist/server` directory inside a packaged app.
 *
 * @param {object} args
 * @param {string} args.appOutDir electron-builder output directory (e.g. `win-unpacked`).
 * @param {string} args.electronPlatformName
 * @param {string} args.productFilename App binary filename without extension.
 */
export function resolvePackagedServerDir({ appOutDir, electronPlatformName, productFilename }) {
  const tail = ["app.asar.unpacked", "dist", "server"];
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return resolve(appOutDir, `${productFilename}.app`, "Contents", "Resources", ...tail);
  }
  return resolve(appOutDir, "resources", ...tail);
}

/**
 * Ordered Claude SDK platform package names to try for a target OS/arch.
 * Linux musl hosts only install the `-musl` optional dependency.
 *
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.Architecture} arch
 * @returns {string[]}
 */
export function claudeSdkPlatformPackageCandidates(platform, arch) {
  if (platform === "linux") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
      `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
    ];
  }
  return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
}

/**
 * Platform package name and CLI binary filename for the Claude Agent SDK.
 *
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.Architecture} arch
 */
export function claudeSdkPlatformParts(platform, arch) {
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const binName = platform === "win32" ? "claude.exe" : "claude";
  return { platformPkg, binName };
}

/**
 * Expected on-disk path to the staged Claude SDK CLI beside a bundled `server.cjs`.
 *
 * @param {string} serverCjsOut Absolute path to `server.cjs`.
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.Architecture} [arch]
 */
export function expectedClaudeSdkCliPath(
  serverCjsOut,
  platform = process.platform,
  arch = process.arch,
) {
  const { platformPkg, binName } = claudeSdkPlatformParts(platform, arch);
  return resolve(dirname(serverCjsOut), "node_modules", platformPkg, binName);
}

/**
 * Locate the staged Claude SDK CLI beside `server.cjs`, trying linux musl and glibc names.
 *
 * @param {string} serverCjsOut
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.Architecture} arch
 * @returns {string | undefined}
 */
export function findClaudeSdkCliPath(serverCjsOut, platform, arch) {
  const binName = platform === "win32" ? "claude.exe" : "claude";
  const serverDir = dirname(serverCjsOut);
  for (const platformPkg of claudeSdkPlatformPackageCandidates(platform, arch)) {
    const candidate = resolve(serverDir, "node_modules", platformPkg, binName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the installed Claude SDK platform package and CLI binary on the build host.
 *
 * @param {string} serverPackageRoot Root of `apps/server` (directory with `package.json`).
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.Architecture} arch
 */
export function resolveClaudeSdkCliSources(serverPackageRoot, platform, arch) {
  const binName = platform === "win32" ? "claude.exe" : "claude";
  const candidates = claudeSdkPlatformPackageCandidates(platform, arch);
  const failures = [];

  try {
    const serverRequire = createRequire(resolve(serverPackageRoot, "package.json"));
    // Resolve from the SDK package itself: bun keeps platform packages as store
    // siblings of the SDK, not hoisted to the workspace root.
    const sdkEntry = serverRequire.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);

    for (const platformPkg of candidates) {
      try {
        const binSrc = sdkRequire.resolve(`${platformPkg}/${binName}`);
        const packageJsonSrc = resolve(dirname(binSrc), "package.json");
        return { platformPkg, binName, binSrc, packageJsonSrc };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(`${platformPkg}: ${detail}`);
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failures.push(detail);
  }

  const label = candidates.join(" or ");
  throw new Error(
    `${label} not installed - run 'bun install' or node apps/desktop/scripts/ensure-claude-sdk-platform-package.mjs (node_modules out of sync with bun.lock): ${failures.join("; ")}`,
  );
}

/**
 * Copy the Claude Agent SDK native CLI into a directory tree (used by afterPack).
 *
 * @param {object} args
 * @param {string} args.destServerDir Absolute path to packaged `dist/server` (or dev equivalent).
 * @param {string} args.serverPackageRoot Root of `apps/server`.
 * @param {NodeJS.Platform} args.platform Target npm `process.platform` value.
 * @param {NodeJS.Architecture} args.arch Target npm `process.arch` value.
 * @returns {{ platformPkg: string, binDst: string }}
 */
export function copyClaudeSdkCliToDir({ destServerDir, serverPackageRoot, platform, arch }) {
  const { platformPkg, binName, binSrc, packageJsonSrc } = resolveClaudeSdkCliSources(
    serverPackageRoot,
    platform,
    arch,
  );
  const dstPkgDir = resolve(destServerDir, "node_modules", platformPkg);
  const binDst = resolve(dstPkgDir, binName);
  mkdirSync(dstPkgDir, { recursive: true });
  copyFileSync(packageJsonSrc, resolve(dstPkgDir, "package.json"));
  copyFileSync(binSrc, binDst);
  if (platform !== "win32") {
    chmodSync(binDst, 0o755);
  }
  return { platformPkg, binDst };
}

/**
 * Stage the Claude Agent SDK's native CLI binary next to the bundled server entry.
 *
 * SDK >= 0.3 ships the CLI as a platform-specific package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`) and resolves
 * it at runtime via `createRequire(import.meta.url)`. The esbuild bundle rewrites
 * `import.meta.url` to point at `server.cjs`, so the binary must be reachable by
 * walking up from `dist/server/` — i.e. under `dist/server/node_modules/`.
 *
 * The binary is ~230MB; the copy is skipped when the destination already matches
 * the source size so dev rebuilds stay fast.
 *
 * @param {string} serverCjsOut Absolute path to `server.cjs`.
 * @param {string} serverPackageRoot Root of `apps/server` (directory with `package.json`).
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.Architecture} [arch]
 */
export function copyClaudeSdkCliNextTo(
  serverCjsOut,
  serverPackageRoot,
  platform = process.platform,
  arch = process.arch,
) {
  const { platformPkg, binName, binSrc, packageJsonSrc } = resolveClaudeSdkCliSources(
    serverPackageRoot,
    platform,
    arch,
  );
  const dstPkgDir = resolve(dirname(serverCjsOut), "node_modules", platformPkg);
  const binDst = resolve(dstPkgDir, binName);
  mkdirSync(dstPkgDir, { recursive: true });
  copyFileSync(packageJsonSrc, resolve(dstPkgDir, "package.json"));
  if (!existsSync(binDst) || statSync(binDst).size !== statSync(binSrc).size) {
    copyFileSync(binSrc, binDst);
  }
}

/**
 * Produce `apps/desktop/dist/server/server.cjs` from current server sources.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot] Repository root; defaults to the parent of `scripts/`.
 */
export async function rebuildServerDevBundle(options = {}) {
  const repoRoot = options.repoRoot ?? repoRootFromScript();
  const desktopRoot = resolve(repoRoot, "apps/desktop");
  const serverRoot = resolve(repoRoot, "apps/server");
  const serverOutFile = resolve(desktopRoot, "dist/server/server.cjs");

  console.log("[server-dev-bundle] Running tsc (apps/server tsconfig.build)...");
  compileServerWithTsc(serverRoot);

  console.log("[server-dev-bundle] Bundling to dist/server/server.cjs...");
  await build({
    bundle: true,
    platform: "node",
    target: "node20",
    sourcemap: true,
    format: "cjs",
    entryPoints: [resolve(serverRoot, "dist-tsc/index.js")],
    outfile: serverOutFile,
    external: ["better-sqlite3", "node-pty", "electron", "koffi"],
    banner: {
      js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
    define: {
      "import.meta.url": "__importMetaUrl",
    },
  });

  copyClaudeSdkCliNextTo(serverOutFile, serverRoot);

  const drizzleSrc = resolve(serverRoot, "drizzle");
  const drizzleDst = resolve(desktopRoot, "dist/server/drizzle");
  if (existsSync(drizzleSrc)) {
    if (existsSync(drizzleDst)) rmSync(drizzleDst, { recursive: true, force: true });
    cpSync(drizzleSrc, drizzleDst, { recursive: true });
    console.log(`[server-dev-bundle] Copied Drizzle migrations -> ${drizzleDst}`);
  }

  console.log(`[server-dev-bundle] Complete: ${serverOutFile}`);
}
