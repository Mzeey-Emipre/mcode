#!/usr/bin/env node
/** Prepares the owned Windows launcher for the Codex protocol-notice fixture. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  assertInsideDevDir,
  getRuntimePaths,
  resolveRepoRoot,
} from "../../../../scripts/agent/runtime-contract.mjs";

const SCRIPT_DIRECTORY = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = NodePath.join(SCRIPT_DIRECTORY, "codex-protocol-notices-fixture.mjs");
const EVIDENCE_DIRECTORY = NodePath.join(".dev", "verification", "codex-protocol-notices");
const WRAPPER_FILE = "codex-protocol-notices-fixture.cmd";

const HELP = `Prepare the Codex protocol-notice fixture

Usage:
  bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop codex-protocol-notices <command> [options]

Commands:
  check
      Run exact protocol and command-line checks. Does not start Mcode or Codex.
  setup
      Write an owned Windows Codex CLI wrapper and print its absolute path.
  inspect
      Report whether the owned wrapper is present.
  cleanup --confirm-cleanup
      Remove only the owned wrapper after the Electron setting is restored.

Fixture limits:
  One fresh fixture process supports one turn. It emits duplicate config and reroute
  deliveries plus one guardian security warning, plain warning, auth recovery notice,
  and terminal answer.
  It does not simulate a real upstream condition, deprecation notice, or Windows path scan.`;

/** Parses the public fixture-control command without starting a process. */
export function parseCodexProtocolNoticeArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...options] = argv;
  if (!["check", "setup", "inspect", "cleanup"].includes(command)) {
    throw new Error(`Unknown command: ${String(command)}`);
  }
  if (command === "cleanup") {
    if (options.length === 1 && options[0] === "--confirm-cleanup") return { command };
    throw new Error("cleanup requires --confirm-cleanup");
  }
  if (options.length !== 0) throw new Error(`${command} does not accept options`);
  return { command };
}

/** Renders the wrapper that Codex invokes as `<configured path> app-server`. */
export function renderFixtureWrapper(runtimeExecutable, fixtureSource) {
  assertSafeWrapperPath(runtimeExecutable, "runtime executable");
  assertSafeWrapperPath(fixtureSource, "fixture source");
  return `@echo off\r\n"${runtimeExecutable}" "${fixtureSource}" %*\r\n`;
}

async function main() {
  const parsed = parseCodexProtocolNoticeArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const repoRoot = resolveRepoRoot();
  const output = await execute(parsed, repoRoot);
  process.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, ...output }, null, 2)}\n`);
}

async function execute(parsed, repoRoot) {
  if (parsed.command === "check") return { testFile: await check() };
  if (parsed.command === "setup") return setup(repoRoot);
  if (parsed.command === "inspect") return inspect(repoRoot);
  return cleanup(repoRoot);
}

function check() {
  const testFile = NodePath.join(SCRIPT_DIRECTORY, "codex-protocol-notices.test.mjs");
  const result = NodeChildProcess.spawnSync("node", ["--test", testFile], {
    cwd: SCRIPT_DIRECTORY,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Codex protocol-notice fixture checks failed");
  return ".agents/skills/verify-mcode/scripts/codex-protocol-notices.test.mjs";
}

function setup(repoRoot) {
  const wrapperPath = fixtureWrapperPath(repoRoot);
  const contents = renderFixtureWrapper(process.execPath, FIXTURE_SOURCE);
  const created = ensureOwnedWrapper(wrapperPath, contents, repoRoot);
  return { cliPath: wrapperPath, created, fixtureDriven: true };
}

function inspect(repoRoot) {
  const wrapperPath = fixtureWrapperPath(repoRoot);
  const present = NodeFS.existsSync(wrapperPath);
  if (present) assertOwnedWrapper(wrapperPath, renderFixtureWrapper(process.execPath, FIXTURE_SOURCE));
  return { cliPath: wrapperPath, fixtureDriven: true, present };
}

function cleanup(repoRoot) {
  const wrapperPath = fixtureWrapperPath(repoRoot);
  if (!NodeFS.existsSync(wrapperPath)) return { wrapperRemoved: false };
  assertOwnedWrapper(wrapperPath, renderFixtureWrapper(process.execPath, FIXTURE_SOURCE));
  NodeFS.rmSync(wrapperPath);
  return { wrapperRemoved: true };
}

function fixtureWrapperPath(repoRoot) {
  const directory = NodePath.resolve(repoRoot, EVIDENCE_DIRECTORY);
  const devDirectory = getRuntimePaths(repoRoot).devDir;
  assertInsideDevDir(directory, devDirectory);
  ensureRealDirectory(directory);
  return NodePath.join(directory, WRAPPER_FILE);
}

function ensureRealDirectory(directory) {
  const parts = [];
  let current = directory;
  while (!NodeFS.existsSync(current)) {
    parts.push(current);
    const parent = NodePath.dirname(current);
    if (parent === current) throw new Error("The fixture evidence directory has no parent");
    current = parent;
  }
  if (NodeFS.lstatSync(current).isSymbolicLink()) throw new Error("The fixture evidence directory is linked");
  for (const path of parts.reverse()) NodeFS.mkdirSync(path);
  if (NodeFS.lstatSync(directory).isSymbolicLink()) throw new Error("The fixture evidence directory is linked");
}

function ensureOwnedWrapper(wrapperPath, contents, repoRoot) {
  if (NodeFS.existsSync(wrapperPath)) {
    assertOwnedWrapper(wrapperPath, contents);
    return false;
  }
  assertInsideDevDir(wrapperPath, getRuntimePaths(repoRoot).devDir);
  const descriptor = NodeFS.openSync(wrapperPath, "wx", 0o600);
  try {
    NodeFS.writeFileSync(descriptor, contents, "utf8");
  } finally {
    NodeFS.closeSync(descriptor);
  }
  return true;
}

function assertOwnedWrapper(wrapperPath, contents) {
  const status = NodeFS.lstatSync(wrapperPath);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("The fixture wrapper is not an owned regular file");
  if (NodeFS.readFileSync(wrapperPath, "utf8") !== contents) throw new Error("The fixture wrapper content does not match this verifier");
}

function assertSafeWrapperPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || /["%\r\n\0]/.test(value)) {
    throw new Error(`The ${label} cannot be written to a Windows command wrapper`);
  }
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
