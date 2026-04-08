/**
 * CI-only helper that packages the desktop app with electron-builder.
 *
 * Solves two problems:
 *  1. electron-builder detects bun from PATH/lockfile and incorrectly invokes
 *     it via Node.js. We strip bun directories from PATH so it falls back to npm.
 *  2. npm does not support bun's workspace:* protocol. We strip workspace:*
 *     references but keep real-versioned deps (better-sqlite3, node-pty) so
 *     electron-builder can install and rebuild the native bindings for the
 *     target platform.
 *
 * Usage: node apps/desktop/scripts/ci-package.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const pkgPath = resolve(desktopRoot, "package.json");

// ---------------------------------------------------------------------------
// 1. Strip workspace:* deps — npm cannot install them. Keep real-versioned
//    deps (better-sqlite3, node-pty) so electron-builder installs and rebuilds
//    their native bindings. All other server JS is bundled into server.cjs.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const filteredDeps = {};
for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
  if (!String(version).startsWith("workspace:")) {
    filteredDeps[name] = version;
  }
}
pkg.dependencies = filteredDeps;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("[ci-package] Stripped workspace:* dependencies from package.json");

// ---------------------------------------------------------------------------
// 2. Create a minimal package-lock.json to anchor npm in this directory and
//    prevent it from walking up to the monorepo root's bun.lock
// ---------------------------------------------------------------------------

const lockfile = {
  name: pkg.name,
  version: pkg.version,
  lockfileVersion: 3,
  packages: {},
};
writeFileSync(
  resolve(desktopRoot, "package-lock.json"),
  JSON.stringify(lockfile, null, 2) + "\n",
);
console.log("[ci-package] Created minimal package-lock.json");

// ---------------------------------------------------------------------------
// 3. Strip workspaces from root package.json so npm does not detect a
//    workspace context and try to resolve workspace:* references from
//    sibling packages. Safe to do in CI after bun install has completed.
// ---------------------------------------------------------------------------

const rootPkgPath = resolve(desktopRoot, "../../package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
delete rootPkg.workspaces;
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
console.log("[ci-package] Stripped workspaces from root package.json");

// ---------------------------------------------------------------------------
// 4. Remove bun from PATH so electron-builder falls back to npm
// ---------------------------------------------------------------------------

const sep = process.platform === "win32" ? ";" : ":";
const filteredPath = process.env.PATH.split(sep)
  .filter((p) => !p.includes(".bun"))
  .join(sep);

console.log("[ci-package] Running electron-builder (npm fallback)...");

// Run the electron-builder CLI entry point via node directly. This avoids
// platform-specific .bin shim issues (.cmd on Windows, hoisting to root).
const localCli = resolve(desktopRoot, "node_modules/electron-builder/out/cli/cli.js");
const rootCli = resolve(desktopRoot, "../../node_modules/electron-builder/out/cli/cli.js");
const ebCli = existsSync(localCli) ? localCli : rootCli;

execFileSync(process.execPath, [ebCli, "--publish", "never"], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: { ...process.env, PATH: filteredPath },
});
