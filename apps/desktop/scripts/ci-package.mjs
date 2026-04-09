/**
 * CI-only helper that packages the desktop app with electron-builder.
 *
 * Solves three problems:
 *  1. electron-builder detects bun from PATH/lockfile and incorrectly invokes
 *     it via Node.js. We strip bun directories from PATH so it falls back to npm.
 *  2. npm does not support bun's workspace:* protocol. We strip workspace:*
 *     references but keep real-versioned deps (better-sqlite3, node-pty) so
 *     electron-builder can install and rebuild the native bindings for the
 *     target platform.
 *  3. bun hoists native deps to sibling workspaces. We run `npm install` to
 *     get them into apps/desktop/node_modules so electron-builder can rebuild
 *     them for Electron and asarUnpack them.
 *
 * Usage: node apps/desktop/scripts/ci-package.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const pkgPath = resolve(desktopRoot, "package.json");

// ---------------------------------------------------------------------------
// 1. Strip workspace:* deps — npm cannot install them. Keep real-versioned
//    deps (better-sqlite3, node-pty) so npm installs and electron-builder
//    rebuilds their native bindings. All other server JS is bundled in server.cjs.
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

// ---------------------------------------------------------------------------
// 5. Install native dependencies into apps/desktop/node_modules. bun hoists
//    them to apps/server/node_modules during monorepo install, but
//    electron-builder needs them here for @electron/rebuild and asarUnpack.
// ---------------------------------------------------------------------------

console.log("[ci-package] Installing native dependencies with npm...");
execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: { ...process.env, PATH: filteredPath },
  shell: true,
});

// ---------------------------------------------------------------------------
// 6. Resolve electron-builder CLI AFTER npm install. npm install replaces
//    bun's symlinked node_modules, so the CLI must be found in npm's layout.
// ---------------------------------------------------------------------------

function findEbCli() {
  const candidates = [
    resolve(desktopRoot, "node_modules/electron-builder/out/cli/cli.js"),
    resolve(desktopRoot, "../../node_modules/electron-builder/out/cli/cli.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // bun stores packages in node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/
  const bunDir = resolve(desktopRoot, "../../node_modules/.bun");
  if (existsSync(bunDir)) {
    for (const entry of readdirSync(bunDir)) {
      if (entry.startsWith("electron-builder@")) {
        const p = resolve(bunDir, entry, "node_modules/electron-builder/out/cli/cli.js");
        if (existsSync(p)) return p;
      }
    }
  }

  throw new Error("[ci-package] electron-builder CLI not found");
}

const ebCli = findEbCli();
console.log(`[ci-package] Resolved electron-builder CLI: ${ebCli}`);

// ---------------------------------------------------------------------------
// 7. Run electron-builder
// ---------------------------------------------------------------------------

console.log("[ci-package] Running electron-builder (npm fallback)...");
execFileSync(process.execPath, [ebCli, "--publish", "never"], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: { ...process.env, PATH: filteredPath },
});
