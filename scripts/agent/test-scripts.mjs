#!/usr/bin/env bun
/** Run maintained agent script tests one file at a time under Bun. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const testDirectory = NodePath.resolve(process.cwd(), "scripts", "agent", "__tests__");
const NODE_RUNTIME_TEST_FILES = new Set([
  "electron-live-testing.test.mjs",
  "frontend-performance-runner.test.mjs",
  "packaged-windows-acceleration-runner.test.mjs",
]);

/** Finds maintained agent test files and fails closed when none exist. */
export function discoverAgentTestFiles(directory) {
  const testFiles = NodeFS.readdirSync(directory)
    .filter((file) => file.endsWith(".test.mjs"))
    .sort();
  if (testFiles.length === 0) {
    throw new Error(`No agent tests found in ${directory}`);
  }
  return testFiles;
}

const invokedScript = process.argv[1] ? NodePath.resolve(process.argv[1]) : null;
if (invokedScript === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  for (const file of discoverAgentTestFiles(testDirectory)) {
    const testFile = NodePath.resolve(testDirectory, file);
    // Bun cannot read the skill module under this worktree's Windows ACLs.
    const command = NODE_RUNTIME_TEST_FILES.has(file) ? "node" : process.execPath;
    const argumentsForCommand = NODE_RUNTIME_TEST_FILES.has(file)
      ? ["--test", testFile]
      : ["test", testFile];
    const result = NodeChildProcess.spawnSync(command, argumentsForCommand, {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
