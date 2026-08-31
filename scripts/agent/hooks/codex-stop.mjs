#!/usr/bin/env bun
/** Inspects the changed-file receipt and emits Codex's stop-hook protocol. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const script = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "verify-tests.mjs");
const result = NodeChildProcess.spawnSync(process.execPath, [script, "--check-receipt"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 10_000,
  windowsHide: true,
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

if (result.status === 0) {
  console.log(JSON.stringify({ decision: "approve", reason: output.slice(-2_000) }));
} else {
  const condition = result.error?.code === "ETIMEDOUT" ? "timed out" : "blocked completion";
  console.log(JSON.stringify({
    decision: "block",
    reason: `Verification receipt check ${condition}. ${output.slice(-4_000)}`.trim(),
  }));
}
