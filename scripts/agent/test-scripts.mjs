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

/** Selects maintained agent tests, rejecting paths outside the test directory. */
export function selectAgentTestFiles(directory, requestedFiles) {
  if (requestedFiles.length === 0) {
    return discoverAgentTestFiles(directory).map((file) => NodePath.join(directory, file));
  }

  return requestedFiles.map((requestedFile) => {
    const testFile = NodePath.resolve(process.cwd(), requestedFile);
    const relativePath = NodePath.relative(directory, testFile);
    if (
      !testFile.endsWith(".test.mjs")
      || relativePath === ""
      || relativePath.startsWith(`..${NodePath.sep}`)
      || NodePath.isAbsolute(relativePath)
      || NodePath.dirname(relativePath) !== "."
      || !NodeFS.existsSync(testFile)
      || !NodeFS.lstatSync(testFile).isFile()
    ) {
      throw new Error(`Expected a maintained agent test file: ${requestedFile}`);
    }
    return testFile;
  });
}

const invokedScript = process.argv[1] ? NodePath.resolve(process.argv[1]) : null;
if (invokedScript === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  for (const testFile of selectAgentTestFiles(testDirectory, process.argv.slice(2))) {
    const file = NodePath.basename(testFile);
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
