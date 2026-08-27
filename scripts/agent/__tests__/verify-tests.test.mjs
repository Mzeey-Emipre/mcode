/** Tests for Mcode's verification planner, runner, and hook reuse policy. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  isVerificationRelevant,
  pathEntriesMatch,
  runPhase,
  runPhasesInParallel,
  runVerification,
  runVerificationPhases,
  selectTestPhases,
  withBunPath,
} from "../verify-tests.mjs";

const BUN = process.execPath;
const VERIFY_SCRIPT = fileURLToPath(new URL("../verify-tests.mjs", import.meta.url));

function bunPhase(name, code, extra = {}) {
  return { name, command: BUN, args: ["-e", code], shell: false, ...extra };
}

function initRepo() {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-"));
  const runGit = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  runGit("init", "-q", "-b", "main");
  runGit("config", "user.email", "test@example.com");
  runGit("config", "user.name", "Test");
  runGit("config", "commit.gpgsign", "false");
  mkdirSync(resolve(cwd, ".no-hooks"));
  runGit("config", "core.hooksPath", ".no-hooks");
  writeFileSync(resolve(cwd, "README.md"), "fixture\n");
  runGit("add", "README.md");
  runGit("commit", "-q", "-m", "fixture");
  return { cwd, runGit };
}

function linkDirectory(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("the full gate contains typecheck, lint, and all unit tests", () => {
  assert.deepEqual(DEFAULT_PHASES.map((phase) => phase.name), [
    "Typecheck",
    "Lint",
    "Unit Tests",
  ]);
});

test("desktop changes select desktop related tests", () => {
  const [phase] = selectTestPhases(["apps/desktop/src/main.ts"]);
  assert.match(phase.name, /apps\/desktop/);
  assert.deepEqual(phase.args, ["vitest", "related", "src/main.ts", "--run"]);
});

test("agent script changes select maintained script tests", () => {
  const phases = selectTestPhases(["scripts/agent/hooks/codex-stop.mjs"]);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, "Agent Script Test (verify-tests.test.mjs)");
  assert.match(phases[0].args[1], /verify-tests\.test\.mjs$/);
});

test("the full gate is a strict superset for agent script changes", () => {
  const files = ["scripts/agent/hooks/codex-stop.mjs"];
  const fullNames = selectTestPhases(files, { forceFull: true }).map((phase) => phase.name);
  assert.deepEqual(fullNames, [FULL_TEST_PHASE.name, SCRIPT_TEST_PHASE.name]);
});

test("shared package changes use related package tests", () => {
  for (const [workspace, file] of [
    ["packages/contracts", "packages/contracts/src/index.ts"],
    ["packages/shared", "packages/shared/src/index.ts"],
  ]) {
    const phases = selectTestPhases([file]);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].name, `Unit Tests (${workspace})`);
    assert.deepEqual(phases[0].args, ["vitest", "related", "src/index.ts", "--run"]);
  }
});

test("server related tests use the Electron Node wrapper", () => {
  const [serverPhase] = selectTestPhases(["apps/server/src/index.ts"]);
  assert.equal(serverPhase.command, "bun");
  assert.deepEqual(serverPhase.args, [
    "../../scripts/run-electron-node.mjs",
    "--workspace-cli",
    "vitest",
    "vitest.mjs",
    "related",
    "src/index.ts",
    "--run",
  ]);
  assert.equal(serverPhase.cwd, resolve(process.cwd(), "apps/server"));

  for (const [file, relativeFile] of [
    ["apps/web/src/index.ts", "src/index.ts"],
    ["packages/contracts/src/index.ts", "src/index.ts"],
  ]) {
    const [phase] = selectTestPhases([file]);
    assert.equal(phase.command, "bunx", file);
    assert.deepEqual(phase.args, ["vitest", "related", relativeFile, "--run"], file);
  }
});

test("server related-test chunks account for the Electron wrapper", () => {
  const files = Array.from(
    { length: 5 },
    (_, index) => `apps/server/src/${"a".repeat(3_250)}-${index}.ts`,
  );
  const phases = selectTestPhases(files);
  const selectedFiles = phases.flatMap((phase) => phase.args.slice(5, -1));

  assert.equal(phases.length, 2);
  assert.ok(phases.every((phase) => (
    Buffer.byteLength(JSON.stringify(phase.args)) <= MAX_RELATED_ARG_BYTES
  )));
  assert.deepEqual(selectedFiles, files.map((file) => file.slice("apps/server/".length)));
});

test("root manifests, locks, and verification config defer broad tests to CI", () => {
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
    assert.deepEqual(phases, [], file);
  }
});

test("oversized related-test scopes split into focused phases", () => {
  const files = Array.from(
    { length: MAX_RELATED_FILES + 1 },
    (_, index) => `apps/web/src/generated-${index}.ts`,
  );
  const phases = selectTestPhases(files);
  assert.equal(phases.length, 2);
  assert.ok(phases.every((phase) => phase.name.startsWith("Unit Tests (apps/web")));
  assert.ok(phases.every((phase) => phase.args.length <= MAX_RELATED_FILES + 3));
});

test("a script and root config change runs its focused script test", () => {
  const phases = selectTestPhases(["package.json", "scripts/agent/verify-tests.mjs"]);
  assert.deepEqual(phases.map((phase) => phase.name), [
    "Agent Script Test (verify-tests.test.mjs)",
  ]);
});

test("unknown agent scripts use the complete script suite", () => {
  const phases = selectTestPhases(["scripts/agent/new-command.mjs"]);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, SCRIPT_TEST_PHASE.name);
});

test("unknown changed files do not select the full suite", () => {
  assert.deepEqual(selectTestPhases(null), []);
});

test("workspace changes are bucketed into independent related-test phases", () => {
  const phases = selectTestPhases([
    "apps/web/src/a.ts",
    "apps/web/src/b.ts",
    "apps/server/src/c.ts",
  ]);
  assert.equal(phases.length, 2);
  assert.equal(phases[0].args.filter((arg) => arg.endsWith(".ts")).length, 2);
  assert.equal(phases[1].args.filter((arg) => arg.endsWith(".ts")).length, 1);
});

test("git inspection includes relevant untracked config but skips docs", () => {
  const { cwd } = initRepo();
  try {
    writeFileSync(resolve(cwd, "package.json"), "{}\n");
    writeFileSync(resolve(cwd, "notes.md"), "notes\n");
    assert.deepEqual(getChangedFiles({ cwd }), ["package.json"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("verification phases prefer the Bun executable directory", async () => {
  const result = await runPhase(bunPhase(
    "runtime path",
    "console.log(process.env.PATH ?? process.env.Path)",
    { env: { ...process.env, PATH: "ambient-path" } },
  ));
  assert.equal(result.code, 0);
  assert.equal(result.output.trim().split(delimiter)[0], dirname(process.execPath));
});

test("runtime PATH comparison preserves POSIX case distinctions", () => {
  const upper = resolve(tmpdir(), "Node");
  const lower = resolve(tmpdir(), "node");
  assert.equal(pathEntriesMatch(upper, lower, { platform: "linux" }), false);
  assert.equal(pathEntriesMatch(upper, lower, { platform: "win32" }), true);

  const env = { PATH: [upper, lower].join(delimiter) };
  const posix = withBunPath(env, resolve(upper, "bun"), { platform: "linux" });
  const windows = withBunPath(env, resolve(upper, "bun.exe"), { platform: "win32" });
  assert.deepEqual(posix.PATH.split(delimiter), [upper, lower]);
  assert.deepEqual(windows.PATH.split(delimiter), [upper]);
});

test("a phase streams a complete log while retaining bounded output", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-log-"));
  const logPath = resolve(cwd, "phase.log");
  try {
    const result = await runPhase(bunPhase(
      "large failure",
      `process.stdout.write("x".repeat(${MAX_RETAINED_OUTPUT_BYTES * 3})); process.exit(4)`,
      { logPath },
    ));
    assert.equal(result.exitCondition, "nonzero");
    assert.equal(result.code, 4);
    assert.ok(Buffer.byteLength(result.output) <= MAX_RETAINED_OUTPUT_BYTES);
    assert.equal(readFileSync(logPath).length, MAX_RETAINED_OUTPUT_BYTES * 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("log stream errors fail the phase without leaving it unsettled", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-log-error-"));
  try {
    const result = await runPhase(bunPhase(
      "log-error",
      "process.stdout.write('evidence')",
      { logPath: resolve(cwd, "missing", "phase.log") },
    ));
    assert.equal(result.code, 1);
    assert.equal(result.exitCondition, "log-error");
    assert.match(result.logError, /ENOENT|no such file or directory/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("successful phases print one line and hide child output", async () => {
  const lines = [];
  await runPhasesInParallel(
    [bunPhase("Typecheck", "console.log('verbose child output')")],
    { printer: (line) => lines.push(line) },
  );
  assert.deepEqual(lines.length, 1);
  assert.match(lines[0], /^Typecheck: PASS/);
  assert.doesNotMatch(lines[0], /verbose child output/);
});

test("failure diagnostics are bounded and include actionable metadata", async () => {
  const lines = [];
  await runPhasesInParallel(
    [bunPhase("Lint", `console.error("e".repeat(${MAX_FAILURE_EXCERPT_CHARS * 2})); process.exit(2)`) ],
    { printer: (line) => lines.push(line) },
  );
  const output = lines.join("\n");
  assert.match(output, /Lint: FAIL/);
  assert.match(output, /Argv:/);
  assert.match(output, /Working directory:/);
  assert.match(output, /Exit condition: nonzero exit 2/);
  assert.ok(output.length < MAX_FAILURE_EXCERPT_CHARS + 1_000);
});

test("spawn errors have a distinct exit condition", async () => {
  const result = await runPhase({
    name: "missing",
    command: "mcode-command-that-does-not-exist",
    shell: false,
  });
  assert.equal(result.exitCondition, "spawn-error");
  assert.match(result.spawnError, /ENOENT/);
});

test("phase arguments never execute through a Windows command shell", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-injection-"));
  const marker = resolve(cwd, "injected.txt");
  try {
    const hostile = process.platform === "win32"
      ? `safe & echo MCODE_INJECTED > "${marker}"`
      : `safe; touch "${marker}"`;
    const result = await runPhase({
      name: "argv",
      command: BUN,
      args: ["-e", "console.log(process.argv[1])", hostile],
    });
    assert.equal(result.code, 0);
    assert.match(result.output, /safe/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("displayed argv is bounded and remains data", () => {
  const display = formatArgvDisplay("bunx", ["vitest", "related", `x;&|${"a".repeat(4_000)}`]);
  assert.ok(display.length <= MAX_DISPLAYED_ARGV_CHARS + "...[truncated]".length);
  assert.match(display, /^\[/);
  assert.match(display, /truncated/);
});

test("safe argv receives an exact reproduction command", () => {
  assert.equal(formatSafeReproduction("bun", ["run", "lint"]), "bun run lint");
});

test("unsafe or oversized argv omits the reproduction command", () => {
  assert.equal(formatSafeReproduction("bunx", ["vitest", "x;echo", "unsafe"]), null);
  assert.equal(formatSafeReproduction("bunx", ["a".repeat(MAX_DISPLAYED_ARGV_CHARS + 1)]), null);
});

test("timeouts have a distinct exit condition", async () => {
  const result = await runPhase(bunPhase("slow", "setInterval(() => {}, 1000)", { timeoutMs: 50 }));
  assert.equal(result.exitCondition, "timeout");
});

test("abort signals report cancellation", async () => {
  const controller = new AbortController();
  const pending = runPhase(bunPhase("cancel", "setInterval(() => {}, 1000)", {
    signal: controller.signal,
  }));
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  assert.equal(result.exitCondition, "cancelled");
});

test("timeouts terminate descendant processes", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-tree-"));
  const pidPath = resolve(cwd, "descendant.pid");
  const source = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  try {
    const result = await runPhase(bunPhase("tree", source, { timeoutMs: 500 }));
    assert.equal(result.exitCondition, "timeout");
    if (process.platform === "win32" && /access (is )?denied/i.test(result.terminationError ?? "")) {
      assert.match(result.terminationError, /access (is )?denied/i);
      return;
    }
    assert.equal(result.terminationError, undefined);
    const descendantPid = Number(readFileSync(pidPath, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `descendant ${descendantPid} survived timeout cleanup`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

if (process.platform !== "win32") {
  test("process signals have a distinct exit condition", async () => {
    const result = await runPhase(bunPhase("signal", "process.kill(process.pid, 'SIGTERM')"));
    assert.equal(result.exitCondition, "signal");
    assert.equal(result.signal, "SIGTERM");
  });
}

test("receipt identities survive stage, unstage, and commit transitions", () => {
  const { cwd, runGit } = initRepo();
  try {
    runGit("switch", "-q", "-c", "feature");
    writeFileSync(resolve(cwd, "source.ts"), "export const value = 1;\n");
    const untracked = calculateVerificationIdentities({ cwd, env: {} });
    runGit("add", "source.ts");
    const staged = calculateVerificationIdentities({ cwd, env: {} });
    runGit("reset", "-q", "HEAD", "source.ts");
    const unstaged = calculateVerificationIdentities({ cwd, env: {} });
    runGit("add", "source.ts");
    runGit("commit", "-q", "-m", "feat: add source");
    const committed = calculateVerificationIdentities({ cwd, env: {} });
    assert.ok(untracked);
    assert.deepEqual(untracked, staged);
    assert.deepEqual(staged, unstaged);
    assert.deepEqual(unstaged, committed);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("receipt identities stay deterministic with an empty PATH", () => {
  const { cwd } = initRepo();
  try {
    const first = calculateVerificationIdentities({ cwd, env: { PATH: "" } });
    const second = calculateVerificationIdentities({ cwd, env: { PATH: "" } });
    assert.ok(first);
    assert.deepEqual(first, second);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("content identities change for edits, deletion, rename, and relevant untracked files", () => {
  const { cwd, runGit } = initRepo();
  try {
    writeFileSync(resolve(cwd, "source.ts"), "export const value = 1;\n");
    runGit("add", "source.ts");
    runGit("commit", "-q", "-m", "feat: add source");
    writeFileSync(resolve(cwd, "source.ts"), "export const value = 2;\n");
    const edited = calculateVerificationIdentities({ cwd, env: {} });
    runGit("mv", "source.ts", "renamed.ts");
    const renamed = calculateVerificationIdentities({ cwd, env: {} });
    rmSync(resolve(cwd, "renamed.ts"));
    const deleted = calculateVerificationIdentities({ cwd, env: {} });
    writeFileSync(resolve(cwd, "extra.ts"), "export {};\n");
    const untracked = calculateVerificationIdentities({ cwd, env: {} });
    assert.notEqual(edited.contentIdentity, renamed.contentIdentity);
    assert.notEqual(renamed.contentIdentity, deleted.contentIdentity);
    assert.notEqual(deleted.contentIdentity, untracked.contentIdentity);
    assert.notEqual(edited.planningIdentity, renamed.planningIdentity);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("content identities include relevant environment values without exposing them", () => {
  const { cwd } = initRepo();
  try {
    writeFileSync(resolve(cwd, "source.ts"), "export {};\n");
    const first = calculateVerificationIdentities({ cwd, env: { NODE_ENV: "alpha" } });
    const second = calculateVerificationIdentities({ cwd, env: { NODE_ENV: "beta" } });
    assert.notEqual(first.contentIdentity, second.contentIdentity);
    assert.doesNotMatch(JSON.stringify(first), /alpha/);
    assert.doesNotMatch(JSON.stringify(second), /beta/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("verification configuration changes content identity without changing test scope", () => {
  const { cwd } = initRepo();
  try {
    writeFileSync(resolve(cwd, "package.json"), "{}\n");
    const first = calculateVerificationIdentities({ cwd, env: {} });
    writeFileSync(resolve(cwd, "package.json"), "{\"private\":true}\n");
    const second = calculateVerificationIdentities({ cwd, env: {} });
    assert.notEqual(first.contentIdentity, second.contentIdentity);
    assert.equal(first.planningIdentity, second.planningIdentity);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("receipt identity calculation rejects paths outside the repository", () => {
  const { cwd } = initRepo();
  try {
    assert.equal(calculateVerificationIdentities({
      cwd,
      env: {},
      changedFiles: ["../outside.ts"],
    }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("receipt identity calculation rejects intermediate repository links", () => {
  const { cwd } = initRepo();
  const outside = mkdtempSync(resolve(tmpdir(), "mcode-verify-outside-"));
  const link = resolve(cwd, "linked");
  try {
    writeFileSync(resolve(outside, "source.ts"), "export {};\n");
    linkDirectory(outside, link);
    assert.equal(calculateVerificationIdentities({
      cwd,
      env: {},
      changedFiles: ["linked/source.ts"],
    }), null);
  } finally {
    if (existsSync(link)) unlinkSync(link);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("receipt inspection approves no relevant changes without creating artifacts", () => {
  const { cwd } = initRepo();
  try {
    const lines = [];
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: (line) => lines.push(line) });
    assert.equal(result.code, 0);
    assert.equal(result.approved, true);
    assert.match(lines.join("\n"), /no relevant changes/);
    assert.equal(existsSync(resolve(cwd, ".dev", "verification")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("receipt inspection blocks stale state without creating artifacts or runs", () => {
  const { cwd } = initRepo();
  try {
    writeFileSync(resolve(cwd, "source.ts"), "export {};\n");
    const lines = [];
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: (line) => lines.push(line) });
    assert.equal(result.code, 2);
    assert.equal(result.approved, false);
    assert.match(lines.join("\n"), /Run bun run verify:changed/);
    assert.equal(existsSync(resolve(cwd, ".dev", "verification")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Claude receipt checks emit blocking recovery guidance on stderr", () => {
  const { cwd } = initRepo();
  try {
    writeFileSync(resolve(cwd, "source.ts"), "export {};\n");
    const result = spawnSync(BUN, [VERIFY_SCRIPT, "--check-receipt"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /bun run verify:changed/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("verification fails closed when receipt identities cannot be calculated", async () => {
  const { cwd, runGit } = initRepo();
  try {
    runGit("branch", "-m", "other");
    writeFileSync(resolve(cwd, "source.ts"), "export {};\n");
    const lines = [];
    const result = await runVerification({ cwd, env: {}, printer: (line) => lines.push(line) });
    assert.equal(result.code, 1);
    assert.equal(result.identityFailure, true);
    assert.match(lines.join("\n"), /could not calculate receipt identities/);
    assert.equal(existsSync(resolve(cwd, ".dev", "verification")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function createCacheEvidence({ gate = "changed", code = 0 } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "mcode-verify-cache-"));
  const runDirectory = resolve(root, "runs", "run-1");
  mkdirSync(runDirectory, { recursive: true });
  const logPath = resolve(runDirectory, "01-test.log");
  const manifestPath = resolve(runDirectory, "manifest.json");
  const identities = {
    contentIdentity: "a".repeat(64),
    planningIdentity: "b".repeat(64),
  };
  writeFileSync(logPath, "evidence\n");
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
  writeFileSync(manifestPath, JSON.stringify(manifest));
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
  const root = resolve(cwd, ".dev", "verification");
  const runDirectory = resolve(root, "runs", "run-1");
  mkdirSync(runDirectory, { recursive: true });
  const identities = calculateVerificationIdentities({ cwd, env: {} });
  const logPath = resolve(runDirectory, "01-test.log");
  const manifestPath = resolve(runDirectory, "manifest.json");
  writeFileSync(logPath, "evidence\n");
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
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(resolve(root, "results.json"), JSON.stringify({
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    records: [{ ...manifest, phases: undefined, manifestPath }],
  }));
  return { root, manifestPath };
}

test("receipt inspection reuses matching evidence without creating a run", () => {
  const { cwd } = initRepo();
  try {
    writeFileSync(resolve(cwd, "source.ts"), "export {};\n");
    const evidence = installRepositoryReceipt(cwd);
    const runsBefore = readdirSync(resolve(evidence.root, "runs"));
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: () => {} });
    assert.equal(result.code, 0);
    assert.equal(result.approved, true);
    assert.equal(result.manifestPath, evidence.manifestPath);
    assert.deepEqual(readdirSync(resolve(evidence.root, "runs")), runsBefore);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("receipt inspection blocks with the matching failed manifest", () => {
  const { cwd } = initRepo();
  try {
    writeFileSync(resolve(cwd, "source.ts"), "export {};\n");
    const evidence = installRepositoryReceipt(cwd, { code: 1 });
    const result = inspectVerificationReceipt({ cwd, env: {}, printer: () => {} });
    assert.equal(result.code, 2);
    assert.equal(result.approved, false);
    assert.equal(result.manifestPath, evidence.manifestPath);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("validated full success covers changed hooks but changed success never covers full", () => {
  const full = createCacheEvidence({ gate: "full", code: 0 });
  const changed = createCacheEvidence({ gate: "changed", code: 0 });
  try {
    assert.equal(
      findReusableResult([full.record], full.identities, "changed", { root: full.root }),
      full.record,
    );
    assert.equal(
      findReusableResult([changed.record], changed.identities, "full", { root: changed.root }),
      null,
    );
  } finally {
    rmSync(full.root, { recursive: true, force: true });
    rmSync(changed.root, { recursive: true, force: true });
  }
});

test("same-gate failures can block again but full failures cannot cover changed", () => {
  const failure = createCacheEvidence({ gate: "full", code: 2 });
  try {
    assert.equal(
      findReusableResult([failure.record], failure.identities, "full", { root: failure.root }),
      failure.record,
    );
    assert.equal(
      findReusableResult([failure.record], failure.identities, "changed", { root: failure.root }),
      null,
    );
  } finally {
    rmSync(failure.root, { recursive: true, force: true });
  }
});

test("missing, corrupt, incomplete, or inconsistent cache evidence is ignored", () => {
  const evidence = createCacheEvidence();
  try {
    const find = () => findReusableResult(
      [evidence.record], evidence.identities, "changed", { root: evidence.root },
    );
    assert.equal(find(), evidence.record);
    writeFileSync(evidence.manifestPath, "not json");
    assert.equal(find(), null);
    writeFileSync(evidence.manifestPath, JSON.stringify({ complete: true }));
    assert.equal(find(), null);
    rmSync(evidence.manifestPath);
    assert.equal(find(), null);
  } finally {
    rmSync(evidence.root, { recursive: true, force: true });
  }
});

test("old schemas and mismatched receipt identities are ignored", () => {
  const evidence = createCacheEvidence();
  try {
    assert.equal(findReusableResult(
      [{ ...evidence.record, schemaVersion: VERIFICATION_SCHEMA_VERSION - 1 }],
      evidence.identities,
      "changed",
      { root: evidence.root },
    ), null);
    assert.equal(findReusableResult(
      [evidence.record],
      { ...evidence.identities, planningIdentity: "c".repeat(64) },
      "changed",
      { root: evidence.root },
    ), null);
  } finally {
    rmSync(evidence.root, { recursive: true, force: true });
  }
});

test("cache evidence rejects a manifest that escapes through a directory link", () => {
  const evidence = createCacheEvidence();
  const outside = mkdtempSync(resolve(tmpdir(), "mcode-verify-manifest-escape-"));
  const runDirectory = resolve(evidence.root, "runs", "run-1");
  try {
    const manifest = readFileSync(evidence.manifestPath);
    rmSync(runDirectory, { recursive: true, force: true });
    writeFileSync(resolve(outside, "manifest.json"), manifest);
    linkDirectory(outside, runDirectory);
    assert.equal(findReusableResult(
      [evidence.record], evidence.identities, "changed", { root: evidence.root },
    ), null);
  } finally {
    if (existsSync(runDirectory)) unlinkSync(runDirectory);
    rmSync(evidence.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cache evidence rejects a phase log that escapes through a directory link", () => {
  const evidence = createCacheEvidence();
  const outside = mkdtempSync(resolve(tmpdir(), "mcode-verify-log-escape-"));
  const logDirectory = resolve(evidence.root, "runs", "run-1", "logs");
  try {
    writeFileSync(resolve(outside, "01-test.log"), "outside evidence\n");
    linkDirectory(outside, logDirectory);
    const manifest = JSON.parse(readFileSync(evidence.manifestPath, "utf8"));
    manifest.phases[0].logPath = resolve(logDirectory, "01-test.log");
    writeFileSync(evidence.manifestPath, JSON.stringify(manifest));
    assert.equal(findReusableResult(
      [evidence.record], evidence.identities, "changed", { root: evidence.root },
    ), null);
  } finally {
    if (existsSync(logDirectory)) unlinkSync(logDirectory);
    rmSync(evidence.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cache evidence with an evicted phase log is ignored", () => {
  const evidence = createCacheEvidence();
  try {
    rmSync(evidence.logPath);
    assert.equal(
      findReusableResult(
        [evidence.record], evidence.identities, "changed", { root: evidence.root },
      ),
      null,
    );
  } finally {
    rmSync(evidence.root, { recursive: true, force: true });
  }
});

test("parallel phases aggregate the first failure after every phase completes", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-concurrent-"));
  const releasePath = resolve(cwd, "release");
  const makeWaitingPhase = (name, code) => bunPhase(name, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(resolve(cwd, `${name}.ready`))}, 'ready');`,
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); process.exit(${code}); } }, 25);`,
  ].join("\n"));
  try {
    const pending = runPhasesInParallel([
      makeWaitingPhase("slow-pass", 0),
      makeWaitingPhase("first-failure", 3),
      makeWaitingPhase("second-failure", 5),
    ], { printer: () => {} });
    const readyPaths = ["slow-pass", "first-failure", "second-failure"]
      .map((name) => resolve(cwd, `${name}.ready`));
    for (let attempt = 0; attempt < 600 && !readyPaths.every(existsSync); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(readyPaths.every(existsSync), true, "all phases should start before any completes");
    writeFileSync(releasePath, "release");
    const { code, results } = await pending;
    assert.equal(code, 3);
    assert.deepEqual(results.map((result) => result.code), [0, 3, 5]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent script tests start after the parallel core phases settle", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-lanes-"));
  const marker = resolve(cwd, "core-complete.txt");
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
    assert.equal(code, 0);
    assert.deepEqual(results.map((result) => result.name), ["Typecheck", SCRIPT_TEST_PHASE.name]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("full logs are created only when a run directory is supplied", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "mcode-verify-run-"));
  try {
    const { results } = await runPhasesInParallel(
      [bunPhase("Example", "console.log('evidence')")],
      { runDirectory: cwd, printer: () => {} },
    );
    assert.ok(results[0].logPath);
    assert.equal(existsSync(results[0].logPath), true);
    assert.match(readFileSync(results[0].logPath, "utf8"), /evidence/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
