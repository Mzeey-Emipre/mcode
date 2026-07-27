/** Runs a JavaScript CLI with the workspace Electron runtime and SQLite binding. */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const electronRequire = createRequire(resolve(workspaceRoot, "apps", "desktop", "package.json"));
const serverRequire = createRequire(resolve(workspaceRoot, "apps", "server", "package.json"));

function resolveElectronBinding() {
  const betterSqliteDir = dirname(serverRequire.resolve("better-sqlite3/package.json"));
  const bindingPath = join(
    betterSqliteDir,
    "build",
    "Release",
    "better_sqlite3.electron.node",
  );
  if (!existsSync(bindingPath)) {
    throw new Error(`Workspace Electron better-sqlite3 binding not found: ${bindingPath}`);
  }
  return bindingPath;
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length === 0) {
  throw new Error("Expected a JavaScript CLI entry and its arguments.");
}

function resolveWorkspaceCli(args) {
  if (args[0] !== "--workspace-cli") return args;

  const [_, packageName, entryFile, ...entryArgs] = args;
  if (!packageName || !entryFile) {
    throw new Error("Expected a package name and CLI entry after --workspace-cli.");
  }

  const packageDir = dirname(serverRequire.resolve(`${packageName}/package.json`));
  const cliEntry = join(packageDir, entryFile);
  if (!existsSync(cliEntry)) {
    throw new Error(`Workspace CLI entry not found: ${cliEntry}`);
  }

  return [cliEntry, ...entryArgs];
}

const result = spawnSync(electronRequire("electron"), resolveWorkspaceCli(cliArgs), {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    BETTER_SQLITE3_BINDING: resolveElectronBinding(),
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
