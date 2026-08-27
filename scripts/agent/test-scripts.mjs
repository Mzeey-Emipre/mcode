#!/usr/bin/env bun
/** Run maintained agent script tests one file at a time under Bun. */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDirectory = resolve(process.cwd(), "scripts", "agent", "__tests__");
const NODE_RUNTIME_TEST_FILES = new Set([
  "electron-live-testing.test.mjs",
  "frontend-performance-runner.test.mjs",
  "packaged-windows-acceleration-runner.test.mjs",
]);

/** Finds maintained agent test files and fails closed when none exist. */
export function discoverAgentTestFiles(directory) {
  const testFiles = readdirSync(directory)
    .filter((file) => file.endsWith(".test.mjs"))
    .sort();
  if (testFiles.length === 0) {
    throw new Error(`No agent tests found in ${directory}`);
  }
  return testFiles;
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedScript === resolve(fileURLToPath(import.meta.url))) {
  for (const file of discoverAgentTestFiles(testDirectory)) {
    const testFile = resolve(testDirectory, file);
    // Bun cannot read the skill module under this worktree's Windows ACLs.
    const command = NODE_RUNTIME_TEST_FILES.has(file) ? "node" : process.execPath;
    const argumentsForCommand = NODE_RUNTIME_TEST_FILES.has(file)
      ? ["--test", testFile]
      : ["test", testFile];
    const result = spawnSync(command, argumentsForCommand, {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
