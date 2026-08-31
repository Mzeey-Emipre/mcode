/**
 * Tests for scripts/db-seed.mjs database snapshotting logic.
 */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { Database } from "bun:sqlite";

import { seedDatabase } from "../../db-seed.mjs";

function safeCleanup(dir) {
  try {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows file locks may linger slightly; ignore or retry
  }
}

NodeTest.test("seedDatabase snapshots a SQLite database using VACUUM INTO", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-seed-test-"));
  const sourcePath = NodePath.join(tempDir, "source.db");
  const targetPath = NodePath.join(tempDir, "target.db");

  try {
    const sourceDb = new Database(sourcePath);
    sourceDb.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT);");
    sourceDb.run("INSERT INTO workspaces VALUES ('ws-1', 'Main Workspace'), ('ws-2', 'Second Workspace');");
    sourceDb.run("CREATE TABLE threads (id TEXT PRIMARY KEY);");
    sourceDb.run("INSERT INTO threads VALUES ('th-1'), ('th-2'), ('th-3');");
    sourceDb.close(true);

    const result = seedDatabase({ source: sourcePath, target: targetPath });

    NodeAssertStrict.default.equal(result.sourcePath, sourcePath);
    NodeAssertStrict.default.equal(result.targetPath, targetPath);
    NodeAssertStrict.default.equal(NodeFS.existsSync(targetPath), true);
    NodeAssertStrict.default.equal(result.stats.workspaces, 2);
    NodeAssertStrict.default.equal(result.stats.threads, 3);

    // Verify target can be read independently
    const targetDb = new Database(targetPath, { readonly: true });
    const stmt = targetDb.prepare("SELECT COUNT(*) as count FROM workspaces");
    const row = stmt.get();
    stmt.finalize();
    NodeAssertStrict.default.equal(row.count, 2);
    targetDb.close(true);
  } finally {
    safeCleanup(tempDir);
  }
});

NodeTest.test("seedDatabase overwrites existing target cleanly without throwing", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-seed-overwrite-"));
  const sourcePath = NodePath.join(tempDir, "source.db");
  const targetPath = NodePath.join(tempDir, "target.db");

  try {
    const sourceDb = new Database(sourcePath);
    sourceDb.run("CREATE TABLE messages (id TEXT PRIMARY KEY);");
    sourceDb.run("INSERT INTO messages VALUES ('msg-1');");
    sourceDb.close(true);

    // Create a preexisting target
    const existingDb = new Database(targetPath);
    existingDb.run("CREATE TABLE dummy (id TEXT);");
    existingDb.close(true);

    const result = seedDatabase({ source: sourcePath, target: targetPath });
    NodeAssertStrict.default.equal(result.stats.messages, 1);
  } finally {
    safeCleanup(tempDir);
  }
});
