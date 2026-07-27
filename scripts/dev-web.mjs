/**
 * Start the backend server and Vite dev server together for standalone
 * web development (no Electron needed).
 *
 * The server runs under Electron's Node.js (ELECTRON_RUN_AS_NODE=1) so
 * the better-sqlite3 native module matches the expected ABI. A dev-only
 * auth token is generated and passed to both the server and the Vite
 * dev server so the browser can authenticate WebSocket connections.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rebuildServerDevBundle } from "./build-server-dev-bundle.mjs";
import { killProcessTree } from "./kill-process-tree.mjs";
import {
  buildPortsContract,
  buildRuntimeStateEnv,
  computeAvailablePorts,
  ensureRuntimeRoot,
  generateInstanceToken,
  resolveRepoRoot,
  writePortsFile,
} from "./agent/runtime-contract.mjs";
import { seedFixtureRepo } from "./agent/fixture-repo.mjs";
import { resolveDevSingleInstanceFlag } from "./agent/single-instance-flag.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const desktopRoot = resolve(rootDir, "apps", "desktop");
const serverCjs = resolve(desktopRoot, "dist", "server", "server.cjs");
const serverOnly = process.argv.includes("--server-only");

/**
 * Resolve the Electron binary path. The native module (better-sqlite3)
 * is compiled for Electron's ABI, so the server must run under
 * Electron's Node.js runtime.
 */
function getElectronBinary() {
  try {
    const desktopRequire = createRequire(
      resolve(rootDir, "apps", "desktop", "package.json"),
    );
    const electronPath = desktopRequire("electron");
    if (existsSync(electronPath)) return electronPath;
  } catch {
    // fall through
  }
  return null;
}

/** Resolves the workspace Electron-native better-sqlite3 binding. */
function getElectronBinding() {
  const serverRequire = createRequire(resolve(rootDir, "apps", "server", "package.json"));
  const packagePath = serverRequire.resolve("better-sqlite3/package.json");
  const bindingPath = resolve(dirname(packagePath), "build", "Release", "better_sqlite3.electron.node");
  if (!existsSync(bindingPath)) {
    throw new Error(`Workspace Electron better-sqlite3 binding not found: ${bindingPath}`);
  }
  return bindingPath;
}

/** Poll until the server's /health endpoint responds 200. */
async function waitForHealth(healthUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not respond at ${healthUrl} within ${timeoutMs}ms`);
}

const repoRoot = resolveRepoRoot(rootDir);
const paths = ensureRuntimeRoot(repoRoot);
mkdirSync(paths.dbDir, { recursive: true });
mkdirSync(paths.logsDir, { recursive: true });
mkdirSync(paths.electronDir, { recursive: true });
const fixtureRepo = seedFixtureRepo(repoRoot);
const runtimeStateEnv = buildRuntimeStateEnv(repoRoot, {
  MCODE_AGENT_FIXTURE_REPO: fixtureRepo,
});
const { serverPort, webPort: computedWebPort } = await computeAvailablePorts(repoRoot);
const devToken = randomUUID();
const instanceToken = generateInstanceToken();
const singleInstance = resolveDevSingleInstanceFlag(process.env.MCODE_SINGLE_INSTANCE);
const contract = buildPortsContract({
  repoRoot,
  serverPort,
  webPort: process.env.MCODE_WEB_PORT
    ? Number.parseInt(process.env.MCODE_WEB_PORT, 10)
    : computedWebPort,
  instanceToken,
  worktreeIdentity: repoRoot,
  seedLogin: {
    email: "agent@seed.local",
    token: devToken,
    authHeader: `Bearer ${devToken}`,
    cookieName: "mcode-auth",
  },
});
const electronBin = getElectronBinary();
let electronBinding;

if (!electronBin) {
  console.error(
    "\x1b[31m[dev:web]\x1b[0m Electron binary not found. " +
    "Run 'bun install' in the project root to install dependencies.",
  );
  process.exit(1);
}

try {
  electronBinding = getElectronBinding();
} catch (err) {
  console.error(`[dev:web] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log(`\x1b[36m[dev:web]\x1b[0m Building server bundle (${serverCjs})...`);

try {
  await rebuildServerDevBundle();
} catch (err) {
  console.error("[dev:web] Server bundle failed:", err);
  process.exit(1);
}

console.log(`\x1b[36m[dev:web]\x1b[0m Starting server on port ${serverPort}...`);

let serverFailed = false;

// Start the server using Electron's Node.js (matches better-sqlite3 ABI).
const server = spawn(
  electronBin,
  [serverCjs],
  {
    cwd: dirname(serverCjs),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BETTER_SQLITE3_BINDING: electronBinding,
      NODE_ENV: "development",
      ...runtimeStateEnv,
      MCODE_PORT: String(serverPort),
      MCODE_HOST: "127.0.0.1",
      MCODE_AUTH_TOKEN: devToken,
      MCODE_SINGLE_INSTANCE: singleInstance ? "true" : "false",
      ...(singleInstance
        ? {
            MCODE_INSTANCE_TOKEN: instanceToken,
            MCODE_WORKTREE_IDENTITY: repoRoot,
          }
        : {}),
    },
    stdio: "inherit",
  },
);

server.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    serverFailed = true;
    console.error(
      `\x1b[33m[dev:web]\x1b[0m Server exited with code ${code}. ` +
      "Run 'bun install' if dependencies are missing.",
    );
  }
});

// Wait for the server to become healthy
try {
  await waitForHealth(contract.healthUrl);
  writePortsFile(contract, repoRoot);
  console.log(`\x1b[36m[dev:web]\x1b[0m Server ready on port ${serverPort}`);
} catch {
  if (!serverFailed) {
    console.warn(
      `\x1b[33m[dev:web]\x1b[0m Server did not start. ` +
      "Starting Vite anyway — the web app will show a connection error.",
    );
  }
}

if (serverOnly) {
  const cleanup = () => killProcessTree(server);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  server.on("exit", (code) => process.exit(code ?? 0));
  await new Promise(() => {});
}

// `MCODE_WEB_PORT` lets a caller (e.g. scripts/agent/demo.mjs) pin Vite to a
// port it has already confirmed is free, so the demo drives a known URL instead
// of guessing 5173. With it set we use `--strictPort` so Vite fails loudly
// rather than silently drifting to another port the caller isn't watching.
// Unset (the human `bun run dev:web` path) keeps Vite's default 5173 +
// auto-increment behaviour.
const webPort = process.env.MCODE_WEB_PORT
  ? Number.parseInt(process.env.MCODE_WEB_PORT, 10)
  : contract.webPort;
const viteArgs = ["run", "dev", "--host", "127.0.0.1"];
if (Number.isInteger(webPort) && webPort > 0) {
  viteArgs.push("--port", String(webPort), "--strictPort");
}

console.log(
  `\x1b[36m[dev:web]\x1b[0m Starting Vite dev server${webPort ? ` on http://localhost:${webPort}` : ""}...`,
);

const vite = spawn("bun", viteArgs, {
  cwd: resolve(rootDir, "apps", "web"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    ...runtimeStateEnv,
    ...(singleInstance
      ? {
          VITE_MCODE_SINGLE_INSTANCE: "true",
          VITE_MCODE_WORKTREE_IDENTITY: repoRoot,
          VITE_MCODE_RUNTIME_CONTRACT: paths.portsFile,
        }
      : {
          VITE_SERVER_URL: buildLegacyWebSocketUrl(serverPort, devToken),
          VITE_MCODE_SINGLE_INSTANCE: "false",
        }),
  },
  stdio: "inherit",
});

// Clean shutdown: kill both on exit
function cleanup() {
  killProcessTree(server);
  killProcessTree(vite);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
server.on("exit", () => {
  if (!serverFailed) {
    killProcessTree(vite);
    process.exit();
  }
});
vite.on("exit", () => {
  killProcessTree(server);
  process.exit();
});

/**
 * Builds the legacy shared-server WebSocket URL for flag-off dev UI.
 *
 * @param {number} port
 * @param {string} token
 * @returns {string}
 */
function buildLegacyWebSocketUrl(port, token) {
  const url = new URL(`ws://localhost:${port}`);
  url.searchParams.set("token", token);
  return url.toString();
}
