/**
 * Dev orchestration script for the Electron desktop app.
 *
 * 1. Starts the web (renderer) dev server as a child process.
 * 2. Builds main + preload with esbuild in watch mode.
 * 3. Waits for the web dev server at http://localhost:5173.
 * 4. Spawns Electron with ELECTRON_RENDERER_URL pointing at the dev server.
 * 5. Restarts Electron when dist/main/main.cjs changes (debounced 300ms).
 * 6. Cleans up all child processes on SIGINT/SIGTERM.
 */

import { context } from "esbuild";
import { spawn } from "child_process";
import { watch } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const webRoot = resolve(projectRoot, "..", "web");

/** Shared esbuild options. */
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  format: "cjs",
};

/** esbuild entry point configs. */
const entries = [
  {
    ...shared,
    entryPoints: [resolve(projectRoot, "src/main/main.ts")],
    outfile: resolve(projectRoot, "dist/main/main.cjs"),
    external: ["electron"],
  },
  {
    ...shared,
    entryPoints: [resolve(projectRoot, "src/main/preload.ts")],
    outfile: resolve(projectRoot, "dist/preload/preload.cjs"),
    external: ["electron"],
  },
];

// -------------------------------------------------------------------------
// Step 1: Start web dev server
// -------------------------------------------------------------------------

let viteProcess = null;

/** Start the Vite dev server for the renderer (apps/web). */
function startViteDevServer() {
  viteProcess = spawn("bun", ["run", "dev"], {
    cwd: webRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });

  viteProcess.stdout.on("data", (data) => {
    process.stdout.write(`[web] ${data}`);
  });

  viteProcess.stderr.on("data", (data) => {
    process.stderr.write(`[web] ${data}`);
  });

  viteProcess.on("exit", (code) => {
    if (viteProcess) {
      console.error(`[web] Vite dev server exited with code ${code}`);
    }
  });
}

startViteDevServer();

// -------------------------------------------------------------------------
// Step 2: Build and start watch mode (context().watch() runs an initial build)
// -------------------------------------------------------------------------

const watchContexts = await Promise.all(
  entries.map(async (cfg) => {
    const ctx = await context(cfg);
    await ctx.watch();
    return ctx;
  }),
);
console.log("[dev] Initial build complete, watching for changes...");

// -------------------------------------------------------------------------
// Step 3: Wait for web dev server
// -------------------------------------------------------------------------

const DEV_SERVER_URL = "http://localhost:5173";

/** Poll the dev server until it responds. */
async function waitForDevServer() {
  const maxWait = 60_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(DEV_SERVER_URL);
      if (res.ok || res.status === 304) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Dev server at ${DEV_SERVER_URL} did not start within 60s`);
}

console.log(`[dev] Waiting for web dev server at ${DEV_SERVER_URL}...`);
await waitForDevServer();
console.log("[dev] Web dev server is ready");

// -------------------------------------------------------------------------
// Step 4: Spawn Electron
// -------------------------------------------------------------------------

let electronProcess = null;

/** Spawn (or restart) the Electron process. */
function spawnElectron() {
  if (electronProcess) {
    electronProcess.kill();
    electronProcess = null;
  }

  // Use npx to launch Electron. Direct spawn of .exe files fails with EFTYPE
  // on Windows under Git Bash (MSYS2) due to a libuv/Node.js compatibility issue.
  // npx uses cross-spawn internally which routes through cmd.exe, avoiding the bug.
  electronProcess = spawn("npx", ["electron", "."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: DEV_SERVER_URL,
    },
  });

  electronProcess.on("exit", (code) => {
    // If Electron exits on its own (user closed window), shut down dev script
    if (electronProcess) {
      electronProcess = null;
      cleanup();
      process.exit(code ?? 0);
    }
  });
}

spawnElectron();

// -------------------------------------------------------------------------
// Step 5: Restart Electron on main process rebuild (debounced)
// -------------------------------------------------------------------------

const mainOutFile = resolve(projectRoot, "dist/main/main.cjs");
let debounceTimer = null;

watch(mainOutFile, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log("[dev] main.cjs changed, restarting Electron...");
    spawnElectron();
  }, 300);
});

// -------------------------------------------------------------------------
// Step 6: Cleanup on exit signals
// -------------------------------------------------------------------------

/** Stop all child processes and esbuild watchers. */
function cleanup() {
  if (debounceTimer) clearTimeout(debounceTimer);

  for (const ctx of watchContexts) {
    ctx.dispose().catch(() => {});
  }

  if (electronProcess) {
    electronProcess.kill();
    electronProcess = null;
  }

  if (viteProcess) {
    viteProcess.kill();
    viteProcess = null;
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
