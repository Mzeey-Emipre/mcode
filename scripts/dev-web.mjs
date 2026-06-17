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
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rebuildServerDevBundle } from "./build-server-dev-bundle.mjs";
import { killProcessTree } from "./kill-process-tree.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const desktopRoot = resolve(rootDir, "apps", "desktop");
const serverCjs = resolve(desktopRoot, "dist", "server", "server.cjs");
const SERVER_PORT = 19400;

/** Find an available port starting from `preferred`, incrementing on conflict. */
function findPort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(findPort(preferred + 1));
      } else {
        reject(err);
      }
    });
    srv.listen(preferred, "127.0.0.1", () => {
      srv.close(() => resolve(preferred));
    });
  });
}

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

/** Poll until the server's /health endpoint responds 200. */
async function waitForHealth(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not respond on port ${port} within ${timeoutMs}ms`);
}

const port = await findPort(SERVER_PORT);
const devToken = randomUUID();
const electronBin = getElectronBinary();

if (!electronBin) {
  console.error(
    "\x1b[31m[dev:web]\x1b[0m Electron binary not found. " +
    "Run 'bun install' in the project root to install dependencies.",
  );
  process.exit(1);
}

console.log(`\x1b[36m[dev:web]\x1b[0m Building server bundle (${serverCjs})...`);

try {
  await rebuildServerDevBundle();
} catch (err) {
  console.error("[dev:web] Server bundle failed:", err);
  process.exit(1);
}

console.log(`\x1b[36m[dev:web]\x1b[0m Starting server on port ${port}...`);

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
      MCODE_PORT: String(port),
      MCODE_HOST: "127.0.0.1",
      MCODE_AUTH_TOKEN: devToken,
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
  await waitForHealth(port);
  console.log(`\x1b[36m[dev:web]\x1b[0m Server ready on port ${port}`);
} catch {
  if (!serverFailed) {
    console.warn(
      `\x1b[33m[dev:web]\x1b[0m Server did not start. ` +
      "Starting Vite anyway — the web app will show a connection error.",
    );
  }
}

// `MCODE_WEB_PORT` lets a caller (e.g. scripts/agent/demo.mjs) pin Vite to a
// port it has already confirmed is free, so the demo drives a known URL instead
// of guessing 5173. With it set we use `--strictPort` so Vite fails loudly
// rather than silently drifting to another port the caller isn't watching.
// Unset (the human `bun run dev:web` path) keeps Vite's default 5173 +
// auto-increment behaviour.
const webPort = process.env.MCODE_WEB_PORT
  ? Number.parseInt(process.env.MCODE_WEB_PORT, 10)
  : null;
const viteArgs = ["run", "dev"];
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
    VITE_SERVER_URL: `ws://localhost:${port}?token=${devToken}`,
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
