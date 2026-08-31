/** Tests for Mcode's verification planner, runner, and hook reuse policy. */
import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  DEFAULT_PHASES,
  FULL_TEST_PHASE,
  MAX_FAILURE_EXCERPT_CHARS,
  MAX_DISPLAYED_ARGV_CHARS,
  MAX_RELATED_FILES,
  MAX_RELATED_ARG_BYTES,
  MAX_RETAINED_OUTPUT_BYTES,
  SCRIPT_TEST_PHASE,
  VERIFICATION_SCHEMA_VERSION,
  calculateVerificationIdentities,
  findReusableResult,
  formatArgvDisplay,
  formatSafeReproduction,
  getChangedFiles,
  inspectVerificationReceipt,
  pathEntriesMatch,
  runPhase,
  runPhasesInParallel,
  runVerification,
  runVerificationPhases,
  selectTestPhases,
  withBunPath,
} from "../verify-tests.mjs";

const BUN = process.execPath;
const VERIFY_SCRIPT = NodeURL.fileURLToPath(new URL("../verify-tests.mjs", import.meta.url));

function bunPhase(name, code, extra = {}) {
  return { name, command: BUN, args: ["-e", code], shell: false, ...extra };
}

function initRepo() {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-"));
  const runGit = (...args) => NodeChildProcess.execFileSync("git", args, { cwd, stdio: "ignore" });
  runGit("init", "-q", "-b", "main");
  runGit("config", "user.email", "test@example.com");
  runGit("config", "user.name", "Test");
  runGit("config", "commit.gpgsign", "false");
  NodeFS.mkdirSync(NodePath.resolve(cwd, ".no-hooks"));
  runGit("config", "core.hooksPath", ".no-hooks");
  NodeFS.writeFileSync(NodePath.resolve(cwd, "README.md"), "fixture\n");
  runGit("add", "README.md");
  runGit("commit", "-q", "-m", "fixture");
  return { cwd, runGit };
}

function linkDirectory(target, path) {
  NodeFS.symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

NodeTest.test("the full gate contains typecheck, lint, and all unit tests", () => {
  NodeAssertStrict.default.deepEqual(DEFAULT_PHASES.map((phase) => phase.name), [
    "Typecheck",
    "Lint",
    "Unit Tests",
  ]);
});

NodeTest.test("desktop changes select desktop related tests", () => {
  const [phase] = selectTestPhases(["apps/desktop/src/main.ts"]);
  NodeAssertStrict.default.match(phase.name, /apps\/desktop/);
  NodeAssertStrict.default.deepEqual(phase.args, ["vitest", "related", "src/main.ts", "--run"]);
});

NodeTest.test("agent script changes select maintained script tests", () => {
  const phases = selectTestPhases(["scripts/agent/hooks/codex-stop.mjs"]);
  NodeAssertStrict.default.equal(phases.length, 1);
  NodeAssertStrict.default.equal(phases[0].name, "Agent Script Test (verify-tests.test.mjs)");
  NodeAssertStrict.default.match(phases[0].args[1], /verify-tests\.test\.mjs$/);
});

NodeTest.test("verification module changes select maintained script tests", () => {
  const phases = selectTestPhases(["scripts/verification/phase-runner.mjs"]);
  NodeAssertStrict.default.equal(phases.length, 1);
  NodeAssertStrict.default.equal(phases[0].name, "Agent Script Test (verify-tests.test.mjs)");
  NodeAssertStrict.default.match(phases[0].args[1], /verify-tests\.test\.mjs$/);
});

NodeTest.test("the full gate includes script coverage for verification module changes", () => {
  const names = selectTestPhases(
    ["scripts/verification/phase-runner.mjs"],
    { forceFull: true },
  ).map((phase) => phase.name);
  NodeAssertStrict.default.deepEqual(names, [FULL_TEST_PHASE.name, SCRIPT_TEST_PHASE.name]);
});

NodeTest.test("the full gate is a strict superset for agent script changes", () => {
  const files = ["scripts/agent/hooks/codex-stop.mjs"];
  const fullNames = selectTestPhases(files, { forceFull: true }).map((phase) => phase.name);
  NodeAssertStrict.default.deepEqual(fullNames, [FULL_TEST_PHASE.name, SCRIPT_TEST_PHASE.name]);
});

NodeTest.test("shared package changes use related package tests", () => {
  for (const [workspace, file] of [
    ["packages/contracts", "packages/contracts/src/index.ts"],
    ["packages/shared", "packages/shared/src/index.ts"],
  ]) {
    const phases = selectTestPhases([file]);
    NodeAssertStrict.default.equal(phases.length, 1);
    NodeAssertStrict.default.equal(phases[0].name, `Unit Tests (${workspace})`);
    NodeAssertStrict.default.deepEqual(phases[0].args, ["vitest", "related", "src/index.ts", "--run"]);
  }
});

NodeTest.test("server related tests use the Electron Node wrapper", () => {
  const [serverPhase] = selectTestPhases(["apps/server/src/index.ts"]);
  NodeAssertStrict.default.equal(serverPhase.command, "bun");
  NodeAssertStrict.default.deepEqual(serverPhase.args, [
    "../../scripts/run-electron-node.mjs",
    "--workspace-cli",
    "vitest",
    "vitest.mjs",
    "related",
    "src/index.ts",
    "--run",
  ]);
  NodeAssertStrict.default.equal(serverPhase.cwd, NodePath.resolve(process.cwd(), "apps/server"));

  for (const [file, relativeFile] of [
    ["apps/web/src/index.ts", "src/index.ts"],
    ["packages/contracts/src/index.ts", "src/index.ts"],
  ]) {
    const [phase] = selectTestPhases([file]);
    NodeAssertStrict.default.equal(phase.command, "bunx", file);
    NodeAssertStrict.default.deepEqual(phase.args, ["vitest", "related", relativeFile, "--run"], file);
  }
});

NodeTest.test("server related-test chunks account for the Electron wrapper", () => {
  const files = Array.from(
    { length: 5 },
    (_, index) => `apps/server/src/${"a".repeat(3_250)}-${index}.ts`,
  );
  const phases = selectTestPhases(files);
  const selectedFiles = phases.flatMap((phase) => phase.args.slice(5, -1));

  NodeAssertStrict.default.equal(phases.length, 2);
  NodeAssertStrict.default.ok(phases.every((phase) => (
    Buffer.byteLength(JSON.stringify(phase.args)) <= MAX_RELATED_ARG_BYTES
  )));
  NodeAssertStrict.default.deepEqual(selectedFiles, files.map((file) => file.slice("apps/server/".length)));
});

NodeTest.test("root manifests, locks, and verification config defer broad tests to CI", () => {
  for (const file of [
    "package.json",
    "bun.lock",
    "turbo.json",
    "tsconfig.json",
    ".codex/hooks.json",
    "apps/web/tsconfig.json",
    "apps/server/eslint.config.mjs",
    "apps/desktop/vitest.config.ts",
    "packages/shared/vitest.setup.ts",
    "apps/web/src/test-setup.ts",
    "scripts/vitest-global-setup.ts",
    "scripts/vitest-test-dir.ts",
  ]) {
    const phases = selectTestPhases([file]);
    NodeAssertStrict.default.deepEqual(phases, [], file);
  }
});

NodeTest.test("oversized related-test scopes split into focused phases", () => {
  const files = Array.from(
    { length: MAX_RELATED_FILES + 1 },
    (_, index) => `apps/web/src/generated-${index}.ts`,
  );
  const phases = selectTestPhases(files);
  NodeAssertStrict.default.equal(phases.length, 2);
  NodeAssertStrict.default.ok(phases.every((phase) => phase.name.startsWith("Unit Tests (apps/web")));
  NodeAssertStrict.default.ok(phases.every((phase) => phase.args.length <= MAX_RELATED_FILES + 3));
});

NodeTest.test("a script and root config change runs its focused script test", () => {
  const phases = selectTestPhases(["package.json", "scripts/agent/verify-tests.mjs"]);
  NodeAssertStrict.default.deepEqual(phases.map((phase) => phase.name), [
    "Agent Script Test (verify-tests.test.mjs)",
  ]);
});

NodeTest.test("unknown agent scripts use the complete script suite", () => {
  const phases = selectTestPhases(["scripts/agent/new-command.mjs"]);
  NodeAssertStrict.default.equal(phases.length, 1);
  NodeAssertStrict.default.equal(phases[0].name, SCRIPT_TEST_PHASE.name);
});

NodeTest.test("unknown changed files do not select the full suite", () => {
  NodeAssertStrict.default.deepEqual(selectTestPhases(null), []);
});

NodeTest.test("workspace changes are bucketed into independent related-test phases", () => {
  const phases = selectTestPhases([
    "apps/web/src/a.ts",
    "apps/web/src/b.ts",
    "apps/server/src/c.ts",
  ]);
  NodeAssertStrict.default.equal(phases.length, 2);
  NodeAssertStrict.default.equal(phases[0].args.filter((arg) => arg.endsWith(".ts")).length, 2);
  NodeAssertStrict.default.equal(phases[1].args.filter((arg) => arg.endsWith(".ts")).length, 1);
});

NodeTest.test("git inspection includes relevant untracked config but skips docs", () => {
  const { cwd } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "package.json"), "{}\n");
    NodeFS.writeFileSync(NodePath.resolve(cwd, "notes.md"), "notes\n");
    NodeAssertStrict.default.deepEqual(getChangedFiles({ cwd }), ["package.json"]);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("verification phases prefer the Bun executable directory", async () => {
  const result = await runPhase(bunPhase(
    "runtime path",
    "console.log(process.env.PATH ?? process.env.Path)",
    { env: { ...process.env, PATH: "ambient-path" } },
  ));
  NodeAssertStrict.default.equal(result.code, 0);
  NodeAssertStrict.default.equal(result.output.trim().split(NodePath.delimiter)[0], NodePath.dirname(process.execPath));
});

NodeTest.test("runtime PATH comparison preserves POSIX case distinctions", () => {
  const upper = NodePath.resolve(NodeOS.tmpdir(), "Node");
  const lower = NodePath.resolve(NodeOS.tmpdir(), "node");
  NodeAssertStrict.default.equal(pathEntriesMatch(upper, lower, { platform: "linux" }), false);
  NodeAssertStrict.default.equal(pathEntriesMatch(upper, lower, { platform: "win32" }), true);

  const env = { PATH: [upper, lower].join(NodePath.delimiter) };
  const posix = withBunPath(env, NodePath.resolve(upper, "bun"), { platform: "linux" });
  const windows = withBunPath(env, NodePath.resolve(upper, "bun.exe"), { platform: "win32" });
  NodeAssertStrict.default.deepEqual(posix.PATH.split(NodePath.delimiter), [upper, lower]);
  NodeAssertStrict.default.deepEqual(windows.PATH.split(NodePath.delimiter), [upper]);
});

NodeTest.test("a phase streams a complete log while retaining bounded output", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-log-"));
  const logPath = NodePath.resolve(cwd, "phase.log");
  try {
    const result = await runPhase(bunPhase(
      "large failure",
      `process.stdout.write("x".repeat(${MAX_RETAINED_OUTPUT_BYTES * 3})); process.exit(4)`,
      { logPath },
    ));
    NodeAssertStrict.default.equal(result.exitCondition, "nonzero");
    NodeAssertStrict.default.equal(result.code, 4);
    NodeAssertStrict.default.ok(Buffer.byteLength(result.output) <= MAX_RETAINED_OUTPUT_BYTES);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(logPath).length, MAX_RETAINED_OUTPUT_BYTES * 3);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("log stream errors fail the phase without leaving it unsettled", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-log-error-"));
  try {
    const result = await runPhase(bunPhase(
      "log-error",
      "process.stdout.write('evidence')",
      { logPath: NodePath.resolve(cwd, "missing", "phase.log") },
    ));
    NodeAssertStrict.default.equal(result.code, 1);
    NodeAssertStrict.default.equal(result.exitCondition, "log-error");
    NodeAssertStrict.default.match(result.logError, /ENOENT|no such file or directory/i);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("successful phases print one line and hide child output", async () => {
  const lines = [];
  await runPhasesInParallel(
    [bunPhase("Typecheck", "console.log('verbose child output')")],
    { printer: (line) => lines.push(line) },
  );
  NodeAssertStrict.default.deepEqual(lines.length, 1);
  NodeAssertStrict.default.match(lines[0], /^Typecheck: PASS/);
  NodeAssertStrict.default.doesNotMatch(lines[0], /verbose child output/);
});

NodeTest.test("failure diagnostics are bounded and include actionable metadata", async () => {
  const lines = [];
  await runPhasesInParallel(
    [bunPhase("Lint", `console.error("e".repeat(${MAX_FAILURE_EXCERPT_CHARS * 2})); process.exit(2)`) ],
    { printer: (line) => lines.push(line) },
  );
  const output = lines.join("\n");
  NodeAssertStrict.default.match(output, /Lint: FAIL/);
  NodeAssertStrict.default.match(output, /Argv:/);
  NodeAssertStrict.default.match(output, /Working directory:/);
  NodeAssertStrict.default.match(output, /Exit condition: nonzero exit 2/);
  NodeAssertStrict.default.ok(output.length < MAX_FAILURE_EXCERPT_CHARS + 1_000);
});

NodeTest.test("spawn errors have a distinct exit condition", async () => {
  const result = await runPhase({
    name: "missing",
    command: "mcode-command-that-does-not-exist",
    shell: false,
  });
  NodeAssertStrict.default.equal(result.exitCondition, "spawn-error");
  NodeAssertStrict.default.match(result.spawnError, /ENOENT/);
});

NodeTest.test("phase arguments never execute through a Windows command shell", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-injection-"));
  const marker = NodePath.resolve(cwd, "injected.txt");
  try {
    const hostile = process.platform === "win32"
      ? `safe & echo MCODE_INJECTED > "${marker}"`
      : `safe; touch "${marker}"`;
    const result = await runPhase({
      name: "argv",
      command: BUN,
      args: ["-e", "console.log(process.argv[1])", hostile],
    });
    NodeAssertStrict.default.equal(result.code, 0);
    NodeAssertStrict.default.match(result.output, /safe/);
    NodeAssertStrict.default.equal(NodeFS.existsSync(marker), false);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("displayed argv is bounded and remains data", () => {
  const display = formatArgvDisplay("bunx", ["vitest", "related", `x;&|${"a".repeat(4_000)}`]);
  NodeAssertStrict.default.ok(display.length <= MAX_DISPLAYED_ARGV_CHARS + "...[truncated]".length);
  NodeAssertStrict.default.match(display, /^\[/);
  NodeAssertStrict.default.match(display, /truncated/);
});

NodeTest.test("safe argv receives an exact reproduction command", () => {
  NodeAssertStrict.default.equal(formatSafeReproduction("bun", ["run", "lint"]), "bun run lint");
});

NodeTest.test("unsafe or oversized argv omits the reproduction command", () => {
  NodeAssertStrict.default.equal(formatSafeReproduction("bunx", ["vitest", "x;echo", "unsafe"]), null);
  NodeAssertStrict.default.equal(formatSafeReproduction("bunx", ["a".repeat(MAX_DISPLAYED_ARGV_CHARS + 1)]), null);
});

NodeTest.test("timeouts have a distinct exit condition", async () => {
  const result = await runPhase(bunPhase("slow", "setInterval(() => {}, 1000)", { timeoutMs: 50 }));
  NodeAssertStrict.default.equal(result.exitCondition, "timeout");
});

NodeTest.test("abort signals report cancellation", async () => {
  const controller = new AbortController();
  const pending = runPhase(bunPhase("cancel", "setInterval(() => {}, 1000)", {
    signal: controller.signal,
  }));
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  NodeAssertStrict.default.equal(result.exitCondition, "cancelled");
});

NodeTest.test("timeouts terminate descendant processes", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-tree-"));
  const pidPath = NodePath.resolve(cwd, "descendant.pid");
  const source = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  try {
    const result = await runPhase(bunPhase("tree", source, { timeoutMs: 500 }));
    NodeAssertStrict.default.equal(result.exitCondition, "timeout");
    if (process.platform === "win32" && /access (is )?denied/i.test(result.terminationError ?? "")) {
      NodeAssertStrict.default.match(result.terminationError, /access (is )?denied/i);
      return;
    }
    NodeAssertStrict.default.equal(result.terminationError, undefined);
    const descendantPid = Number(NodeFS.readFileSync(pidPath, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      } catch {
        alive = false;
      }
    }
    NodeAssertStrict.default.equal(alive, false, `descendant ${descendantPid} survived timeout cleanup`);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

if (process.platform !== "win32") {
  NodeTest.test("process signals have a distinct exit condition", async () => {
    const result = await runPhase(bunPhase("signal", "process.kill(process.pid, 'SIGTERM')"));
    NodeAssertStrict.default.equal(result.exitCondition, "signal");
    NodeAssertStrict.default.equal(result.signal, "SIGTERM");
  });
}

NodeTest.test("receipt identities survive stage, unstage, and commit transitions", () => {
  const { cwd, runGit } = initRepo();
  try {
    runGit("switch", "-q", "-c", "feature");
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export const value = 1;\n");
    const untracked = calculateVerificationIdentities({ cwd, env: {} });
    runGit("add", "source.ts");
    const staged = calculateVerificationIdentities({ cwd, env: {} });
    runGit("reset", "-q", "HEAD", "source.ts");
    const unstaged = calculateVerificationIdentities({ cwd, env: {} });
    runGit("add", "source.ts");
    runGit("commit", "-q", "-m", "feat: add source");
    const committed = calculateVerificationIdentities({ cwd, env: {} });
    NodeAssertStrict.default.ok(untracked);
    NodeAssertStrict.default.deepEqual(untracked, staged);
    NodeAssertStrict.default.deepEqual(staged, unstaged);
    NodeAssertStrict.default.deepEqual(unstaged, committed);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("receipt identities stay deterministic with an empty PATH", () => {
  const { cwd } = initRepo();
  try {
    const first = calculateVerificationIdentities({ cwd, env: { PATH: "" } });
    const second = calculateVerificationIdentities({ cwd, env: { PATH: "" } });
    NodeAssertStrict.default.ok(first);
    NodeAssertStrict.default.deepEqual(first, second);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("content identities change for edits, deletion, rename, and relevant untracked files", () => {
  const { cwd, runGit } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export const value = 1;\n");
    runGit("add", "source.ts");
    runGit("commit", "-q", "-m", "feat: add source");
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export const value = 2;\n");
    const edited = calculateVerificationIdentities({ cwd, env: {} });
    runGit("mv", "source.ts", "renamed.ts");
    const renamed = calculateVerificationIdentities({ cwd, env: {} });
    NodeFS.rmSync(NodePath.resolve(cwd, "renamed.ts"));
    const deleted = calculateVerificationIdentities({ cwd, env: {} });
    NodeFS.writeFileSync(NodePath.resolve(cwd, "extra.ts"), "export {};\n");
    const untracked = calculateVerificationIdentities({ cwd, env: {} });
    NodeAssertStrict.default.notEqual(edited.contentIdentity, renamed.contentIdentity);
    NodeAssertStrict.default.notEqual(renamed.contentIdentity, deleted.contentIdentity);
    NodeAssertStrict.default.notEqual(deleted.contentIdentity, untracked.contentIdentity);
    NodeAssertStrict.default.notEqual(edited.planningIdentity, renamed.planningIdentity);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("content identities include relevant environment values without exposing them", () => {
  const { cwd } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export {};\n");
    const first = calculateVerificationIdentities({ cwd, env: { NODE_ENV: "alpha" } });
    const second = calculateVerificationIdentities({ cwd, env: { NODE_ENV: "beta" } });
    NodeAssertStrict.default.notEqual(first.contentIdentity, second.contentIdentity);
    NodeAssertStrict.default.doesNotMatch(JSON.stringify(first), /alpha/);
    NodeAssertStrict.default.doesNotMatch(JSON.stringify(second), /beta/);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("verification configuration changes content identity without changing test scope", () => {
  const { cwd } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "package.json"), "{}\n");
    const first = calculateVerificationIdentities({ cwd, env: {} });
    NodeFS.writeFileSync(NodePath.resolve(cwd, "package.json"), "{\"private\":true}\n");
    const second = calculateVerificationIdentities({ cwd, env: {} });
    NodeAssertStrict.default.notEqual(first.contentIdentity, second.contentIdentity);
    NodeAssertStrict.default.equal(first.planningIdentity, second.planningIdentity);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("receipt identity calculation rejects paths outside the repository", () => {
  const { cwd } = initRepo();
  try {
    NodeAssertStrict.default.equal(calculateVerificationIdentities({
      cwd,
      env: {},
      changedFiles: ["../outside.ts"],
    }), null);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("receipt identity calculation rejects intermediate repository links", () => {
  const { cwd } = initRepo();
  const outside = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-outside-"));
  const link = NodePath.resolve(cwd, "linked");
  try {
    NodeFS.writeFileSync(NodePath.resolve(outside, "source.ts"), "export {};\n");
    linkDirectory(outside, link);
    NodeAssertStrict.default.equal(calculateVerificationIdentities({
      cwd,
      env: {},
      changedFiles: ["linked/source.ts"],
    }), null);
  } finally {
    if (NodeFS.existsSync(link)) NodeFS.unlinkSync(link);
    NodeFS.rmSync(cwd, { recursive: true, force: true });
    NodeFS.rmSync(outside, { recursive: true, force: true });
  }
});

NodeTest.test("receipt inspection approves no relevant changes without creating artifacts", () => {
  const { cwd } = initRepo();
  try {
    const lines = [];
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: (line) => lines.push(line) });
    NodeAssertStrict.default.equal(result.code, 0);
    NodeAssertStrict.default.equal(result.approved, true);
    NodeAssertStrict.default.match(lines.join("\n"), /no relevant changes/);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.resolve(cwd, ".dev", "verification")), false);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("receipt inspection blocks stale state without creating artifacts or runs", () => {
  const { cwd } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export {};\n");
    const lines = [];
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: (line) => lines.push(line) });
    NodeAssertStrict.default.equal(result.code, 2);
    NodeAssertStrict.default.equal(result.approved, false);
    NodeAssertStrict.default.match(lines.join("\n"), /Run bun run verify:changed/);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.resolve(cwd, ".dev", "verification")), false);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("Claude receipt checks emit blocking recovery guidance on stderr", () => {
  const { cwd } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export {};\n");
    const result = NodeChildProcess.spawnSync(BUN, [VERIFY_SCRIPT, "--check-receipt"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    NodeAssertStrict.default.equal(result.status, 2);
    NodeAssertStrict.default.match(result.stderr, /bun run verify:changed/);
    NodeAssertStrict.default.equal(result.stdout, "");
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("verification fails closed when receipt identities cannot be calculated", async () => {
  const { cwd, runGit } = initRepo();
  try {
    runGit("branch", "-m", "other");
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export {};\n");
    const lines = [];
    const result = await runVerification({ cwd, env: {}, printer: (line) => lines.push(line) });
    NodeAssertStrict.default.equal(result.code, 1);
    NodeAssertStrict.default.equal(result.identityFailure, true);
    NodeAssertStrict.default.match(lines.join("\n"), /could not calculate receipt identities/);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.resolve(cwd, ".dev", "verification")), false);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

function createCacheEvidence({ gate = "changed", code = 0 } = {}) {
  const root = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-cache-"));
  const runDirectory = NodePath.resolve(root, "runs", "run-1");
  NodeFS.mkdirSync(runDirectory, { recursive: true });
  const logPath = NodePath.resolve(runDirectory, "01-test.log");
  const manifestPath = NodePath.resolve(runDirectory, "manifest.json");
  const identities = {
    contentIdentity: "a".repeat(64),
    planningIdentity: "b".repeat(64),
  };
  NodeFS.writeFileSync(logPath, "evidence\n");
  const manifest = {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    complete: true,
    ...identities,
    gate,
    code,
    skipped: false,
    changedFiles: ["source.ts"],
    phases: [{ name: "Test", code, exitCondition: code === 0 ? "success" : "nonzero", logPath }],
  };
  NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
  const record = {
    ...manifest,
    phases: undefined,
    manifestPath,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
  };
  return { root, record, manifestPath, logPath, identities };
}

function installRepositoryReceipt(cwd, { gate = "changed", code = 0 } = {}) {
  const root = NodePath.resolve(cwd, ".dev", "verification");
  const runDirectory = NodePath.resolve(root, "runs", "run-1");
  NodeFS.mkdirSync(runDirectory, { recursive: true });
  const identities = calculateVerificationIdentities({ cwd, env: {} });
  const logPath = NodePath.resolve(runDirectory, "01-test.log");
  const manifestPath = NodePath.resolve(runDirectory, "manifest.json");
  NodeFS.writeFileSync(logPath, "evidence\n");
  const manifest = {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    complete: true,
    ...identities,
    gate,
    code,
    skipped: false,
    changedFiles: getChangedFiles({ cwd }),
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    phases: [{ name: "Test", code, exitCondition: code === 0 ? "success" : "nonzero", logPath }],
  };
  NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
  NodeFS.writeFileSync(NodePath.resolve(root, "results.json"), JSON.stringify({
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    records: [{ ...manifest, phases: undefined, manifestPath }],
  }));
  return { root, manifestPath };
}

NodeTest.test("receipt inspection reuses matching evidence without creating a run", () => {
  const { cwd } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export {};\n");
    const evidence = installRepositoryReceipt(cwd);
    const runsBefore = NodeFS.readdirSync(NodePath.resolve(evidence.root, "runs"));
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: () => {} });
    NodeAssertStrict.default.equal(result.code, 0);
    NodeAssertStrict.default.equal(result.approved, true);
    NodeAssertStrict.default.equal(result.manifestPath, evidence.manifestPath);
    NodeAssertStrict.default.deepEqual(NodeFS.readdirSync(NodePath.resolve(evidence.root, "runs")), runsBefore);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("receipt inspection blocks with the matching failed manifest", () => {
  const { cwd } = initRepo();
  try {
    NodeFS.writeFileSync(NodePath.resolve(cwd, "source.ts"), "export {};\n");
    const evidence = installRepositoryReceipt(cwd, { code: 1 });
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: () => {} });
    NodeAssertStrict.default.equal(result.code, 2);
    NodeAssertStrict.default.equal(result.approved, false);
    NodeAssertStrict.default.equal(result.manifestPath, evidence.manifestPath);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("validated full success covers changed hooks but changed success never covers full", () => {
  const full = createCacheEvidence({ gate: "full", code: 0 });
  const changed = createCacheEvidence({ gate: "changed", code: 0 });
  try {
    NodeAssertStrict.default.equal(
      findReusableResult([full.record], full.identities, "changed", { root: full.root }),
      full.record,
    );
    NodeAssertStrict.default.equal(
      findReusableResult([changed.record], changed.identities, "full", { root: changed.root }),
      null,
    );
  } finally {
    NodeFS.rmSync(full.root, { recursive: true, force: true });
    NodeFS.rmSync(changed.root, { recursive: true, force: true });
  }
});

NodeTest.test("same-gate failures can block again but full failures cannot cover changed", () => {
  const failure = createCacheEvidence({ gate: "full", code: 2 });
  try {
    NodeAssertStrict.default.equal(
      findReusableResult([failure.record], failure.identities, "full", { root: failure.root }),
      failure.record,
    );
    NodeAssertStrict.default.equal(
      findReusableResult([failure.record], failure.identities, "changed", { root: failure.root }),
      null,
    );
  } finally {
    NodeFS.rmSync(failure.root, { recursive: true, force: true });
  }
});

NodeTest.test("missing, corrupt, incomplete, or inconsistent cache evidence is ignored", () => {
  const evidence = createCacheEvidence();
  try {
    const find = () => findReusableResult(
      [evidence.record], evidence.identities, "changed", { root: evidence.root },
    );
    NodeAssertStrict.default.equal(find(), evidence.record);
    NodeFS.writeFileSync(evidence.manifestPath, "not json");
    NodeAssertStrict.default.equal(find(), null);
    NodeFS.writeFileSync(evidence.manifestPath, JSON.stringify({ complete: true }));
    NodeAssertStrict.default.equal(find(), null);
    NodeFS.rmSync(evidence.manifestPath);
    NodeAssertStrict.default.equal(find(), null);
  } finally {
    NodeFS.rmSync(evidence.root, { recursive: true, force: true });
  }
});

NodeTest.test("old schemas and mismatched receipt identities are ignored", () => {
  const evidence = createCacheEvidence();
  try {
    NodeAssertStrict.default.equal(findReusableResult(
      [{ ...evidence.record, schemaVersion: VERIFICATION_SCHEMA_VERSION - 1 }],
      evidence.identities,
      "changed",
      { root: evidence.root },
    ), null);
    NodeAssertStrict.default.equal(findReusableResult(
      [evidence.record],
      { ...evidence.identities, planningIdentity: "c".repeat(64) },
      "changed",
      { root: evidence.root },
    ), null);
  } finally {
    NodeFS.rmSync(evidence.root, { recursive: true, force: true });
  }
});

NodeTest.test("cache evidence rejects a manifest that escapes through a directory link", () => {
  const evidence = createCacheEvidence();
  const outside = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-manifest-escape-"));
  const runDirectory = NodePath.resolve(evidence.root, "runs", "run-1");
  try {
    const manifest = NodeFS.readFileSync(evidence.manifestPath);
    NodeFS.rmSync(runDirectory, { recursive: true, force: true });
    NodeFS.writeFileSync(NodePath.resolve(outside, "manifest.json"), manifest);
    linkDirectory(outside, runDirectory);
    NodeAssertStrict.default.equal(findReusableResult(
      [evidence.record], evidence.identities, "changed", { root: evidence.root },
    ), null);
  } finally {
    if (NodeFS.existsSync(runDirectory)) NodeFS.unlinkSync(runDirectory);
    NodeFS.rmSync(evidence.root, { recursive: true, force: true });
    NodeFS.rmSync(outside, { recursive: true, force: true });
  }
});

NodeTest.test("cache evidence rejects a phase log that escapes through a directory link", () => {
  const evidence = createCacheEvidence();
  const outside = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-log-escape-"));
  const logDirectory = NodePath.resolve(evidence.root, "runs", "run-1", "logs");
  try {
    NodeFS.writeFileSync(NodePath.resolve(outside, "01-test.log"), "outside evidence\n");
    linkDirectory(outside, logDirectory);
    const manifest = JSON.parse(NodeFS.readFileSync(evidence.manifestPath, "utf8"));
    manifest.phases[0].logPath = NodePath.resolve(logDirectory, "01-test.log");
    NodeFS.writeFileSync(evidence.manifestPath, JSON.stringify(manifest));
    NodeAssertStrict.default.equal(findReusableResult(
      [evidence.record], evidence.identities, "changed", { root: evidence.root },
    ), null);
  } finally {
    if (NodeFS.existsSync(logDirectory)) NodeFS.unlinkSync(logDirectory);
    NodeFS.rmSync(evidence.root, { recursive: true, force: true });
    NodeFS.rmSync(outside, { recursive: true, force: true });
  }
});

NodeTest.test("cache evidence with an evicted phase log is ignored", () => {
  const evidence = createCacheEvidence();
  try {
    NodeFS.rmSync(evidence.logPath);
    NodeAssertStrict.default.equal(
      findReusableResult(
        [evidence.record], evidence.identities, "changed", { root: evidence.root },
      ),
      null,
    );
  } finally {
    NodeFS.rmSync(evidence.root, { recursive: true, force: true });
  }
});

NodeTest.test("parallel phases aggregate the first failure after every phase completes", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-concurrent-"));
  const releasePath = NodePath.resolve(cwd, "release");
  const makeWaitingPhase = (name, code) => bunPhase(name, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(NodePath.resolve(cwd, `${name}.ready`))}, 'ready');`,
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); process.exit(${code}); } }, 25);`,
  ].join("\n"));
  try {
    const pending = runPhasesInParallel([
      makeWaitingPhase("slow-pass", 0),
      makeWaitingPhase("first-failure", 3),
      makeWaitingPhase("second-failure", 5),
    ], { printer: () => {} });
    const readyPaths = ["slow-pass", "first-failure", "second-failure"]
      .map((name) => NodePath.resolve(cwd, `${name}.ready`));
    for (let attempt = 0; attempt < 600 && !readyPaths.every(NodeFS.existsSync); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    NodeAssertStrict.default.equal(readyPaths.every(NodeFS.existsSync), true, "all phases should start before any completes");
    NodeFS.writeFileSync(releasePath, "release");
    const { code, results } = await pending;
    NodeAssertStrict.default.equal(code, 3);
    NodeAssertStrict.default.deepEqual(results.map((result) => result.code), [0, 3, 5]);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("agent script tests start after the parallel core phases settle", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-lanes-"));
  const marker = NodePath.resolve(cwd, "core-complete.txt");
  try {
    const { code, results } = await runVerificationPhases(
      [
        bunPhase("Typecheck", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"), 100)`),
        bunPhase(
          SCRIPT_TEST_PHASE.name,
          `if (!require("node:fs").existsSync(${JSON.stringify(marker)})) process.exit(9)`,
        ),
      ],
      { printer: () => {} },
    );
    NodeAssertStrict.default.equal(code, 0);
    NodeAssertStrict.default.deepEqual(results.map((result) => result.name), ["Typecheck", SCRIPT_TEST_PHASE.name]);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

NodeTest.test("full logs are created only when a run directory is supplied", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "mcode-verify-run-"));
  try {
    const { results } = await runPhasesInParallel(
      [bunPhase("Example", "console.log('evidence')")],
      { runDirectory: cwd, printer: () => {} },
    );
    NodeAssertStrict.default.ok(results[0].logPath);
    NodeAssertStrict.default.equal(NodeFS.existsSync(results[0].logPath), true);
    NodeAssertStrict.default.match(NodeFS.readFileSync(results[0].logPath, "utf8"), /evidence/);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
