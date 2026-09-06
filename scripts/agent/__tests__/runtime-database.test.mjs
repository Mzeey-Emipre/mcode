import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { assertRuntimeRootSafe, hasRuntimeDatabaseMarker, markRuntimeDatabase } from "../runtime-database.mjs";
import { getRuntimePaths } from "../runtime-contract.mjs";
import { agentSetup } from "../agent-setup.mjs";

NodeTest.test("runtime database validates its bounded setup marker", () => {
  const repo = makeRepo();
  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.dbDir, { recursive: true });
    NodeFS.writeFileSync(paths.dbPath, "snapshot\n");
    markRuntimeDatabase(repo);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(paths.dbPath, "utf8"), "snapshot\n");
    NodeAssertStrict.default.equal(hasRuntimeDatabaseMarker(repo), true);
    NodeFS.writeFileSync(NodePath.join(paths.dbDir, ".agent-runtime-database"), "other\n");
    NodeAssertStrict.default.equal(hasRuntimeDatabaseMarker(repo), false);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("setup rejects a linked runtime directory without changing its target", async (context) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-database-external-"));
  const externalDb = NodePath.join(external, "db");
  NodeFS.mkdirSync(externalDb);
  const sentinel = NodePath.join(externalDb, "app.sqlite");
  NodeFS.writeFileSync(sentinel, "external data\n");
  try {
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    NodeAssertStrict.default.throws(() => assertRuntimeRootSafe(repo), /runtime directory must not be a link/);
    await NodeAssertStrict.default.rejects(() => agentSetup(repo), /runtime directory must not be a link/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "external data\n");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

function makeRepo() {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-database-"));
  NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), ".dev/\n");
  return repo;
}
