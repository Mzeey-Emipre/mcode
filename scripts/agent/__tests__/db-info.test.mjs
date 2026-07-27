/** Tests the db:info Electron wrapper against a real temporary SQLite database. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("db:info opens a SQLite database through Electron Node", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcode-db-info-"));
  const dbPath = join(dataDir, "mcode.db");
  const env = { ...process.env, MCODE_DB_PATH: dbPath };

  try {
    const createDatabase = spawnSync(
      process.execPath,
      [
        "scripts/run-electron-node.mjs",
        "-e",
        "const { createRequire } = require('module'); const Database = createRequire(process.cwd() + '/apps/server/package.json')('better-sqlite3'); const db = new Database(process.env.MCODE_DB_PATH, { nativeBinding: process.env.BETTER_SQLITE3_BINDING }); db.exec('CREATE TABLE _migrations (version INTEGER); INSERT INTO _migrations VALUES (7); CREATE TABLE workspaces (id TEXT); CREATE TABLE threads (id TEXT); CREATE TABLE messages (id TEXT);'); db.close();",
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(createDatabase.status, 0, createDatabase.stderr);

    const result = spawnSync(
      process.execPath,
      ["scripts/run-electron-node.mjs", "scripts/db-info.mjs"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Schema   : v7/);
    assert.match(result.stdout, /workspaces: 0 rows/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
