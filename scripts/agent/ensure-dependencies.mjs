#!/usr/bin/env bun
/** Installs the locked workspace dependencies when node_modules is absent. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

function installDependencies(repoRoot) {
  return NodeChildProcess.spawnSync("bun", ["install", "--frozen-lockfile"], {
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
  const modulesPath = NodePath.resolve(repoRoot, "node_modules");
  if (NodeFS.existsSync(modulesPath)) return { installed: false };

  printer("Dependencies are missing. Running bun install --frozen-lockfile.");
  const result = install(repoRoot);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Dependency installation failed with exit code ${result.status ?? "unknown"}.`);
  }
  if (!NodeFS.existsSync(modulesPath)) {
    throw new Error("Dependency installation finished, but node_modules is still missing.");
  }
  return { installed: true };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : process.cwd();
  ensureDependencies({ repoRoot });
}
