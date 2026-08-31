/** Coordinates verification phases and durable receipt reuse. */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { getChangedFiles, git } from "./changed-file-discovery.mjs";
import { buildPhases } from "./phase-definitions.mjs";
import { DEFAULT_PHASE_TIMEOUT_MS, runVerificationPhases, withBunPath } from "./phase-runner.mjs";

/** Maximum number of completed verification runs retained on disk. */
export const MAX_RETAINED_RUNS = 20;
/** Fingerprint schema and gate-definition version. */
export const VERIFICATION_SCHEMA_VERSION = 2;

const IDENTITY_CONFIG_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  "scripts/agent/verify-tests.mjs",
  "scripts/verification/changed-file-discovery.mjs",
  "scripts/verification/phase-definitions.mjs",
  "scripts/verification/phase-runner.mjs",
  "scripts/verification/verification-coordinator.mjs",
];
const IDENTITY_ENV_KEYS = [
  "BUN_INSTALL",
  "CI",
  "FORCE_COLOR",
  "NODE_ENV",
  "NO_COLOR",
];

function hashPart(hash, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(`${label.length}:${label}:${bytes.length}:`);
  hash.update(bytes);
}

function safeRepositoryPath(cwd, file) {
  const normalized = file.replaceAll("\\", "/");
  if (
    normalized.includes("\0")
    || NodePath.isAbsolute(normalized)
    || normalized.split("/").some((part) => part === "..")
  ) return null;
  const path = NodePath.resolve(cwd, normalized);
  return pathWithin(cwd, path) ? path : null;
}

function hashEffectivePath(hash, cwd, file) {
  const path = safeRepositoryPath(cwd, file);
  if (!path) throw new Error(`Unsafe repository path: ${file}`);
  const normalized = file.replaceAll("\\", "/");
  assertNoSymbolicLinkAncestors(cwd, normalized, file);
  hashPathContent(hash, path, file);
}

function assertNoSymbolicLinkAncestors(cwd, normalized, file) {
  let ancestor = cwd;
  for (const part of normalized.split("/").slice(0, -1)) {
    if (!part || part === ".") continue;
    ancestor = NodePath.resolve(ancestor, part);
    if (isMissingPath(ancestor)) break;
    if (NodeFS.lstatSync(ancestor).isSymbolicLink()) {
      throw new Error(`Repository path crosses a link: ${file}`);
    }
  }
}

function isMissingPath(path) {
  try {
    NodeFS.lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function hashPathContent(hash, path, file) {
  try {
    hashExistingPathContent(hash, path, file, NodeFS.lstatSync(path));
  } catch (error) {
    if (error?.code === "ENOENT") {
      hashPart(hash, `missing:${file}`, "");
      return;
    }
    throw error;
  }
}

function hashExistingPathContent(hash, path, file, stats) {
  if (stats.isSymbolicLink()) {
    hashPart(hash, `symlink:${file}`, NodeFS.readlinkSync(path));
  } else if (stats.isFile()) {
    hashPart(hash, `file:${file}`, NodeFS.readFileSync(path));
  } else {
    hashPart(hash, `unsupported:${file}`, stats.mode);
  }
}

function phaseIdentity(phase, cwd) {
  return {
    name: phase.name,
    command: phase.command,
    args: phase.args,
    cwd: NodePath.relative(cwd, phase.cwd ?? cwd).replaceAll("\\", "/"),
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
    const content = NodeCrypto.createHash("sha256");
    hashPart(content, "schema", VERIFICATION_SCHEMA_VERSION);
    hashPart(content, "platform", `${process.platform}/${process.arch}`);
    hashPart(content, "bun-runtime", `${process.execPath}\0${process.version}`);
    hashPart(content, "bun", NodeChildProcess.execFileSync(process.execPath, ["--version"], {
      cwd,
      encoding: "utf8",
      env: withBunPath(env, process.execPath),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
    for (const file of files) hashEffectivePath(content, cwd, file);
    const environment = IDENTITY_ENV_KEYS.map((key) => [key, env[key] ?? null]);
    hashPart(content, "environment", JSON.stringify(environment));

    const planning = NodeCrypto.createHash("sha256");
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
  return NodePath.resolve(cwd, ".dev", "verification");
}

function atomicWriteJson(path, value) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  const descriptor = NodeFS.openSync(temporary, "wx");
  try {
    NodeFS.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    NodeFS.closeSync(descriptor);
  }
  NodeFS.renameSync(temporary, path);
}

function readReuseRecords(root) {
  try {
    const value = JSON.parse(NodeFS.readFileSync(NodePath.resolve(root, "results.json"), "utf8"));
    return value.schemaVersion === VERIFICATION_SCHEMA_VERSION && Array.isArray(value.records)
      ? value.records
      : [];
  } catch {
    return [];
  }
}

function pathWithin(parent, candidate) {
  const resolvedParent = NodePath.resolve(parent);
  const resolvedCandidate = NodePath.resolve(candidate);
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${NodePath.sep}`);
}

function existingPathWithin(parent, candidate) {
  if (!pathWithin(parent, candidate)) return false;
  try {
    return pathWithin(NodeFS.realpathSync(parent), NodeFS.realpathSync(candidate));
  } catch {
    return false;
  }
}

function validateCachedManifest(record, root) {
  if (!existingPathWithin(NodePath.resolve(root, "runs"), record.manifestPath)) {
    return false;
  }
  try {
    const manifest = JSON.parse(NodeFS.readFileSync(record.manifestPath, "utf8"));
    return hasValidManifestHeader(manifest, record)
      && manifest.phases.every((phase) => isValidManifestPhase(phase, record.manifestPath));
  } catch {
    return false;
  }
}

function hasValidManifestHeader(manifest, record) {
  return hasExpectedManifestIdentity(manifest, record)
    && typeof manifest.skipped === "boolean"
    && Array.isArray(manifest.changedFiles)
    && Array.isArray(manifest.phases);
}

function hasExpectedManifestIdentity(manifest, record) {
  return manifest.schemaVersion === VERIFICATION_SCHEMA_VERSION
    && manifest.complete === true
    && manifest.contentIdentity === record.contentIdentity
    && manifest.planningIdentity === record.planningIdentity
    && manifest.gate === record.gate
    && manifest.code === record.code;
}

function isValidManifestPhase(phase, manifestPath) {
  return isManifestPhaseShape(phase)
    && existingPathWithin(NodePath.dirname(manifestPath), phase.logPath);
}

function isManifestPhaseShape(phase) {
  return typeof phase === "object"
    && phase !== null
    && typeof phase.name === "string"
    && Number.isInteger(phase.code)
    && typeof phase.exitCondition === "string"
    && typeof phase.logPath === "string";
}

function isCacheRecordShape(record) {
  return isRecordObject(record)
    && hasCacheRecordIdentity(record)
    && hasCacheRecordResult(record)
    && hasCacheRecordTimestamps(record);
}

function isRecordObject(record) {
  return typeof record === "object" && record !== null;
}

function hasCacheRecordIdentity(record) {
  return record.schemaVersion === VERIFICATION_SCHEMA_VERSION
    && record.complete === true
    && /^[a-f0-9]{64}$/.test(record.contentIdentity)
    && /^[a-f0-9]{64}$/.test(record.planningIdentity);
}

function hasCacheRecordResult(record) {
  return (record.gate === "changed" || record.gate === "full")
    && Number.isInteger(record.code)
    && record.code >= 0
    && typeof record.manifestPath === "string";
}

function hasCacheRecordTimestamps(record) {
  return typeof record.startedAt === "string" && typeof record.completedAt === "string";
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
  atomicWriteJson(NodePath.resolve(root, "results.json"), {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    records: records.slice(0, MAX_RETAINED_RUNS),
  });
}

function pruneRuns(root) {
  const runsRoot = NodePath.resolve(root, "runs");
  if (!NodeFS.existsSync(runsRoot)) return;
  const runs = NodeFS.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const stale of runs.slice(MAX_RETAINED_RUNS)) {
    NodeFS.rmSync(NodePath.resolve(runsRoot, stale), { recursive: true, force: true });
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
  if (!identities) return reportIdentityFailure(printer);
  const run = createVerificationRun(cwd);
  if (changedFiles !== null && changedFiles.length === 0) {
    return writeSkippedVerification(run, { gate, identities, changedFiles, printer });
  }
  return runVerificationGate(run, { cwd, gate, identities, changedFiles, printer, timeoutMs });
}

function reportIdentityFailure(printer) {
  printer("Verification failed: could not calculate receipt identities.");
  return { code: 1, identityFailure: true };
}

function createVerificationRun(cwd) {
  const root = artifactRoot(cwd);
  NodeFS.mkdirSync(NodePath.resolve(root, "runs"), { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const runDirectory = NodePath.resolve(root, "runs", runId);
  NodeFS.mkdirSync(runDirectory, { recursive: true });
  return { root, runDirectory, manifestPath: NodePath.resolve(runDirectory, "manifest.json"), startedAt: new Date().toISOString() };
}

function writeSkippedVerification(run, { gate, identities, changedFiles, printer }) {
  const manifest = buildVerificationManifest({ gate, identities, changedFiles, startedAt: run.startedAt, code: 0, skipped: true, results: [] });
  writeVerificationReceipt(run, manifest);
  printer("Verification skipped: no relevant changes.");
  return { code: 0, manifestPath: run.manifestPath };
}

async function runVerificationGate(run, { cwd, gate, identities, changedFiles, printer, timeoutMs }) {
  const phases = buildPhases(changedFiles, { forceFull: gate === "full", cwd });
  printer(`Verification started: ${gate} gate, ${phases.length} phase(s).`);
  const { code, results } = await runVerificationPhases(phases, { printer, runDirectory: run.runDirectory, timeoutMs });
  const manifest = buildVerificationManifest({ gate, identities, changedFiles, startedAt: run.startedAt, code, skipped: false, results });
  writeVerificationReceipt(run, manifest);
  printer(`Verification ${code === 0 ? "passed" : "failed"}. Manifest: ${run.manifestPath}`);
  return { code, manifestPath: run.manifestPath, results };
}

function buildVerificationManifest({ gate, identities, changedFiles, startedAt, code, skipped, results }) {
  return {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    complete: true,
    gate,
    ...identities,
    code,
    skipped,
    startedAt,
    completedAt: new Date().toISOString(),
    changedFiles,
    phases: results.map((result) => ({ ...result, output: undefined })),
  };
}

function writeVerificationReceipt(run, manifest) {
  atomicWriteJson(run.manifestPath, manifest);
  recordResult(run.root, { ...manifest, phases: undefined, manifestPath: run.manifestPath });
  pruneRuns(run.root);
}
