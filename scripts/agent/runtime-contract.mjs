#!/usr/bin/env bun
/**
 * Defines the per-worktree agent runtime filesystem and port contract.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

export const DEV_DIR_NAME = ".dev";
export const PORTS_FILE_NAME = "ports.json";
export const DEFAULT_PORT_BASE = 41_000;
export const PORT_BUCKET_SIZE = 1_000;
export const INSTANCE_TOKEN_BYTES = 32;

/**
 * Generates a random token for pairing one dev UI with one worktree server.
 *
 * @returns {string}
 */
export function generateInstanceToken() {
  return NodeCrypto.randomBytes(INSTANCE_TOKEN_BYTES).toString("hex");
}

/**
 * Resolves the repository root for a path inside a git checkout.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveRepoRoot(cwd = process.cwd()) {
  return NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/**
 * Returns canonical paths for runtime artifacts under the repository `.dev`.
 *
 * @param {string} repoRoot
 * @returns {{ repoRoot: string, devDir: string, portsFile: string, fixtureRepoDir: string, dbDir: string, dbPath: string, logsDir: string, pidsDir: string, playwrightScratchDir: string, electronDir: string }}
 */
export function getRuntimePaths(repoRoot = resolveRepoRoot()) {
  const root = NodePath.resolve(repoRoot);
  const devDir = NodePath.join(root, DEV_DIR_NAME);
  const dbDir = NodePath.join(devDir, "db");
  return {
    repoRoot: root,
    devDir,
    portsFile: NodePath.join(devDir, PORTS_FILE_NAME),
    fixtureRepoDir: NodePath.join(devDir, "fixture-repo"),
    dbDir,
    dbPath: NodePath.join(dbDir, "app.sqlite"),
    logsDir: NodePath.join(devDir, "logs"),
    pidsDir: NodePath.join(devDir, "pids"),
    playwrightScratchDir: NodePath.join(devDir, "playwright-scratch"),
    electronDir: NodePath.join(devDir, "electron"),
  };
}

/**
 * Builds the environment variables that point a dev process at the worktree-local runtime state.
 *
 * @param {string} repoRoot
 * @param {Partial<NodeJS.ProcessEnv>} [overrides]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildRuntimeStateEnv(repoRoot = resolveRepoRoot(), overrides = {}) {
  const paths = getRuntimePaths(repoRoot);
  return {
    MCODE_AGENT_RUNTIME: "1",
    MCODE_DATA_DIR: paths.devDir,
    MCODE_DB_PATH: paths.dbPath,
    MCODE_ELECTRON_USER_DATA_DIR: paths.electronDir,
    ...overrides,
  };
}

/**
 * Verifies `.dev/` is ignored before runtime files are created.
 *
 * @param {string} repoRoot
 */
export function assertDevDirIgnored(repoRoot = resolveRepoRoot()) {
  const gitignorePath = NodePath.join(repoRoot, ".gitignore");
  const gitignore = NodeFS.readFileSync(gitignorePath, "utf8");
  const ignoresDevDir = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".dev/" || line === "/.dev/");

  if (!ignoresDevDir) {
    throw new Error(`${gitignorePath} must ignore .dev/ before runtime creation`);
  }
}

/**
 * Creates the runtime root after confirming it is ignored by git.
 *
 * @param {string} repoRoot
 * @returns {ReturnType<typeof getRuntimePaths>}
 */
export function ensureRuntimeRoot(repoRoot = resolveRepoRoot()) {
  assertDevDirIgnored(repoRoot);
  const paths = getRuntimePaths(repoRoot);
  assertRuntimeDirectorySafe(paths.devDir, "runtime directory", true);
  NodeFS.mkdirSync(paths.devDir, { recursive: true });
  return paths;
}

/** Rejects linked runtime paths before lifecycle commands read or write them. */
export function assertRuntimeDirectorySafe(path, label, allowMissing = false) {
  const stats = readRuntimePathStats(path, label, allowMissing);
  if (!stats) return;
  if (stats.isSymbolicLink()) throw new Error(`The ${label} must not be a link: ${path}`);
  if (!stats.isDirectory()) throw new Error(`The ${label} must be a directory: ${path}`);
}

/** Rejects linked or non-regular runtime files before lifecycle commands read or write them. */
export function assertRuntimeFileSafe(path, label, allowMissing = false) {
  const stats = readRuntimePathStats(path, label, allowMissing);
  if (!stats) return;
  if (stats.isSymbolicLink()) throw new Error(`The ${label} must not be a link: ${path}`);
  if (!stats.isFile()) throw new Error(`The ${label} must be a regular file: ${path}`);
}

/** Validates the runtime root before inspecting lifecycle state. */
export function assertRuntimeRootSafe(repoRoot = resolveRepoRoot()) {
  assertRuntimeDirectorySafe(getRuntimePaths(repoRoot).devDir, "runtime directory", true);
}

function readRuntimePathStats(path, label, allowMissing) {
  try {
    return NodeFS.lstatSync(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") throw new Error(`The ${label} is missing: ${path}`);
    throw error;
  }
}

/**
 * Computes the deterministic start port for a worktree realpath.
 *
 * @param {string} worktreePath
 * @param {number} [basePort]
 * @returns {number}
 */
export function computeDeterministicPort(worktreePath, basePort = DEFAULT_PORT_BASE) {
  const canonical = NodeFS.realpathSync.native(worktreePath).toLowerCase();
  const digest = NodeCrypto.createHash("sha1").update(canonical).digest("hex");
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % PORT_BUCKET_SIZE;
  return basePort + bucket;
}

/**
 * Finds the first bindable TCP port at or after the requested port.
 *
 * @param {number} preferred
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function findAvailablePort(preferred, host = "127.0.0.1") {
  if (!Number.isInteger(preferred) || preferred <= 0 || preferred > 65_535) {
    throw new Error(`Invalid preferred port: ${preferred}`);
  }

  return new Promise((resolvePort, reject) => {
    const server = NodeNet.createServer();
    server.once("error", (error) => {
      if (
        (error.code === "EADDRINUSE" || error.code === "EACCES") &&
        preferred < 65_535
      ) {
        resolvePort(findAvailablePort(preferred + 1, host));
        return;
      }
      reject(error);
    });
    server.listen(preferred, host, () => {
      server.close(() => resolvePort(preferred));
    });
  });
}

/**
 * Computes deterministic, currently available ports for the runtime server and web app.
 *
 * @param {string} worktreePath
 * @returns {Promise<{ serverPort: number, webPort: number }>}
 */
export async function computeAvailablePorts(worktreePath) {
  const start = computeDeterministicPort(worktreePath);
  const serverPort = await findAvailablePort(start);
  const webPort = await findAvailablePort(serverPort + 1);
  return { serverPort, webPort };
}

/**
 * Reads the runtime port assignment from `ports.json`.
 *
 * @param {string} repoRoot
 * @returns {AgentRuntimePorts | null}
 */
export function readPortsFile(repoRoot = resolveRepoRoot()) {
  assertRuntimeRootSafe(repoRoot);
  const { portsFile } = getRuntimePaths(repoRoot);
  assertRuntimeFileSafe(portsFile, "runtime contract", true);
  if (!NodeFS.existsSync(portsFile)) {
    return null;
  }
  const parsed = JSON.parse(NodeFS.readFileSync(portsFile, "utf8"));
  validatePortsContract(parsed);
  return parsed;
}

/**
 * Writes the runtime port assignment to `.dev/ports.json`.
 *
 * @param {AgentRuntimePorts} ports
 * @param {string} repoRoot
 */
export function writePortsFile(ports, repoRoot = resolveRepoRoot()) {
  validatePortsContract(ports);
  const paths = ensureRuntimeRoot(repoRoot);
  assertRuntimeFileSafe(paths.portsFile, "runtime contract", true);
  const temporaryPortsFile = `${paths.portsFile}.tmp`;
  assertRuntimeFileSafe(temporaryPortsFile, "temporary runtime contract", true);
  NodeFS.writeFileSync(temporaryPortsFile, `${JSON.stringify(ports, null, 2)}\n`, {
    mode: 0o600,
  });
  NodeFS.renameSync(temporaryPortsFile, paths.portsFile);
}

/**
 * Builds the machine-readable runtime contract consumed by agents.
 *
 * @param {{ repoRoot?: string, serverPort: number, webPort: number, instanceToken: string, worktreeIdentity?: string, seedLogin: AgentRuntimePorts["seedLogin"] }} input
 * @returns {AgentRuntimePorts}
 */
export function buildPortsContract(input) {
  const repoRoot = NodePath.resolve(input.repoRoot ?? resolveRepoRoot());
  const paths = getRuntimePaths(repoRoot);
  return {
    instanceToken: input.instanceToken,
    worktreeIdentity: input.worktreeIdentity ?? repoRoot,
    serverPort: input.serverPort,
    webPort: input.webPort,
    healthUrl: `http://127.0.0.1:${input.serverPort}/health`,
    appUrl: `http://127.0.0.1:${input.webPort}`,
    seedLogin: input.seedLogin,
    logsDir: paths.logsDir,
  };
}

/**
 * Confirms a path is inside the runtime `.dev` directory.
 *
 * @param {string} candidate
 * @param {string} devDir
 */
export function assertInsideDevDir(candidate, devDir) {
  const resolvedCandidate = NodePath.resolve(candidate);
  const resolvedDev = NodePath.resolve(devDir);
  const prefix = resolvedDev.endsWith(NodePath.sep) ? resolvedDev : `${resolvedDev}${NodePath.sep}`;
  if (resolvedCandidate !== resolvedDev && !resolvedCandidate.startsWith(prefix)) {
    throw new Error(`Refusing to operate outside runtime directory: ${candidate}`);
  }
}

/**
 * Validates the runtime port contract loaded from process input or disk.
 *
 * @param {unknown} ports
 */
function validatePortsContract(ports) {
  assertContractObject(ports, "ports.json must contain an object");
  validateRuntimePorts(ports);
  validateInstanceContract(ports);
  validateRuntimeUrls(ports);
  validateSeedLogin(ports.seedLogin);
}

function assertContractObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
}

function validateRuntimePorts(ports) {
  for (const name of ["serverPort", "webPort"]) {
    const port = ports[name];
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid ${name}: ${port}`);
    }
  }
}

function validateInstanceContract(ports) {
  if (typeof ports.instanceToken !== "string" || ports.instanceToken.length < 32) {
    throw new Error("ports.json instanceToken must be a non-empty random token");
  }
  assertNonBlankString(ports.worktreeIdentity, "ports.json worktreeIdentity must be a non-empty string");
  assertNonBlankString(ports.logsDir, "ports.json logsDir must be a non-empty string");
}

function assertNonBlankString(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
}

function validateRuntimeUrls(ports) {
  if (ports.healthUrl !== `http://127.0.0.1:${ports.serverPort}/health`) {
    throw new Error("ports.json healthUrl must match serverPort");
  }
  if (ports.appUrl !== `http://127.0.0.1:${ports.webPort}`) {
    throw new Error("ports.json appUrl must match webPort");
  }
}

function validateSeedLogin(seedLogin) {
  assertContractObject(seedLogin, "ports.json seedLogin must be an object");
  if (seedLogin.email !== "agent@seed.local") {
    throw new Error("ports.json seedLogin.email must be agent@seed.local");
  }
  if (typeof seedLogin.token !== "string" || seedLogin.token.length === 0) {
    throw new Error("ports.json seedLogin.token must be a non-empty string");
  }
  if (seedLogin.authHeader !== `Bearer ${seedLogin.token}`) {
    throw new Error("ports.json seedLogin.authHeader must match token");
  }
  if (seedLogin.cookieName !== "mcode-auth") {
    throw new Error("ports.json seedLogin.cookieName must be mcode-auth");
  }
}

/**
 * @typedef {{
 *   serverPort: number,
 *   webPort: number,
 *   instanceToken: string,
 *   worktreeIdentity: string,
 *   healthUrl: string,
 *   appUrl: string,
 *   seedLogin: {
 *     email: "agent@seed.local",
 *     token: string,
 *     authHeader: string,
 *     cookieName: "mcode-auth",
 *   },
 *   logsDir: string,
 * }} AgentRuntimePorts
 */
