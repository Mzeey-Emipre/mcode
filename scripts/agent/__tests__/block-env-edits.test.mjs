import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  collectStringValues,
  findProtectedEnvPaths,
  isProtectedEnvPath,
} from "../hooks/block-env-edits.mjs";

const SCRIPT_PATH = resolve("scripts/agent/hooks/block-env-edits.mjs");

test("isProtectedEnvPath blocks direct env files and variants", () => {
  assert.equal(isProtectedEnvPath(".env"), true);
  assert.equal(isProtectedEnvPath("apps/server/.env.local"), true);
  assert.equal(isProtectedEnvPath("C:\\repo\\.env.production"), true);
});

test("isProtectedEnvPath allows .env.example", () => {
  assert.equal(isProtectedEnvPath(".env.example"), false);
  assert.equal(isProtectedEnvPath("apps/server/.env.example"), false);
});

test("collectStringValues walks nested hook payloads", () => {
  assert.deepEqual(
    collectStringValues({ path: ".env", nested: ["safe", { file: ".env.local" }] }),
    [".env", "safe", ".env.local"],
  );
});

test("findProtectedEnvPaths parses JSON tool input", () => {
  const input = JSON.stringify({
    path: ".env",
    updates: [{ path: ".env.example" }, { path: "apps/web/.env.local" }],
  });

  assert.deepEqual(findProtectedEnvPaths(input), [".env", "apps/web/.env.local"]);
});

test("codex mode emits block JSON and exits zero", () => {
  const output = execFileSync(
    process.execPath,
    [SCRIPT_PATH, "--codex"],
    {
      env: { ...process.env, TOOL_INPUT: JSON.stringify({ path: ".env" }) },
      encoding: "utf8",
    },
  );

  assert.deepEqual(JSON.parse(output), {
    decision: "block",
    reason: "Do not edit .env files directly. Update .env.example instead.",
  });
});

test("non-codex mode exits 2 for protected env files", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT_PATH], {
        env: { ...process.env, TOOL_INPUT: JSON.stringify({ path: ".env.local" }) },
        encoding: "utf8",
        stdio: "pipe",
      }),
    (err) => err.status === 2,
  );
});

test("script allows .env.example", () => {
  const output = execFileSync(
    process.execPath,
    [SCRIPT_PATH, "--codex"],
    {
      env: { ...process.env, TOOL_INPUT: JSON.stringify({ path: ".env.example" }) },
      encoding: "utf8",
    },
  );

  assert.equal(output, "");
});
