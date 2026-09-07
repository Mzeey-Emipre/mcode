import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { assertRuntimeFreshness, isOpenCodeSessionInvalidatedEvent, isRuntimeHarnessEvidenceFile, runBun } from "./runtime.mjs";

const CLI = NodePath.join(import.meta.dirname, "verify-mcode.mjs");
const BROWSER_PROOF = NodePath.join(import.meta.dirname, "browser-opencode-proof.mjs");
const BUN = process.env.BUN_EXE || "bun";

function runBunCommand(args) {
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
  const help = await runBunCommand([CLI, "runtime", "--help"]);
  const invalid = await runBunCommand([
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

NodeTest.test("rejects invalid runtime check phases before any check runs", async () => {
  const unknown = await runBunCommand([CLI, "runtime", "check", "--phase", "unknown"]);
  const missing = await runBunCommand([CLI, "runtime", "check", "--phase"]);
  const repeated = await runBunCommand([CLI, "runtime", "check", "--phase", "contract", "--phase", "contract"]);

  NodeAssertStrict.equal(unknown.code, 1);
  NodeAssertStrict.match(unknown.stdout, /--phase must be runtime, provider, contract, or ui/);
  NodeAssertStrict.equal(missing.code, 1);
  NodeAssertStrict.match(missing.stdout, /Missing value for --phase/);
  NodeAssertStrict.equal(repeated.code, 1);
  NodeAssertStrict.match(repeated.stdout, /Duplicate phase contract/);
});

NodeTest.test("hides Windows consoles for verification check subprocesses", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-run-bun-"));
  const logPath = NodePath.join(directory, "check.log");
  const bun = globalThis.Bun;
  let options;
  globalThis.Bun = {
    ...bun,
    spawn(value) {
      options = value;
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    },
  };

  try {
    const result = await runBun(directory, ["--version"], logPath);
    NodeAssertStrict.equal(result.exitCode, 0);
    NodeAssertStrict.equal(options.windowsHide, true);
  } finally {
    globalThis.Bun = bun;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

NodeTest.test("runtime freshness includes bundled workspace dependencies but ignores test-only and unrelated files", () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-freshness-"));
  const now = Date.now();
  const bundle = NodePath.join(repo, "apps", "desktop", "dist", "server", "server.cjs");
  const ports = NodePath.join(repo, ".dev", "ports.json");
  const threadDependency = NodePath.join(repo, "packages", "thread-orchestration", "src", "guide.ts");
  const modelDependency = NodePath.join(repo, "packages", "agent-model", "src", "guide.ts");
  const dependencyTest = NodePath.join(repo, "packages", "agent-model", "src", "guide.test.ts");
  const unrelated = NodePath.join(repo, "packages", "unrelated", "src", "guide.ts");

  try {
    writeTimestampedFile(bundle, now);
    writeTimestampedFile(ports, now);
    writeTimestampedFile(threadDependency, now + 5_000);
    NodeAssertStrict.throws(() => assertRuntimeFreshness(repo), /packages\/thread-orchestration\/src\/guide\.ts/);

    NodeFS.rmSync(threadDependency);
    writeTimestampedFile(modelDependency, now);
    NodeAssertStrict.doesNotThrow(() => assertRuntimeFreshness(repo));
    writeTimestampedFile(modelDependency, now + 5_000);
    NodeAssertStrict.throws(() => assertRuntimeFreshness(repo), /packages\/agent-model\/src\/guide\.ts/);

    NodeFS.rmSync(modelDependency);
    writeTimestampedFile(dependencyTest, now + 5_000);
    writeTimestampedFile(unrelated, now + 5_000);
    NodeAssertStrict.doesNotThrow(() => assertRuntimeFreshness(repo));
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("requires confirmation before the browser proof starts Electron", async () => {
  const help = await runBunCommand([BROWSER_PROOF, "--help"]);
  const missingConfirmation = await runBunCommand([BROWSER_PROOF]);

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

NodeTest.test("recognizes the provider-neutral OpenCode session invalidation subtype", () => {
  NodeAssertStrict.equal(isOpenCodeSessionInvalidatedEvent({ type: "system", subtype: "sdk_session_invalidated" }), true);
  NodeAssertStrict.equal(isOpenCodeSessionInvalidatedEvent({ type: "system", subtype: "opencode:session-recreated" }), false);
});

function writeTimestampedFile(path, modifiedMs) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "fixture\n");
  NodeFS.utimesSync(path, modifiedMs / 1_000, modifiedMs / 1_000);
}
