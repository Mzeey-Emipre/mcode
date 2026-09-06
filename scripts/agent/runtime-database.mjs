/** Validates and marks the worktree-local database snapshot owned by agent setup. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import {
  assertRuntimeDirectorySafe,
  assertRuntimeFileSafe,
  assertRuntimeRootSafe as assertSafeRuntimeRoot,
  ensureRuntimeRoot,
  getRuntimePaths,
} from "./runtime-contract.mjs";

const DATABASE_MARKER = ".agent-runtime-database";
const MARKER_CONTENTS = "agent-runtime-snapshot\n";

/** Rejects a linked runtime root before setup inspects or removes its contents. */
export function assertRuntimeRootSafe(repoRoot) {
  assertSafeRuntimeRoot(repoRoot);
}

/** Prepares safe local paths before SQLite replaces the worktree database. */
export function prepareRuntimeDatabaseSnapshot(repoRoot) {
  assertRuntimeRootSafe(repoRoot);
  const paths = ensureRuntimeRoot(repoRoot);
  assertRuntimeDirectorySafe(paths.dbDir, "database directory", true);
  assertRuntimeFileSafe(paths.dbPath, "database", true);
  assertRuntimeFileSafe(NodePath.join(paths.dbDir, DATABASE_MARKER), "database marker", true);
  return paths;
}

/** Marks a safely copied local database as owned by setup. */
export function markRuntimeDatabase(repoRoot) {
  assertRuntimeRootSafe(repoRoot);
  const paths = getRuntimePaths(repoRoot);
  assertRuntimeDirectorySafe(paths.devDir, "runtime directory");
  assertRuntimeDirectorySafe(paths.dbDir, "database directory");
  assertRuntimeFileSafe(paths.dbPath, "database");
  const markerPath = NodePath.join(paths.dbDir, DATABASE_MARKER);
  assertRuntimeFileSafe(markerPath, "database marker", true);
  const temporaryMarkerPath = NodePath.join(paths.dbDir, `.${DATABASE_MARKER}.${NodeCrypto.randomUUID()}`);
  try {
    NodeFS.writeFileSync(temporaryMarkerPath, MARKER_CONTENTS, { encoding: "utf8", flag: "wx", mode: 0o600 });
    NodeFS.renameSync(temporaryMarkerPath, markerPath);
  } finally {
    NodeFS.rmSync(temporaryMarkerPath, { force: true });
  }
  if (!hasRuntimeDatabaseMarker(repoRoot)) throw new Error("The local database marker is invalid.");
  return paths.dbPath;
}

/** Returns whether setup created the local database. */
export function hasRuntimeDatabaseMarker(repoRoot) {
  try {
    assertRuntimeRootSafe(repoRoot);
  } catch {
    return false;
  }
  const { dbDir, dbPath } = getRuntimePaths(repoRoot);
  const markerPath = NodePath.join(dbDir, DATABASE_MARKER);
  try {
    assertRuntimeDirectorySafe(dbDir, "database directory");
    assertRuntimeFileSafe(dbPath, "database");
    assertRuntimeFileSafe(markerPath, "database marker");
    return NodeFS.readFileSync(markerPath, "utf8") === MARKER_CONTENTS;
  } catch {
    return false;
  }
}
