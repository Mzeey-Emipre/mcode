/**
 * Tests for root package development entry points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverAgentTestFiles } from "../test-scripts.mjs";

test("root dev uses the paired dev:web runtime", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

  assert.equal(packageJson.scripts.dev, "bun scripts/dev-web.mjs");
});

test("root dev:server runs only the Electron-backed server launcher", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

  assert.equal(packageJson.scripts["dev:server"], "bun scripts/dev-web.mjs --server-only");
});

test("root db:info dispatches to the Electron SQLite runtime", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

  assert.equal(packageJson.scripts["db:info"], "bun scripts/db-info.mjs");
});

test("repository orchestration scripts use Bun without a system Node contract", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  for (const name of [
    "postinstall",
    "setup",
    "doctor",
    "dev:web",
    "dev:server",
    "test",
    "test:scripts",
    "verify",
    "verify:changed",
    "agent:up",
    "agent:down",
    "agent:reset",
  ]) {
    assert.doesNotMatch(packageJson.scripts[name], /\bnode(?:\.exe)?\b/);
  }
  assert.equal(packageJson.engines, undefined);
});

test("maintained test discovery fails when no tests exist", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "mcode-agent-tests-"));
  try {
    assert.throws(
      () => discoverAgentTestFiles(directory),
      /No agent tests found/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
