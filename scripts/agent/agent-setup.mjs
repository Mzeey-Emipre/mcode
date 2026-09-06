#!/usr/bin/env bun
/**
 * Provisions the per-worktree agent runtime: database snapshot, fixture repo, and bundles.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { isFixtureRepo, seedFixtureRepo } from "./fixture-repo.mjs";
import {
  assertRuntimeDirectorySafe,
  assertRuntimeFileSafe,
  assertRuntimeRootSafe,
  getRuntimePaths,
  resolveRepoRoot,
} from "./runtime-contract.mjs";
import { markRuntimeDatabase, prepareRuntimeDatabaseSnapshot } from "./runtime-database.mjs";
import { MANAGED_DESKTOP_SESSION_FILE } from "./managed-desktop.mjs";
import { rebuildServerDevBundle } from "../build-server-dev-bundle.mjs";
import { seedDatabase } from "../db-seed.mjs";

let agentSetupTestHooks = {};

/**
 * Installs process-local hooks for focused agentSetup tests.
 *
 * @param {Partial<{
 *   seedDatabase: typeof seedDatabase,
 *   seedFixtureRepo: typeof seedFixtureRepo,
 *   isFixtureRepo: typeof isFixtureRepo,
 *   rebuildServerDevBundle: typeof rebuildServerDevBundle,
 *   buildDesktopMain: typeof buildDesktopMain,
 * }>} hooks
 * @returns {() => void}
 */
export function setAgentSetupTestHooks(hooks) {
  agentSetupTestHooks = hooks;
  return () => {
    agentSetupTestHooks = {};
  };
}

/**
 * Runs the one-time provisioning steps for the agent runtime.
 *
 * @param {string} [repoRoot]
 * @returns {Promise<void>}
 */
export async function agentSetup(repoRoot = resolveRepoRoot()) {
  const operations = getSetupOperations();

  assertRuntimeStopped(repoRoot);
  refreshRuntimeDatabase(repoRoot, operations.seedDb, operations.markDatabase);
  if (!operations.fixtureIsReady(repoRoot)) {
    operations.seedFixture(repoRoot);
  }
  await operations.rebuildBundle({ repoRoot });
  await operations.buildMain(repoRoot);
}

function getSetupOperations() {
  return {
    seedDb: agentSetupTestHooks.seedDatabase ?? seedDatabase,
    markDatabase: agentSetupTestHooks.markRuntimeDatabase ?? markRuntimeDatabase,
    seedFixture: agentSetupTestHooks.seedFixtureRepo ?? seedFixtureRepo,
    fixtureIsReady: agentSetupTestHooks.isFixtureRepo ?? isFixtureRepo,
    rebuildBundle: agentSetupTestHooks.rebuildServerDevBundle ?? rebuildServerDevBundle,
    buildMain: agentSetupTestHooks.buildDesktopMain ?? buildDesktopMain,
  };
}

/** Refreshes the local SQLite snapshot through SQLite's safe backup path. */
export function refreshRuntimeDatabase(repoRoot, snapshot = seedDatabase, markDatabase = markRuntimeDatabase) {
  const paths = prepareRuntimeDatabaseSnapshot(repoRoot);
  snapshot({ repoRoot, target: paths.dbPath });
  markDatabase(repoRoot);
}

function assertRuntimeStopped(repoRoot) {
  const { devDir, pidsDir } = getRuntimePaths(repoRoot);
  assertRuntimeRootSafe(repoRoot);
  assertRuntimeDirectorySafe(pidsDir, "runtime PID directory", true);
  assertRuntimeFileSafe(NodePath.join(devDir, MANAGED_DESKTOP_SESSION_FILE), "desktop session", true);
  if (NodeFS.existsSync(pidsDir) && NodeFS.readdirSync(pidsDir).some((name) => name.endsWith(".pid"))) {
    throw new Error("Stop the agent runtime before agent:setup refreshes the local database.");
  }
  if (NodeFS.existsSync(NodePath.join(devDir, MANAGED_DESKTOP_SESSION_FILE))) {
    throw new Error("Stop the agent runtime before agent:setup refreshes the local database.");
  }
}

async function buildDesktopMain(repoRoot) {
  await new Promise((resolveBuild, rejectBuild) => {
    NodeChildProcess.execFile(process.execPath, ["scripts/build-main.mjs", "--main-only"], {
      cwd: NodePath.join(repoRoot, "apps", "desktop"),
      env: process.env,
      windowsHide: true,
    }, (error) => error ? rejectBuild(error) : resolveBuild());
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : resolveRepoRoot();
  await agentSetup(repoRoot);
}
