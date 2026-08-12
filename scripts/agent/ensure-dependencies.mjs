#!/usr/bin/env bun
/** Installs the locked workspace dependencies when node_modules is absent. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function installDependencies(repoRoot) {
  return spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
}

/** Makes the workspace dependencies available before an agent command starts. */
export function ensureDependencies({
  repoRoot = process.cwd(),
  install = installDependencies,
  printer = console.log,
} = {}) {
  const modulesPath = resolve(repoRoot, "node_modules");
  if (existsSync(modulesPath)) return { installed: false };

  printer("Dependencies are missing. Running bun install --frozen-lockfile.");
  const result = install(repoRoot);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Dependency installation failed with exit code ${result.status ?? "unknown"}.`);
  }
  if (!existsSync(modulesPath)) {
    throw new Error("Dependency installation finished, but node_modules is still missing.");
  }
  return { installed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  ensureDependencies({ repoRoot });
}
