/**
 * Start the backend server and Vite dev server together for standalone
 * web development (no Electron needed).
 *
 * The server runs under Electron's Node.js (ELECTRON_RUN_AS_NODE=1) so
 * the better-sqlite3 native module matches the expected ABI. No
 * MCODE_AUTH_TOKEN is set, so WebSocket auth is bypassed.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
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
const electronBin = getElectronBinary();

if (!electronBin) {
  console.error(
    "\x1b[31m[dev:web]\x1b[0m Electron binary not found. " +
    "Run 'bun install' in the project root to install dependencies.",
  );
  process.exit(1);
}

console.log(`\x1b[36m[dev:web]\x1b[0m Starting server on port ${port}...`);

let serverFailed = false;

// Start the server using Electron's Node.js (matches better-sqlite3 ABI).
// No MCODE_AUTH_TOKEN = auth bypassed for standalone dev.
const server = spawn(
  electronBin,
  ["--import", "tsx", "src/index.ts"],
  {
    cwd: resolve(rootDir, "apps", "server"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MCODE_PORT: String(port),
      MCODE_HOST: "127.0.0.1",
      MCODE_AUTH_TOKEN: "",
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

console.log(`\x1b[36m[dev:web]\x1b[0m Starting Vite dev server...`);

const vite = spawn("bun", ["run", "dev"], {
  cwd: resolve(rootDir, "apps", "web"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    VITE_SERVER_URL: `ws://localhost:${port}`,
  },
  stdio: "inherit",
});

// Clean shutdown: kill both on exit
function cleanup() {
  server.kill();
  vite.kill();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
server.on("exit", () => {
  if (!serverFailed) {
    vite.kill();
    process.exit();
  }
});
vite.on("exit", () => {
  server.kill();
  process.exit();
});
