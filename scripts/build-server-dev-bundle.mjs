/**
 * One-shot dev server bundle: `apps/server` tsc emit (`emitDecoratorMetadata`)
 * followed by esbuild CJS bundle to `apps/desktop/dist/server/server.cjs`, plus
 * Claude SDK native CLI binary beside it. Shared by desktop dev orchestration and
 * `scripts/dev-web.mjs` (no `--import tsx` at runtime).
 */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
 */
export function copyClaudeSdkCliNextTo(serverCjsOut, serverPackageRoot) {
  const serverRequire = createRequire(resolve(serverPackageRoot, "package.json"));
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const binName = process.platform === "win32" ? "claude.exe" : "claude";

  // Resolve from the SDK package itself: bun keeps platform packages as store
  // siblings of the SDK, not hoisted to the workspace root.
  const sdkEntry = serverRequire.resolve("@anthropic-ai/claude-agent-sdk");
  const sdkRequire = createRequire(sdkEntry);
  const binSrc = sdkRequire.resolve(`${platformPkg}/${binName}`);

  const dstPkgDir = resolve(dirname(serverCjsOut), "node_modules", platformPkg);
  const binDst = resolve(dstPkgDir, binName);
  mkdirSync(dstPkgDir, { recursive: true });
  copyFileSync(resolve(dirname(binSrc), "package.json"), resolve(dstPkgDir, "package.json"));
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
