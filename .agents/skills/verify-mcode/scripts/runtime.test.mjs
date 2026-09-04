import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { isRuntimeHarnessEvidenceFile } from "./runtime.mjs";

const CLI = NodePath.join(import.meta.dirname, "verify-mcode.mjs");
const BROWSER_PROOF = NodePath.join(import.meta.dirname, "browser-opencode-proof.mjs");
const BUN = process.env.BUN_EXE || "bun";

function runBun(args) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(BUN, args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

NodeTest.test("lists and validates the OpenCode resume proof contract without a provider call", async () => {
  const help = await runBun([CLI, "runtime", "--help"]);
  const invalid = await runBun([
    CLI,
    "runtime",
    "live",
    "--provider", "opencode",
    "--model", "opencode/not-muse",
    "--scenario", "opencode-resume",
    "--confirm-provider-call",
  ]);

  NodeAssertStrict.equal(help.code, 0);
  NodeAssertStrict.match(help.stdout, /opencode-resume/);
  NodeAssertStrict.equal(invalid.code, 1);
  NodeAssertStrict.match(invalid.stdout, /opencode\/muse-spark-1\.3-contributor-free/);
});

NodeTest.test("requires confirmation before the browser proof starts Electron", async () => {
  const help = await runBun([BROWSER_PROOF, "--help"]);
  const missingConfirmation = await runBun([BROWSER_PROOF]);

  NodeAssertStrict.equal(help.code, 0);
  NodeAssertStrict.match(help.stdout, /--confirm-provider-call/);
  NodeAssertStrict.notEqual(missingConfirmation.code, 0);
  NodeAssertStrict.match(missingConfirmation.stderr, /--confirm-provider-call is required/);
});

NodeTest.test("cleans only OpenCode resume artifacts created by the runtime verifier", () => {
  NodeAssertStrict.equal(isRuntimeHarnessEvidenceFile("2026-09-04T12-34-56-789Z-opencode-resume-receipt.json"), true);
  NodeAssertStrict.equal(isRuntimeHarnessEvidenceFile("2026-09-04T12-34-56-789Z-opencode-resume-timeline.html"), true);
  NodeAssertStrict.equal(isRuntimeHarnessEvidenceFile("2026-09-04T12-34-56-789Z-opencode-resume-notes.txt"), false);
});
