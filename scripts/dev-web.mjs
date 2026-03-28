/**
 * Start the backend server and Vite dev server together for standalone
 * web development (no Electron needed).
 *
 * The server starts without MCODE_AUTH_TOKEN so auth is bypassed.
 * Vite is configured to connect to the server's WebSocket port.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";

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

const port = await findPort(SERVER_PORT);

console.log(`\x1b[36m[dev:web]\x1b[0m Starting server on port ${port}...`);

// Start the backend server (no auth token = auth bypassed)
const server = spawn("node", ["--import", "tsx", "apps/server/src/index.ts"], {
  env: { ...process.env, MCODE_PORT: String(port), MCODE_HOST: "127.0.0.1" },
  stdio: "inherit",
});

// Wait a moment for the server to bind, then start Vite
await new Promise((r) => setTimeout(r, 2000));

console.log(`\x1b[36m[dev:web]\x1b[0m Starting Vite dev server...`);

const vite = spawn("bun", ["run", "dev"], {
  cwd: "apps/web",
  env: { ...process.env, VITE_SERVER_URL: `ws://localhost:${port}` },
  stdio: "inherit",
  shell: true,
});

// Clean shutdown: kill both on exit
function cleanup() {
  server.kill();
  vite.kill();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
server.on("exit", () => { vite.kill(); process.exit(); });
vite.on("exit", () => { server.kill(); process.exit(); });
