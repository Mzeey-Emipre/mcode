#!/usr/bin/env bun
/**
 * Safely snapshot a real production or dev database into the test/worktree sandbox.
 * Uses SQLite VACUUM INTO for online, corruption-safe single-file replication.
 */
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { Database } from "bun:sqlite";

import { getRuntimePaths, resolveRepoRoot } from "./agent/runtime-contract.mjs";

/**
 * Resolves default source database path (`~/.mcode/mcode.db` or `~/.mcode-dev/mcode.db`).
 *
 * @param {string} [preferredSource]
 * @returns {string}
 */
export function resolveSourceDbPath(preferredSource) {
  if (preferredSource) return NodePath.resolve(preferredSource);

  const prodPath = NodePath.join(NodeOS.homedir(), ".mcode", "mcode.db");
  if (NodeFS.existsSync(prodPath)) return prodPath;

  const devPath = NodePath.join(NodeOS.homedir(), ".mcode-dev", "mcode.db");
  if (NodeFS.existsSync(devPath)) return devPath;

  return prodPath;
}

/**
 * Resolves target database path for the current repository worktree.
 *
 * @param {string} [preferredTarget]
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function resolveTargetDbPath(preferredTarget, repoRoot = resolveRepoRoot()) {
  if (preferredTarget) return NodePath.resolve(preferredTarget);

  const runtime = getRuntimePaths(repoRoot);
  if (NodeFS.existsSync(runtime.devDir)) {
    return runtime.dbPath;
  }

  return NodePath.join(repoRoot, ".mcode-local", "mcode.db");
}

/**
 * Safely deletes old target SQLite files and WAL/SHM artifacts.
 *
 * @param {string} targetPath
 */
function cleanTargetFiles(targetPath) {
  try {
    NodeFS.rmSync(targetPath, { force: true });
    NodeFS.rmSync(`${targetPath}-wal`, { force: true });
    NodeFS.rmSync(`${targetPath}-shm`, { force: true });
  } catch (err) {
    if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
      throw new Error(
        `Target database is locked by a running process (${targetPath}). Stop the server ('bun run agent:down') before seeding.`,
      );
    }
    throw err;
  }
}

/**
 * Executes VACUUM INTO to replicate database to target.
 *
 * @param {string} sourcePath
 * @param {string} targetPath
 */
function executeVacuumInto(sourcePath, targetPath) {
  const sourceDb = new Database(sourcePath, { readonly: true });
  try {
    const escapedTarget = targetPath.replace(/'/g, "''");
    sourceDb.run(`VACUUM INTO '${escapedTarget}'`);
  } finally {
    sourceDb.close(true);
  }
}

/**
 * Reads row counts for key tables in seeded database.
 *
 * @param {string} targetPath
 * @returns {Record<string, number>}
 */
function collectTableStats(targetPath) {
  const stats = {};
  if (!NodeFS.existsSync(targetPath)) return stats;

  const targetDb = new Database(targetPath, { readonly: true });
  try {
    for (const table of ["workspaces", "threads", "messages", "settings"]) {
      try {
        const stmt = targetDb.prepare(`SELECT COUNT(*) as count FROM ${table}`);
        const row = stmt.get();
        stmt.finalize();
        if (row && typeof row.count === "number") {
          stats[table] = row.count;
        }
      } catch {
        // Table may not exist in older schemas
      }
    }
  } finally {
    targetDb.close(true);
  }

  return stats;
}

/**
 * Snapshots the source SQLite database into the target location via VACUUM INTO.
 *
 * @param {{ source?: string, target?: string, repoRoot?: string }} [options]
 * @returns {{ sourcePath: string, targetPath: string, stats: Record<string, number> }}
 */
export function seedDatabase(options = {}) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const sourcePath = resolveSourceDbPath(options.source);
  const targetPath = resolveTargetDbPath(options.target, repoRoot);

  if (!NodeFS.existsSync(sourcePath)) {
    throw new Error(`Source database not found at: ${sourcePath}`);
  }

  NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });
  const temporaryTargetPath = NodePath.join(
    NodePath.dirname(targetPath),
    `.${NodePath.basename(targetPath)}.seed-${NodeCrypto.randomUUID()}`,
  );
  try {
    executeVacuumInto(sourcePath, temporaryTargetPath);
    cleanTargetFiles(targetPath);
    NodeFS.renameSync(temporaryTargetPath, targetPath);
  } finally {
    NodeFS.rmSync(temporaryTargetPath, { force: true });
  }
  const stats = collectTableStats(targetPath);

  return { sourcePath, targetPath, stats };
}

/**
 * Seeds a development database without interrupting startup when the snapshot is unavailable.
 *
 * @param {{ source?: string, target?: string, repoRoot?: string, preserveExistingTarget?: boolean }} [options]
 */
export function seedDatabaseForStartup(options = {}) {
  const targetPath = resolveTargetDbPath(options.target, options.repoRoot);

  if (options.preserveExistingTarget && targetDatabaseExists(targetPath)) {
    console.warn("[database] Seed skipped: the development database already exists.");
    return;
  }

  try {
    seedDatabase(options);
  } catch (error) {
    console.warn(`[database] Seed skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function targetDatabaseExists(targetPath) {
  return [targetPath, `${targetPath}-wal`, `${targetPath}-shm`]
    .some((path) => NodeFS.existsSync(path));
}

/**
 * Parses CLI arguments for source and target options.
 *
 * @param {string[]} args
 * @returns {{ source?: string, target?: string }}
 */
function parseCliArgs(args) {
  let source;
  let target;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      source = args[++i];
    } else if (args[i] === "--target" && args[i + 1]) {
      target = args[++i];
    }
  }

  return { source, target };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { source, target } = parseCliArgs(process.argv.slice(2));

  try {
    const { sourcePath, targetPath, stats } = seedDatabase({ source, target });
    console.log(`Source DB : ${sourcePath}`);
    console.log(`Target DB : ${targetPath}`);
    console.log("Database seeded successfully via VACUUM INTO.");
    if (Object.keys(stats).length > 0) {
      console.log("Row counts:");
      for (const [table, count] of Object.entries(stats)) {
        console.log(`  ${table.padEnd(12)}: ${count}`);
      }
    }
  } catch (err) {
    console.error(`Failed to seed database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
