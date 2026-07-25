#!/usr/bin/env node
/**
 * Validates the Node.js executable against the repository's .node-version.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const EXACT_NODE_VERSION = /^\d+\.\d+\.\d+$/;

/** Reads the exact Node.js version required by the repository. */
export function readRequiredNodeVersion({ rootDir = repositoryRoot } = {}) {
  const versionPath = resolve(rootDir, ".node-version");
  const version = readFileSync(versionPath, "utf8").trim();
  if (!EXACT_NODE_VERSION.test(version)) {
    throw new Error(`${versionPath} must contain one exact semantic version.`);
  }
  const packagePath = resolve(rootDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.engines?.node !== version) {
    throw new Error("package.json engines.node must match .node-version exactly.");
  }
  return version;
}

/**
 * Checks the active Node.js executable and prints recovery guidance on mismatch.
 */
export function validateNodeRuntime({
  rootDir = repositoryRoot,
  actualVersion = process.version,
  execPath = process.execPath,
  printer = console.error,
} = {}) {
  let expectedVersion;
  try {
    expectedVersion = readRequiredNodeVersion({ rootDir });
  } catch (error) {
    printer(`Node runtime check failed: ${error.message}`);
    return { ok: false, expectedVersion: null, actualVersion, execPath };
  }

  const expectedWithPrefix = `v${expectedVersion}`;
  if (actualVersion === expectedWithPrefix) {
    return { ok: true, expectedVersion, actualVersion, execPath };
  }

  printer([
    "Node runtime mismatch.",
    `Expected: ${expectedWithPrefix}`,
    `Actual: ${actualVersion}`,
    `Executable: ${execPath}`,
    `Recovery: Switch to Node ${expectedVersion} with your version manager, then rerun the command.`,
    "Tools that support .node-version can select the repository version automatically.",
  ].join("\n"));
  return { ok: false, expectedVersion, actualVersion, execPath };
}

function main() {
  const result = validateNodeRuntime();
  if (!result.ok) process.exit(1);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();
