#!/usr/bin/env bun
/**
 * Runs Mcode's verification gates and records durable receipts for Stop hooks.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import { ensureDependencies } from "./ensure-dependencies.mjs";

const isWindows = process.platform === "win32";
/** Maximum child output retained in memory for one phase. */
export const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024;
/** Maximum failure excerpt printed to the terminal. */
export const MAX_FAILURE_EXCERPT_CHARS = 6_000;
/** Maximum displayed argv length in terminal diagnostics. */
export const MAX_DISPLAYED_ARGV_CHARS = 1_000;
/** Maximum changed files passed to one related-test process. */
export const MAX_RELATED_FILES = 100;
/** Maximum UTF-8 bytes in one related-test argument vector. */
export const MAX_RELATED_ARG_BYTES = 16 * 1024;
/** Maximum number of completed verification runs retained on disk. */
export const MAX_RETAINED_RUNS = 20;
/** Default phase timeout for direct verification. */
export const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60 * 1_000;
/** Fingerprint schema and gate-definition version. */
export const VERIFICATION_SCHEMA_VERSION = 2;

const TESTABLE_WORKSPACES = [
  "apps/web",
  "apps/server",
  "apps/desktop",
  "packages/contracts",
  "packages/shared",
];
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);
const AGENT_REFACTOR_COMPLEXITY_PREFIXES = [
  "apps/server/src/features/agents/",
  "packages/providers/src/private/claude/",
  "packages/providers/src/private/codex/",
  "packages/providers/src/private/copilot/",
  "packages/providers/src/private/cursor/",
];
const ROOT_VERIFICATION_FILES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  "scripts/vitest-global-setup.ts",
  "scripts/vitest-test-dir.ts",
]);
const AGENT_SCRIPT_TEST_MAP = new Map([
  ["agent-down.mjs", "runtime-lifecycle.test.mjs"],
  ["agent-reset.mjs", "runtime-lifecycle.test.mjs"],
  ["agent-up.mjs", "runtime-lifecycle.test.mjs"],
  ["ensure-dependencies.mjs", "ensure-dependencies.test.mjs"],
  ["runtime-processes.mjs", "runtime-lifecycle.test.mjs"],
  ["test-scripts.mjs", "root-dev-script.test.mjs"],
  ["verify-tests.mjs", "verify-tests.test.mjs"],
]);
const IDENTITY_CONFIG_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  "scripts/agent/verify-tests.mjs",
];
const IDENTITY_ENV_KEYS = [
  "BUN_INSTALL",
  "CI",
  "FORCE_COLOR",
  "NODE_ENV",
  "NO_COLOR",
];

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

/** Static gate for production functions changed by the canonical agent refactor. */
export const AGENT_REFACTOR_COMPLEXITY_PHASE = {
  name: "Agent Refactor Complexity",
  command: "bun",
  args: ["run", "check:refactor-complexity"],
};

function selectAgentScriptTestPhases(changedFiles, cwd) {
  const tests = new Set();
  let needsFullScriptSuite = false;
  for (const file of changedFiles.filter((path) => path.startsWith("scripts/agent/"))) {
    if (file.startsWith("scripts/agent/__tests__/") && file.endsWith(".test.mjs")) {
      tests.add(file);
      continue;
    }
    const mapped = AGENT_SCRIPT_TEST_MAP.get(basename(file))
      ?? (file.startsWith("scripts/agent/hooks/") ? "verify-tests.test.mjs" : null);
    if (mapped) tests.add(`scripts/agent/__tests__/${mapped}`);
    else needsFullScriptSuite = true;
  }
  if (needsFullScriptSuite) return [{ ...SCRIPT_TEST_PHASE, cwd }];
  return [...tests].sort().map((file) => ({
    name: `Agent Script Test (${basename(file)})`,
    command: "bun",
    args: ["test", resolvePath(cwd, file)],
    cwd,
    group: "scripts",
  }));
}

/** Default phases for the complete regression gate. */
export const DEFAULT_PHASES = [
  { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
  { name: "Lint", command: "bun", args: ["run", "lint"] },
  FULL_TEST_PHASE,
];

/** Returns whether a repository-relative path can affect verification. */
export function isVerificationRelevant(file) {
  const normalized = file.replaceAll("\\", "/");
  if (isVerificationConfig(normalized)) return true;
  if (normalized.startsWith("scripts/agent/")) return true;
  if (basename(normalized) === "package.json") return true;
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 && CODE_EXTENSIONS.has(normalized.slice(dot));
}

/** Returns whether a changed file needs the agent-refactor complexity gate. */
export function isAgentRefactorProductionSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return AGENT_REFACTOR_COMPLEXITY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    && [".ts", ".tsx", ".mts", ".cts"].some((extension) => normalized.endsWith(extension))
    && !normalized.includes("/__tests__/")
    && !normalized.endsWith(".test.ts")
    && !normalized.endsWith(".spec.ts");
}

function isVerificationConfig(file) {
  const name = basename(file).toLowerCase();
  return ROOT_VERIFICATION_FILES.has(file)
    || name === "package.json"
    || name === "turbo.json"
    || name === "bun.lock"
    || name === "bun.lockb"
    || /^tsconfig(?:\.[^/]+)?\.json$/.test(name)
    || /^eslint\.config\./.test(name)
    || /^\.eslintrc(?:\.|$)/.test(name)
    || /^vitest\.(?:config|workspace|setup)\./.test(name)
    || /^vite\.config\./.test(name)
    || /^(?:test-setup|setuptests)\./.test(name);
}

function parseNulPaths(raw) {
  return raw.split("\0").filter(Boolean);
}

function git(args, cwd, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Lists verification-relevant committed, staged, unstaged, and untracked files.
 * Returns null when repository state cannot be inspected safely.
 */
export function getChangedFiles({ cwd = process.cwd() } = {}) {
  try {
    const seen = new Set();
    const add = (raw) => {
      for (const file of parseNulPaths(raw)) {
        if (isVerificationRelevant(file)) seen.add(file);
      }
    };
    add(git(["diff", "--name-only", "-z", "HEAD"], cwd));
    add(git(["ls-files", "--others", "--exclude-standard", "-z"], cwd));
    const mergeBase = git(["merge-base", "HEAD", "main"], cwd).trim();
    if (mergeBase) add(git(["diff", "--name-only", "-z", mergeBase, "HEAD"], cwd));
    return [...seen].sort();
  } catch {
    return null;
  }
}

/** Returns true when the current repository has verification-relevant changes. */
export function hasCodeChanges(options) {
  const files = getChangedFiles(options);
  return files === null || files.length > 0;
}

/** Plans the smallest safe maintained test scope for the changed files. */
export function selectTestPhases(changedFiles, { forceFull = false, cwd = process.cwd() } = {}) {
  if (changedFiles === null) return [];
  if (forceFull) {
    return changedFiles.some((file) => file.startsWith("scripts/agent/"))
      ? [FULL_TEST_PHASE, { ...SCRIPT_TEST_PHASE, cwd }]
      : [FULL_TEST_PHASE];
  }
  if (changedFiles.length === 0) return [];

  const needsScriptTests = changedFiles.some((file) => file.startsWith("scripts/agent/"));
  const phases = [];
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
  for (const [workspace, files] of buckets) {
    const isServer = workspace === "apps/server";
    const relatedArgsPrefix = isServer
      ? [
        "../../scripts/run-electron-node.mjs",
        "--workspace-cli",
        "vitest",
        "vitest.mjs",
        "related",
      ]
      : ["vitest", "related"];
    const buildRelatedArgs = (filesChunk) => [
      ...relatedArgsPrefix,
      ...filesChunk,
      "--run",
    ];
    const chunks = [];
    let chunk = [];
    for (const file of files) {
      const candidate = [...chunk, file];
      const argvBytes = Buffer.byteLength(JSON.stringify(buildRelatedArgs(candidate)));
      if (chunk.length > 0
        && (candidate.length > MAX_RELATED_FILES || argvBytes > MAX_RELATED_ARG_BYTES)) {
        chunks.push(chunk);
        chunk = [file];
      } else {
        chunk = candidate;
      }
    }
    if (chunk.length > 0) chunks.push(chunk);
    for (const [index, filesChunk] of chunks.entries()) {
      const suffix = chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : "";
      phases.push({
        name: `Unit Tests (${workspace}${suffix})`,
        command: isServer ? "bun" : "bunx",
        args: buildRelatedArgs(filesChunk),
        cwd: resolvePath(cwd, workspace),
      });
    }
  }

  if (needsScriptTests) phases.push(...selectAgentScriptTestPhases(changedFiles, cwd));
  return phases;
}

/** Builds typecheck, lint, and the selected maintained test phases. */
export function buildPhases(changedFiles, options = {}) {
  return [
    { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
    { name: "Lint", command: "bun", args: ["run", "lint"] },
    ...(changedFiles?.some(isAgentRefactorProductionSource) ? [AGENT_REFACTOR_COMPLEXITY_PHASE] : []),
    ...selectTestPhases(changedFiles, options),
  ];
}

function appendBounded(buffer, chunk, maxBytes = MAX_RETAINED_OUTPUT_BYTES) {
  const combined = Buffer.concat([buffer, Buffer.from(chunk)]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

function terminateProcessTree(child, force = false) {
  if (!child.pid) return null;
  if (isWindows) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return null;
    try { child.kill("SIGKILL"); } catch { /* Process already exited. */ }
    const error = result.error?.message ?? (
      String(result.stderr ?? "").trim()
      || String(result.stdout ?? "").trim()
      || `taskkill exited with ${result.status ?? "an unknown status"}`
    );
    return error.slice(0, MAX_FAILURE_EXCERPT_CHARS);
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Process already exited. */ }
  }
  return null;
}

/** Formats a bounded argv display without interpreting shell metacharacters. */
export function formatArgvDisplay(command, args = []) {
  const serialized = JSON.stringify([command, ...args]);
  return serialized.length <= MAX_DISPLAYED_ARGV_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_DISPLAYED_ARGV_CHARS)}...[truncated]`;
}

/** Returns an exact command only when every token is shell-neutral and bounded. */
export function formatSafeReproduction(command, args = []) {
  const tokens = [command, ...args];
  if (!tokens.every((token) => /^[A-Za-z0-9_./:@=+\\-]+$/.test(token))) return null;
  const reproduction = tokens.join(" ");
  return reproduction.length <= MAX_DISPLAYED_ARGV_CHARS ? reproduction : null;
}

function resolveSafeExecutable(command, env) {
  if (!isWindows || isAbsolute(command)) return command;
  try {
    const matches = execFileSync("where.exe", [command], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).split(/\r?\n/).filter(Boolean);
    return matches.find((match) => [".exe", ".com"].includes(extname(match).toLowerCase()))
      ?? command;
  } catch {
    return command;
  }
}

/** Compares normalized PATH entries with platform-appropriate case sensitivity. */
export function pathEntriesMatch(left, right, { platform = process.platform } = {}) {
  const normalizedLeft = resolvePath(left);
  const normalizedRight = resolvePath(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Places the Bun executable directory first in PATH for child phases. */
export function withBunPath(
  env = process.env,
  execPath = process.execPath,
  options = {},
) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const bunDirectory = dirname(execPath);
  const entries = currentPath.split(delimiter).filter(Boolean);
  const remaining = entries.filter(
    (entry) => !pathEntriesMatch(entry, bunDirectory, options),
  );
  const normalized = { ...env };
  for (const key of Object.keys(normalized)) {
    if (key !== pathKey && key.toLowerCase() === "path") delete normalized[key];
  }
  normalized[pathKey] = [bunDirectory, ...remaining].join(delimiter);
  return normalized;
}

/** Runs one phase while streaming its complete output and retaining a bounded tail. */
export function runPhase({
  name,
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  signal,
  logPath,
}) {
  return new Promise((resolve) => {
    const phaseEnv = withBunPath(env, process.execPath);
    const startedAt = Date.now();
    let tail = Buffer.alloc(0);
    let settled = false;
    let finishing = false;
    let exitCondition = "nonzero";
    let spawnError;
    let logError;
    let terminationError;
    const output = logPath ? createWriteStream(logPath, { flags: "wx" }) : null;
    const executable = resolveSafeExecutable(command, phaseEnv);
    const child = spawn(executable, args, {
      cwd,
      env: phaseEnv,
      shell: false,
      detached: !isWindows,
      windowsHide: true,
    });
    const retain = (chunk) => {
      tail = appendBounded(tail, chunk);
      if (!logError && !output?.destroyed) output?.write(chunk);
    };
    child.stdout?.on("data", retain);
    child.stderr?.on("data", retain);

    const terminate = (force = false) => {
      terminationError ??= terminateProcessTree(child, force) ?? undefined;
    };

    let forceKillTimer;
    let settlementTimer;
    const complete = (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      clearTimeout(settlementTimer);
      signal?.removeEventListener("abort", cancel);
      if (child.exitCode === null && child.signalCode === null) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      const normalizedCode = code ?? 1;
      if (logError) exitCondition = "log-error";
      else if (spawnError) exitCondition = "spawn-error";
      else if (exitCondition === "timeout" || exitCondition === "cancelled") { /* Keep cause. */ }
      else if (childSignal) exitCondition = "signal";
      else exitCondition = normalizedCode === 0 ? "success" : "nonzero";
      const result = {
        name,
        code: normalizedCode,
        signal: childSignal ?? null,
        exitCondition,
        spawnError,
        logError,
        terminationError,
        output: tail.toString("utf8"),
        outputTruncated: tail.length >= MAX_RETAINED_OUTPUT_BYTES,
        durationMs: Date.now() - startedAt,
        command,
        args,
        cwd,
        argvDisplay: formatArgvDisplay(command, args),
        reproduction: formatSafeReproduction(command, args),
        logPath: logPath ?? null,
      };
      resolve(result);
    };
    const finish = (code, childSignal) => {
      if (settled || finishing) return;
      finishing = true;
      if (output && !output.destroyed && !logError) {
        output.end(() => complete(code, childSignal));
        return;
      }
      complete(code, childSignal);
    };
    output?.once("error", (error) => {
      if (settled) return;
      logError = error.message;
      tail = appendBounded(tail, Buffer.from(`[log error] ${error.message}\n`));
      terminate();
      output.destroy();
      complete(1, null);
    });
    const cancel = () => {
      exitCondition = "cancelled";
      terminate();
      if (!isWindows) {
        forceKillTimer = setTimeout(() => terminate(true), 500);
      }
      settlementTimer = setTimeout(() => finish(1, null), 2_000);
    };
    const timeout = setTimeout(() => {
      exitCondition = "timeout";
      terminate();
      if (!isWindows) {
        forceKillTimer = setTimeout(() => terminate(true), 500);
      }
      settlementTimer = setTimeout(() => finish(1, null), 2_000);
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on("error", (error) => {
      spawnError = typeof error.code === "string" ? `${error.code}: ${error.message}` : error.message;
      retain(Buffer.from(`[spawn error] ${spawnError}\n`));
      finish(1, null);
    });
    child.on("close", finish);
  });
}

function failureExcerpt(output) {
  if (output.length <= MAX_FAILURE_EXCERPT_CHARS) return output.trim();
  return `[earlier output omitted]\n${output.slice(-MAX_FAILURE_EXCERPT_CHARS).trim()}`;
}

/** Runs phases concurrently and prints concise summaries or bounded diagnostics. */
export async function runPhasesInParallel(
  phases,
  { printer = console.log, runDirectory, timeoutMs, signal, logIndexOffset = 0 } = {},
) {
  const results = await Promise.all(phases.map((phase, index) => runPhase({
    ...phase,
    timeoutMs: phase.timeoutMs ?? timeoutMs,
    signal,
    logPath: runDirectory
      ? resolvePath(runDirectory, `${String(logIndexOffset + index + 1).padStart(2, "0")}-${phase.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.log`)
      : undefined,
  })));
  let code = 0;
  for (const result of results) {
    const seconds = (result.durationMs / 1_000).toFixed(1);
    if (result.exitCondition === "success") {
      printer(`${result.name}: PASS (${seconds}s)`);
      continue;
    }
    if (code === 0) code = result.code || 1;
    printer(`${result.name}: FAIL (${seconds}s)`);
    printer(`Argv: ${result.argvDisplay}`);
    if (result.reproduction) printer(`Reproduce: ${result.reproduction}`);
    printer(`Working directory: ${result.cwd}`);
    const detail = result.exitCondition === "nonzero"
      ? `nonzero exit ${result.code}`
      : result.exitCondition === "signal"
        ? `signal ${result.signal}`
        : result.exitCondition === "spawn-error"
          ? `spawn error: ${result.spawnError}`
          : result.exitCondition;
    printer(`Exit condition: ${detail}`);
    const excerpt = failureExcerpt(result.output);
    if (excerpt) printer(`Diagnostic excerpt:\n${excerpt}`);
    if (result.logPath) printer(`Full log: ${result.logPath}`);
  }
  return { code, results };
}

/** Runs core phases in parallel, then agent script tests without resource contention. */
export async function runVerificationPhases(phases, options = {}) {
  const isScriptPhase = (phase) => phase.name === SCRIPT_TEST_PHASE.name || phase.group === "scripts";
  const corePhases = phases.filter((phase) => !isScriptPhase(phase));
  const scriptPhases = phases.filter(isScriptPhase);
  const core = await runPhasesInParallel(corePhases, options);
  if (scriptPhases.length === 0) return core;

  const scripts = await runPhasesInParallel(scriptPhases, {
    ...options,
    logIndexOffset: corePhases.length,
  });
  return {
    code: core.code || scripts.code,
    results: [...core.results, ...scripts.results],
  };
}

function hashPart(hash, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(`${label.length}:${label}:${bytes.length}:`);
  hash.update(bytes);
}

function safeRepositoryPath(cwd, file) {
  const normalized = file.replaceAll("\\", "/");
  if (
    normalized.includes("\0")
    || isAbsolute(normalized)
    || normalized.split("/").some((part) => part === "..")
  ) return null;
  const path = resolvePath(cwd, normalized);
  return pathWithin(cwd, path) ? path : null;
}

function hashEffectivePath(hash, cwd, file) {
  const path = safeRepositoryPath(cwd, file);
  if (!path) throw new Error(`Unsafe repository path: ${file}`);
  const normalized = file.replaceAll("\\", "/");
  let ancestor = cwd;
  for (const part of normalized.split("/").slice(0, -1)) {
    if (!part || part === ".") continue;
    ancestor = resolvePath(ancestor, part);
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(`Repository path crosses a link: ${file}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      hashPart(hash, `symlink:${file}`, readlinkSync(path));
    } else if (stats.isFile()) {
      hashPart(hash, `file:${file}`, readFileSync(path));
    } else {
      hashPart(hash, `unsupported:${file}`, stats.mode);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    hashPart(hash, `missing:${file}`, "");
  }
}

function phaseIdentity(phase, cwd) {
  return {
    name: phase.name,
    command: phase.command,
    args: phase.args,
    cwd: relative(cwd, phase.cwd ?? cwd).replaceAll("\\", "/"),
  };
}

/** Calculates content and planning identities for a verification receipt. */
export function calculateVerificationIdentities({
  cwd = process.cwd(),
  env = process.env,
  changedFiles = getChangedFiles({ cwd }),
} = {}) {
  try {
    if (changedFiles === null) return null;
    const files = [...new Set([...changedFiles, ...IDENTITY_CONFIG_FILES])].sort();
    const content = createHash("sha256");
    hashPart(content, "schema", VERIFICATION_SCHEMA_VERSION);
    hashPart(content, "platform", `${process.platform}/${process.arch}`);
    hashPart(content, "bun-runtime", `${process.execPath}\0${process.version}`);
    hashPart(content, "bun", execFileSync(process.execPath, ["--version"], {
      cwd,
      encoding: "utf8",
      env: withBunPath(env, process.execPath),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
    for (const file of files) hashEffectivePath(content, cwd, file);
    const environment = IDENTITY_ENV_KEYS.map((key) => [key, env[key] ?? null]);
    hashPart(content, "environment", JSON.stringify(environment));

    const planning = createHash("sha256");
    hashPart(planning, "schema", VERIFICATION_SCHEMA_VERSION);
    const mergeBase = git(["merge-base", "HEAD", "main"], cwd).trim();
    hashPart(planning, "merge-base", mergeBase);
    hashPart(planning, "changed-files", JSON.stringify(changedFiles));
    hashPart(planning, "changed-phases", JSON.stringify(
      buildPhases(changedFiles, { cwd }).map((phase) => phaseIdentity(phase, cwd)),
    ));
    return {
      contentIdentity: content.digest("hex"),
      planningIdentity: planning.digest("hex"),
    };
  } catch {
    return null;
  }
}

function artifactRoot(cwd) {
  return resolvePath(cwd, ".dev", "verification");
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx");
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function readReuseRecords(root) {
  try {
    const value = JSON.parse(readFileSync(resolvePath(root, "results.json"), "utf8"));
    return value.schemaVersion === VERIFICATION_SCHEMA_VERSION && Array.isArray(value.records)
      ? value.records
      : [];
  } catch {
    return [];
  }
}

function pathWithin(parent, candidate) {
  const resolvedParent = resolvePath(parent);
  const resolvedCandidate = resolvePath(candidate);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${sep}`);
}

function existingPathWithin(parent, candidate) {
  if (!pathWithin(parent, candidate)) return false;
  try {
    return pathWithin(realpathSync(parent), realpathSync(candidate));
  } catch {
    return false;
  }
}

function validateCachedManifest(record, root) {
  if (!existingPathWithin(resolvePath(root, "runs"), record.manifestPath)) {
    return false;
  }
  try {
    const manifest = JSON.parse(readFileSync(record.manifestPath, "utf8"));
    if (
      manifest.schemaVersion !== VERIFICATION_SCHEMA_VERSION
      || manifest.complete !== true
      || manifest.contentIdentity !== record.contentIdentity
      || manifest.planningIdentity !== record.planningIdentity
      || manifest.gate !== record.gate
      || manifest.code !== record.code
      || typeof manifest.skipped !== "boolean"
      || !Array.isArray(manifest.changedFiles)
      || !Array.isArray(manifest.phases)
    ) return false;
    return manifest.phases.every((phase) =>
      typeof phase === "object"
      && phase !== null
      && typeof phase.name === "string"
      && Number.isInteger(phase.code)
      && typeof phase.exitCondition === "string"
      && typeof phase.logPath === "string"
      && existingPathWithin(dirname(record.manifestPath), phase.logPath),
    );
  } catch {
    return false;
  }
}

function isCacheRecordShape(record) {
  return typeof record === "object"
    && record !== null
    && record.schemaVersion === VERIFICATION_SCHEMA_VERSION
    && record.complete === true
    && /^[a-f0-9]{64}$/.test(record.contentIdentity)
    && /^[a-f0-9]{64}$/.test(record.planningIdentity)
    && (record.gate === "changed" || record.gate === "full")
    && Number.isInteger(record.code)
    && record.code >= 0
    && typeof record.manifestPath === "string"
    && typeof record.startedAt === "string"
    && typeof record.completedAt === "string";
}

/** Finds a validated receipt whose gate covers the requested gate. */
export function findReusableResult(records, identities, requestedGate, { root } = {}) {
  if (!identities) return null;
  return records.find((record) =>
    isCacheRecordShape(record)
    && record.contentIdentity === identities.contentIdentity
    && record.planningIdentity === identities.planningIdentity
    && (
      record.gate === requestedGate
      || (requestedGate === "changed" && record.gate === "full" && record.code === 0)
    )
    && typeof root === "string"
    && validateCachedManifest(record, root),
  ) ?? null;
}

function recordResult(root, record) {
  const records = readReuseRecords(root)
    .filter((item) => !(
      item.contentIdentity === record.contentIdentity
      && item.planningIdentity === record.planningIdentity
      && item.gate === record.gate
    ));
  records.unshift(record);
  atomicWriteJson(resolvePath(root, "results.json"), {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    records: records.slice(0, MAX_RETAINED_RUNS),
  });
}

function pruneRuns(root) {
  const runsRoot = resolvePath(root, "runs");
  if (!existsSync(runsRoot)) return;
  const runs = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const stale of runs.slice(MAX_RETAINED_RUNS)) {
    rmSync(resolvePath(runsRoot, stale), { recursive: true, force: true });
  }
}

function summarizeCached(record) {
  const status = record.code === 0 ? "PASS" : "FAIL";
  return `Verification receipt: ${record.gate} gate ${status} (${record.manifestPath})`;
}

/** Inspects the current receipt without running phases or creating artifacts. */
export function inspectVerificationReceipt({
  cwd = process.cwd(),
  gate = "changed",
  env = process.env,
  printer = console.log,
} = {}) {
  const changedFiles = getChangedFiles({ cwd });
  if (changedFiles !== null && changedFiles.length === 0) {
    const message = "Verification receipt not required: no relevant changes.";
    printer(message);
    return { code: 0, approved: true, reason: message };
  }
  const identities = calculateVerificationIdentities({ cwd, env, changedFiles });
  const root = artifactRoot(cwd);
  const receipt = findReusableResult(readReuseRecords(root), identities, gate, { root });
  if (receipt) {
    const message = summarizeCached(receipt);
    printer(message);
    return {
      code: receipt.code === 0 ? 0 : 2,
      approved: receipt.code === 0,
      reason: message,
      manifestPath: receipt.manifestPath,
    };
  }
  const message = "Verification receipt missing or stale. Run bun run verify:changed";
  printer(message);
  return { code: 2, approved: false, reason: message };
}

/** Executes the selected gate and writes a complete receipt. */
export async function runVerification({
  cwd = process.cwd(),
  gate = "changed",
  printer = console.log,
  timeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const changedFiles = getChangedFiles({ cwd });
  const identities = calculateVerificationIdentities({ cwd, env, changedFiles });
  if (!identities) {
    printer("Verification failed: could not calculate receipt identities.");
    return { code: 1, identityFailure: true };
  }
  const root = artifactRoot(cwd);
  mkdirSync(resolvePath(root, "runs"), { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runDirectory = resolvePath(root, "runs", runId);
  mkdirSync(runDirectory, { recursive: true });
  const manifestPath = resolvePath(runDirectory, "manifest.json");
  const startedAt = new Date().toISOString();

  if (changedFiles !== null && changedFiles.length === 0) {
    const manifest = {
      schemaVersion: VERIFICATION_SCHEMA_VERSION,
      complete: true,
      gate,
      ...identities,
      code: 0,
      skipped: true,
      startedAt,
      completedAt: new Date().toISOString(),
      changedFiles,
      phases: [],
    };
    atomicWriteJson(manifestPath, manifest);
    recordResult(root, { ...manifest, manifestPath });
    printer("Verification skipped: no relevant changes.");
    pruneRuns(root);
    return { code: 0, manifestPath };
  }

  const phases = buildPhases(changedFiles, { forceFull: gate === "full", cwd });
  printer(`Verification started: ${gate} gate, ${phases.length} phase(s).`);
  const { code, results } = await runVerificationPhases(phases, {
    printer,
    runDirectory,
    timeoutMs,
  });
  const manifest = {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    complete: true,
    gate,
    ...identities,
    code,
    skipped: false,
    startedAt,
    completedAt: new Date().toISOString(),
    changedFiles,
    phases: results.map((result) => ({ ...result, output: undefined })),
  };
  atomicWriteJson(manifestPath, manifest);
  recordResult(root, { ...manifest, phases: undefined, manifestPath });
  printer(`Verification ${code === 0 ? "passed" : "failed"}. Manifest: ${manifestPath}`);
  pruneRuns(root);
  return { code, manifestPath, results };
}

async function main() {
  const gate = process.argv.includes("--full") ? "full" : "changed";
  if (process.argv.includes("--check-receipt")) {
    const result = inspectVerificationReceipt({ gate, printer: () => {} });
    const print = result.code === 0 ? console.log : console.error;
    print(result.reason);
    process.exit(result.code);
  }
  ensureDependencies();
  const result = await runVerification({ gate });
  process.exit(result.code);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
if (invokedDirectly) await main();
