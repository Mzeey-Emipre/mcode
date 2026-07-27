/** Tests workspace CLI entry containment in the Electron Node wrapper. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const wrapper = "scripts/run-electron-node.mjs";
const options = {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 60_000,
};

function runWorkspaceCli(entryFile) {
  return spawnSync(
    process.execPath,
    [wrapper, "--workspace-cli", "better-sqlite3", entryFile],
    options,
  );
}

test("workspace CLI accepts a nested package entry", () => {
  const result = runWorkspaceCli("lib/index.js");

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("workspace CLI preserves missing-entry errors", () => {
  const result = runWorkspaceCli("missing-entry.mjs");

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workspace CLI entry not found/);
});

test("workspace CLI rejects entries outside the package directory", () => {
  const result = runWorkspaceCli("../package.json");

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workspace CLI entry must stay inside its package directory/);
});
