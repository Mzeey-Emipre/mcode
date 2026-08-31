#!/usr/bin/env bun
/** Inspects the changed-file receipt and maps a block to Cursor exit code 2. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const script = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "verify-tests.mjs");
const result = NodeChildProcess.spawnSync(process.execPath, [script, "--check-receipt"], {
  cwd: process.cwd(),
  stdio: "inherit",
  timeout: 10_000,
  windowsHide: true,
});

if (result.status === 0) process.exit(0);
console.error(result.error?.code === "ETIMEDOUT"
  ? "BLOCK: verification receipt check timed out."
  : "BLOCK: verification receipt missing, stale, or failed. See the evidence above.");
process.exit(2);
