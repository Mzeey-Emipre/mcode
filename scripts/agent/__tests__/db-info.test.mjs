/** Tests the Bun db:info command against a real temporary SQLite database. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

NodeTest.test("db:info opens a SQLite database through Bun", { timeout: 75_000 }, () => {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-db-info-"));
  const dbPath = NodePath.join(dataDir, "mcode.db");
  const env = { ...process.env, MCODE_DB_PATH: dbPath };
  try {
    const createDatabase = NodeChildProcess.spawnSync(
      "bun",
      [
        "-e",
        "import { Database } from 'bun:sqlite'; const db = new Database(process.env.MCODE_DB_PATH); db.exec('CREATE TABLE _migrations (version INTEGER); INSERT INTO _migrations VALUES (7); CREATE TABLE workspaces (id TEXT); CREATE TABLE threads (id TEXT); CREATE TABLE messages (id TEXT);'); db.close();",
      ],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
    );
    NodeAssertStrict.default.equal(createDatabase.error, undefined);
    NodeAssertStrict.default.equal(createDatabase.status, 0, createDatabase.stderr);

    const result = NodeChildProcess.spawnSync(
      "bun",
      ["scripts/db-info.mjs"],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 },
    );

    NodeAssertStrict.default.equal(result.error, undefined);
    NodeAssertStrict.default.equal(result.status, 0, result.stderr);
    NodeAssertStrict.default.match(result.stdout, /Schema   : v7/);
    NodeAssertStrict.default.match(result.stdout, /workspaces: 0 rows/);
  } finally {
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  }
});
