/**
 * Tests for scripts/db-seed.mjs database snapshotting logic.
 */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { Database } from "bun:sqlite";

import { seedDatabase, seedDatabaseForStartup } from "../../db-seed.mjs";

function safeCleanup(dir) {
  try {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows file locks may linger slightly; ignore or retry
  }
}

function withoutWarnings(callback) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
}

NodeTest.test("seedDatabaseForStartup snapshots an available SQLite database", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-seed-test-"));
  const sourcePath = NodePath.join(tempDir, "source.db");
  const targetPath = NodePath.join(tempDir, "target", "target.db");

  try {
    const sourceDb = new Database(sourcePath);
    sourceDb.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT);");
    sourceDb.run("INSERT INTO workspaces VALUES ('ws-1', 'Main Workspace'), ('ws-2', 'Second Workspace');");
    sourceDb.run("CREATE TABLE threads (id TEXT PRIMARY KEY);");
    sourceDb.run("INSERT INTO threads VALUES ('th-1'), ('th-2'), ('th-3');");
    sourceDb.close(true);

    seedDatabaseForStartup({ source: sourcePath, target: targetPath });
    NodeAssertStrict.default.equal(NodeFS.existsSync(targetPath), true);

    const targetDb = new Database(targetPath, { readonly: true });
    try {
      NodeAssertStrict.default.equal(targetDb.query("SELECT COUNT(*) as count FROM workspaces").get().count, 2);
      NodeAssertStrict.default.equal(targetDb.query("SELECT COUNT(*) as count FROM threads").get().count, 3);
    } finally {
      targetDb.close(true);
    }
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

NodeTest.test("seedDatabaseForStartup keeps an existing development database for dev:web", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-seed-existing-"));
  const sourcePath = NodePath.join(tempDir, "source.db");
  const targetPath = NodePath.join(tempDir, "target.db");

  try {
    const sourceDb = new Database(sourcePath);
    sourceDb.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY);");
    sourceDb.run("INSERT INTO workspaces VALUES ('from-source');");
    sourceDb.close(true);
    NodeFS.writeFileSync(targetPath, "existing-development-data");

    withoutWarnings(() => seedDatabaseForStartup({
      source: sourcePath,
      target: targetPath,
      preserveExistingTarget: true,
    }));

    NodeAssertStrict.default.equal(NodeFS.readFileSync(targetPath, "utf8"), "existing-development-data");
  } finally {
    safeCleanup(tempDir);
  }
});

for (const { name, prepareSource } of [
  { name: "unavailable", prepareSource: () => {} },
  { name: "invalid", prepareSource: (sourcePath) => NodeFS.writeFileSync(sourcePath, "not a SQLite database") },
]) {
  NodeTest.test(`seedDatabaseForStartup keeps an existing database when the source is ${name}`, () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `mcode-db-seed-${name}-`));
    const sourcePath = NodePath.join(tempDir, "source.db");
    const targetPath = NodePath.join(tempDir, "target.db");

    try {
      prepareSource(sourcePath);
      NodeFS.writeFileSync(targetPath, "existing-development-data");

      withoutWarnings(() => seedDatabaseForStartup({ source: sourcePath, target: targetPath }));

      NodeAssertStrict.default.equal(NodeFS.readFileSync(targetPath, "utf8"), "existing-development-data");
    } finally {
      safeCleanup(tempDir);
    }
  });
}
