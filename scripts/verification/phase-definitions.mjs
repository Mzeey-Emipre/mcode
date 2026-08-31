/** Defines stable verification phases and changed-package test selection. */
import * as NodePath from "node:path";

import { isVerificationConfig, isVerificationScriptFile } from "./changed-file-discovery.mjs";

/** Maximum changed files passed to one related-test process. */
export const MAX_RELATED_FILES = 100;
/** Maximum UTF-8 bytes in one related-test argument vector. */
export const MAX_RELATED_ARG_BYTES = 16 * 1024;

const TESTABLE_WORKSPACES = [
  "apps/web",
  "apps/server",
  "apps/desktop",
  "packages/contracts",
  "packages/shared",
];
const AGENT_SCRIPT_TEST_MAP = new Map([
  ["agent-down.mjs", "runtime-lifecycle.test.mjs"],
  ["agent-reset.mjs", "runtime-lifecycle.test.mjs"],
  ["agent-up.mjs", "runtime-lifecycle.test.mjs"],
  ["ensure-dependencies.mjs", "ensure-dependencies.test.mjs"],
  ["runtime-processes.mjs", "runtime-lifecycle.test.mjs"],
  ["test-scripts.mjs", "root-dev-script.test.mjs"],
  ["verify-tests.mjs", "verify-tests.test.mjs"],
]);
const VERIFY_TEST_PATH = "scripts/agent/__tests__/verify-tests.test.mjs";

/** Full unit-test phase used by the final gate and conservative fallbacks. */
export const FULL_TEST_PHASE = {
  name: "Unit Tests",
  command: "bun",
  args: ["run", "test"],
};

/** Maintained script-test phase used when agent tooling changes. */
export const SCRIPT_TEST_PHASE = {
  name: "Agent Script Tests",
  command: "bun",
  args: ["run", "test:scripts"],
};

/** Default phases for the complete regression gate. */
export const DEFAULT_PHASES = [
  { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
  { name: "Lint", command: "bun", args: ["run", "lint"] },
  FULL_TEST_PHASE,
];

/** Plans the smallest safe maintained test scope for the changed files. */
export function selectTestPhases(changedFiles, { forceFull = false, cwd = process.cwd() } = {}) {
  if (changedFiles === null) return [];
  if (forceFull) return selectFullTestPhases(changedFiles, cwd);
  if (changedFiles.length === 0) return [];

  const phases = selectWorkspaceTestPhases(changedFiles, cwd);
  if (changedFiles.some(isVerificationScriptFile)) {
    phases.push(...selectVerificationScriptTestPhases(changedFiles, cwd));
  }
  return phases;
}

function selectFullTestPhases(changedFiles, cwd) {
  const phases = [FULL_TEST_PHASE];
  if (changedFiles.some(isVerificationScriptFile)) {
    phases.push({ ...SCRIPT_TEST_PHASE, cwd });
  }
  return phases;
}

function selectWorkspaceTestPhases(changedFiles, cwd) {
  const buckets = collectWorkspaceFiles(changedFiles);
  return [...buckets].flatMap(([workspace, files]) =>
    createRelatedTestPhases(workspace, files, cwd),
  );
}

function collectWorkspaceFiles(changedFiles) {
  const buckets = new Map();
  for (const file of changedFiles) {
    if (isVerificationConfig(file)) continue;
    const workspace = TESTABLE_WORKSPACES.find(
      (candidate) => file === candidate || file.startsWith(`${candidate}/`),
    );
    if (!workspace) continue;
    const files = buckets.get(workspace) ?? [];
    files.push(file.slice(workspace.length + 1));
    buckets.set(workspace, files);
  }
  return buckets;
}

function selectVerificationScriptTestPhases(changedFiles, cwd) {
  const tests = new Set();
  let needsFullScriptSuite = false;
  for (const file of changedFiles.filter(isVerificationScriptFile)) {
    if (file.startsWith("scripts/verification/")) {
      tests.add(VERIFY_TEST_PATH);
      continue;
    }
    if (file.startsWith("scripts/agent/__tests__/") && file.endsWith(".test.mjs")) {
      tests.add(file);
      continue;
    }
    const mapped = AGENT_SCRIPT_TEST_MAP.get(NodePath.basename(file))
      ?? (file.startsWith("scripts/agent/hooks/") ? "verify-tests.test.mjs" : null);
    if (mapped) tests.add(`scripts/agent/__tests__/${mapped}`);
    else needsFullScriptSuite = true;
  }
  if (needsFullScriptSuite) return [{ ...SCRIPT_TEST_PHASE, cwd }];
  return [...tests].sort().map((file) => ({
    name: `Agent Script Test (${NodePath.basename(file)})`,
    command: "bun",
    args: ["test", NodePath.resolve(cwd, file)],
    cwd,
    group: "scripts",
  }));
}

function createRelatedTestPhases(workspace, files, cwd) {
  const isServer = workspace === "apps/server";
  const buildArgs = (fileChunk) => [
    ...relatedTestArgumentsPrefix(workspace),
    ...fileChunk,
    "--run",
  ];
  const chunks = splitRelatedFiles(files, buildArgs);
  return chunks.map((fileChunk, index) => ({
    name: `Unit Tests (${workspace}${relatedTestPhaseSuffix(chunks, index)})`,
    command: isServer ? "bun" : "bunx",
    args: buildArgs(fileChunk),
    cwd: NodePath.resolve(cwd, workspace),
  }));
}

function relatedTestArgumentsPrefix(workspace) {
  return workspace === "apps/server"
    ? ["../../scripts/run-electron-node.mjs", "--workspace-cli", "vitest", "vitest.mjs", "related"]
    : ["vitest", "related"];
}

function splitRelatedFiles(files, buildArgs) {
  const chunks = [];
  let chunk = [];
  for (const file of files) {
    const candidate = [...chunk, file];
    if (chunk.length > 0 && exceedsRelatedTestBounds(candidate, buildArgs)) {
      chunks.push(chunk);
      chunk = [file];
    } else {
      chunk = candidate;
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function exceedsRelatedTestBounds(files, buildArgs) {
  return files.length > MAX_RELATED_FILES
    || Buffer.byteLength(JSON.stringify(buildArgs(files))) > MAX_RELATED_ARG_BYTES;
}

function relatedTestPhaseSuffix(chunks, index) {
  return chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : "";
}

/** Builds typecheck, lint, and the selected maintained test phases. */
export function buildPhases(changedFiles, options = {}) {
  return [
    { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
    { name: "Lint", command: "bun", args: ["run", "lint"] },
    ...selectTestPhases(changedFiles, options),
  ];
}
