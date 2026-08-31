/** Tests the db:info Electron wrapper against a real temporary SQLite database. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

NodeTest.test("db:info opens a SQLite database through Electron Node", { timeout: 75_000 }, () => {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-info-"));
  const dbPath = NodePath.join(dataDir, "mcode.db");
  const env = { ...process.env, MCODE_DB_PATH: dbPath };
  const electronRequire = NodeModule.createRequire(NodePath.join(process.cwd(), "apps", "desktop", "package.json"));
  const electronBinary = electronRequire("electron");

  try {
    const createDatabase = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "scripts/run-electron-node.mjs",
        "-e",
        "const { createRequire } = require('module'); const Database = createRequire(process.cwd() + '/apps/server/package.json')('better-sqlite3'); const db = new Database(process.env.MCODE_DB_PATH, { nativeBinding: process.env.BETTER_SQLITE3_BINDING }); db.exec('CREATE TABLE _migrations (version INTEGER); INSERT INTO _migrations VALUES (7); CREATE TABLE workspaces (id TEXT); CREATE TABLE threads (id TEXT); CREATE TABLE messages (id TEXT);'); db.close();",
      ],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
    );
    NodeAssertStrict.default.equal(createDatabase.error, undefined);
    NodeAssertStrict.default.equal(createDatabase.status, 0, createDatabase.stderr);

    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["scripts/run-electron-node.mjs", "scripts/db-info.mjs"],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
    );

    NodeAssertStrict.default.equal(result.error, undefined);
    NodeAssertStrict.default.equal(result.status, 0, result.stderr);
    NodeAssertStrict.default.match(result.stdout, /Schema   : v7/);
    NodeAssertStrict.default.match(result.stdout, /workspaces: 0 rows/);

    const missingBindingEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    delete missingBindingEnv.BETTER_SQLITE3_BINDING;
    const missingBinding = NodeChildProcess.spawnSync(
      electronBinary,
      ["scripts/db-info.mjs"],
      { cwd: process.cwd(), env: missingBindingEnv, encoding: "utf8", timeout: 60_000 },
    );
    NodeAssertStrict.default.equal(missingBinding.error, undefined);
    NodeAssertStrict.default.equal(missingBinding.status, 1, missingBinding.stderr);
    NodeAssertStrict.default.match(missingBinding.stderr, /BETTER_SQLITE3_BINDING is required/);

    const invalidBinding = NodeChildProcess.spawnSync(
      electronBinary,
      ["scripts/db-info.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: "1",
          BETTER_SQLITE3_BINDING: NodePath.join(dataDir, "missing.node"),
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    NodeAssertStrict.default.equal(invalidBinding.error, undefined);
    NodeAssertStrict.default.equal(invalidBinding.status, 1, invalidBinding.stderr);
    NodeAssertStrict.default.match(invalidBinding.stderr, /must reference an existing absolute file/);
  } finally {
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  }
});
