/**
 * Start the backend server and Vite dev server together for standalone
 * web development (no Electron needed).
 *
 * The server runs under Bun. Electron remains the explicit isolated PTY host.
 * A dev-only
 * auth token is generated and passed to both the server and the Vite
 * dev server so the browser can authenticate WebSocket connections.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveServerOnlyExitCode } from "./dev-web-lifecycle.mjs";
import { prepareRuntimeDirectories, resolveBunBinary, resolveElectronBinary, waitForHttpOk } from "./runtime/launch-mechanics.mjs";
import { ensureDependencies } from "./agent/ensure-dependencies.mjs";
import { seedDatabaseForStartup } from "./db-seed.mjs";
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

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const rootDir = NodePath.resolve(__dirname, "..");
const desktopRoot = NodePath.resolve(rootDir, "apps", "desktop");
const serverCjs = NodePath.resolve(desktopRoot, "dist", "server", "server.cjs");
const serverOnly = process.argv.includes("--server-only");
const repoRoot = resolveRepoRoot(rootDir);
await ensureDependencies({ repoRoot });
const { rebuildServerDevBundle } = await import("./build-server-dev-bundle.mjs");

const paths = ensureRuntimeRoot(repoRoot);
prepareRuntimeDirectories(paths);
seedDatabaseForStartup({ repoRoot, preserveExistingTarget: true });
const fixtureRepo = seedFixtureRepo(repoRoot);
const runtimeStateEnv = buildRuntimeStateEnv(repoRoot, {
  MCODE_AGENT_FIXTURE_REPO: fixtureRepo,
});
const { serverPort, webPort: computedWebPort } = await computeAvailablePorts(repoRoot);
const devToken = NodeCrypto.randomUUID();
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
const electronBin = resolveElectronBinary(rootDir);
let bunBin;

if (!electronBin) {
  console.error(
    "\x1b[31m[dev:web]\x1b[0m Electron binary not found. " +
    "Run 'bun install' in the project root to install dependencies.",
  );
  process.exit(1);
}

try {
  bunBin = resolveBunBinary();
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

// Keep Electron as the explicit PTY host while Bun runs the server.
const server = NodeChildProcess.spawn(
  bunBin,
  [serverCjs],
  {
    cwd: NodePath.dirname(serverCjs),
    env: {
      ...process.env,
      MCODE_PTY_HOST_EXECUTABLE: electronBin,
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
  await waitForHttpOk(contract.healthUrl, "Server", 15_000);
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

let vite;

if (serverOnly) {
  let cleanupRequested = false;
  let cleanupPromise;
  const cleanup = () => {
    cleanupRequested = true;
    cleanupPromise ??= Promise.resolve(killProcessTree(server)).catch(() => undefined);
    return cleanupPromise;
  };
  process.on("SIGINT", () => {
    void cleanup();
  });
  process.on("SIGTERM", () => {
    void cleanup();
  });
  server.on("exit", (code, signal) => {
    void cleanup().finally(() => {
      process.exit(resolveServerOnlyExitCode({ code, signal, cleanupRequested }));
    });
  });
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

vite = NodeChildProcess.spawn("bun", viteArgs, {
  cwd: NodePath.resolve(rootDir, "apps", "web"),
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
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= Promise.all([
    killProcessTree(server),
    killProcessTree(vite),
  ].map((termination) => Promise.resolve(termination).catch(() => undefined)));
  return cleanupPromise;
}

process.on("SIGINT", () => {
  void cleanup();
});
process.on("SIGTERM", () => {
  void cleanup();
});
server.on("exit", () => {
  if (!serverFailed) {
    void cleanup().finally(() => process.exit());
  }
});
vite.on("exit", () => {
  void cleanup().finally(() => process.exit());
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
