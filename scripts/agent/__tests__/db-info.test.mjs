/** Tests the db:info Electron wrapper against a real temporary SQLite database. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("db:info opens a SQLite database through Electron Node", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcode-db-info-"));
  const dbPath = join(dataDir, "mcode.db");
  const env = { ...process.env, MCODE_DB_PATH: dbPath };
  const electronRequire = createRequire(join(process.cwd(), "apps", "desktop", "package.json"));
  const electronBinary = electronRequire("electron");

  try {
    const createDatabase = spawnSync(
      process.execPath,
      [
        "scripts/run-electron-node.mjs",
        "-e",
        "const { createRequire } = require('module'); const Database = createRequire(process.cwd() + '/apps/server/package.json')('better-sqlite3'); const db = new Database(process.env.MCODE_DB_PATH, { nativeBinding: process.env.BETTER_SQLITE3_BINDING }); db.exec('CREATE TABLE _migrations (version INTEGER); INSERT INTO _migrations VALUES (7); CREATE TABLE workspaces (id TEXT); CREATE TABLE threads (id TEXT); CREATE TABLE messages (id TEXT);'); db.close();",
      ],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(createDatabase.error, undefined);
    assert.equal(createDatabase.status, 0, createDatabase.stderr);

    const result = spawnSync(
      process.execPath,
      ["scripts/run-electron-node.mjs", "scripts/db-info.mjs"],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Schema   : v7/);
    assert.match(result.stdout, /workspaces: 0 rows/);

    const missingBindingEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    delete missingBindingEnv.BETTER_SQLITE3_BINDING;
    const missingBinding = spawnSync(
      electronBinary,
      ["scripts/db-info.mjs"],
      { cwd: process.cwd(), env: missingBindingEnv, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(missingBinding.error, undefined);
    assert.equal(missingBinding.status, 1, missingBinding.stderr);
    assert.match(missingBinding.stderr, /BETTER_SQLITE3_BINDING is required/);

    const invalidBinding = spawnSync(
      electronBinary,
      ["scripts/db-info.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: "1",
          BETTER_SQLITE3_BINDING: join(dataDir, "missing.node"),
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(invalidBinding.error, undefined);
    assert.equal(invalidBinding.status, 1, invalidBinding.stderr);
    assert.match(invalidBinding.stderr, /must reference an existing absolute file/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
