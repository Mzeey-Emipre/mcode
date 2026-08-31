import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import {
  collectStringValues,
  findProtectedEnvPaths,
  isProtectedEnvPath,
} from "../hooks/block-env-edits.mjs";

const SCRIPT_PATH = NodePath.resolve("scripts/agent/hooks/block-env-edits.mjs");

NodeTest.default("isProtectedEnvPath blocks direct env files and variants", () => {
  NodeAssertStrict.default.equal(isProtectedEnvPath(".env"), true);
  NodeAssertStrict.default.equal(isProtectedEnvPath("apps/server/.env.local"), true);
  NodeAssertStrict.default.equal(isProtectedEnvPath("C:\\repo\\.env.production"), true);
});

NodeTest.default("isProtectedEnvPath allows .env.example", () => {
  NodeAssertStrict.default.equal(isProtectedEnvPath(".env.example"), false);
  NodeAssertStrict.default.equal(isProtectedEnvPath("apps/server/.env.example"), false);
});

NodeTest.default("collectStringValues walks nested hook payloads", () => {
  NodeAssertStrict.default.deepEqual(
    collectStringValues({ path: ".env", nested: ["safe", { file: ".env.local" }] }),
    [".env", "safe", ".env.local"],
  );
});

NodeTest.default("findProtectedEnvPaths parses JSON tool input", () => {
  const input = JSON.stringify({
    path: ".env",
    updates: [{ path: ".env.example" }, { path: "apps/web/.env.local" }],
  });

  NodeAssertStrict.default.deepEqual(findProtectedEnvPaths(input), [".env", "apps/web/.env.local"]);
});

NodeTest.default("codex mode emits block JSON and exits zero", () => {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [SCRIPT_PATH, "--codex"],
    {
      env: { ...process.env, TOOL_INPUT: JSON.stringify({ path: ".env" }) },
      encoding: "utf8",
    },
  );

  NodeAssertStrict.default.deepEqual(JSON.parse(output), {
    decision: "block",
    reason: "Do not edit .env files directly. Update .env.example instead.",
  });
});

NodeTest.default("non-codex mode exits 2 for protected env files", () => {
  NodeAssertStrict.default.throws(
    () =>
      NodeChildProcess.execFileSync(process.execPath, [SCRIPT_PATH], {
        env: { ...process.env, TOOL_INPUT: JSON.stringify({ path: ".env.local" }) },
        encoding: "utf8",
        stdio: "pipe",
      }),
    (err) => err.status === 2,
  );
});

NodeTest.default("script allows .env.example", () => {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [SCRIPT_PATH, "--codex"],
    {
      env: { ...process.env, TOOL_INPUT: JSON.stringify({ path: ".env.example" }) },
      encoding: "utf8",
    },
  );

  NodeAssertStrict.default.equal(output, "");
});
