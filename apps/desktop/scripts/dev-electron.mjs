/**
 * Dev orchestration script for the Electron desktop app.
 *
 * 1. Starts the web (renderer) dev server and esbuild in parallel.
 * 2. Detects the actual Vite dev server URL (auto-increments port if taken).
 * 3. Spawns Electron with ELECTRON_RENDERER_URL pointing at the dev server.
 * 4. Restarts Electron when dist/main/main.cjs changes (debounced 300ms).
 * 5. Cleans up all child processes on SIGINT/SIGTERM.
 */

import { context } from "esbuild";
import { spawn } from "child_process";
import { watch } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

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
// Step 1: Start web dev server + esbuild in parallel
// -------------------------------------------------------------------------

let viteProcess = null;

/**
 * Start the Vite dev server. Returns a promise that resolves with the
 * actual URL once Vite prints its "Local:" line (checks both stdout and
 * stderr since Vite's output stream varies by version).
 */
function startViteDevServer() {
  return new Promise((resolveUrl) => {
    let resolved = false;

    function tryParseUrl(text) {
      if (resolved) return;
      // Strip ANSI escape codes - Vite injects bold/color mid-token
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      const match = clean.match(/Local:\s+(https?:\/\/\S+)/);
      if (match) {
        resolved = true;
        resolveUrl(match[1].replace(/\/+$/, ""));
      }
    }

    viteProcess = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development" },
    });

    viteProcess.stdout.on("data", (data) => {
      const text = data.toString();
      process.stdout.write(`[web] ${text}`);
      tryParseUrl(text);
    });

    viteProcess.stderr.on("data", (data) => {
      const text = data.toString();
      process.stderr.write(`[web] ${text}`);
      tryParseUrl(text);
    });

    viteProcess.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        resolveUrl(null);
      }
      if (viteProcess) {
        console.error(`[web] Vite dev server exited with code ${code}`);
      }
    });
  });
}

// Run Vite startup and esbuild initial build in parallel
const [devServerUrl, watchContexts] = await Promise.all([
  startViteDevServer(),
  Promise.all(
    entries.map(async (cfg) => {
      const ctx = await context(cfg);
      await ctx.rebuild();
      await ctx.watch();
      return ctx;
    }),
  ),
]);

if (!devServerUrl) {
  console.error("[dev] Vite dev server failed to start");
  process.exit(1);
}

console.log("[dev] Initial build complete, watching for changes...");
console.log(`[dev] Web dev server is ready at ${devServerUrl}`);

// -------------------------------------------------------------------------
// Step 2: Spawn Electron
// -------------------------------------------------------------------------

let electronProcess = null;

/** Spawn (or restart) the Electron process. */
function spawnElectron() {
  if (electronProcess) {
    electronProcess.kill();
    electronProcess = null;
  }

  // Resolve the local Electron binary from the project's node_modules.
  // Using npx/bunx can pick up a globally installed Electron with a
  // different Node.js ABI, causing native module load failures (e.g.
  // better-sqlite3 compiled for ABI 133 but global Electron needs 145).
  //
  // shell: true routes through cmd.exe on Windows, avoiding the EFTYPE
  // error that occurs when spawning .exe files directly under Git Bash.
  //
  // ELECTRON_RUN_AS_NODE must be removed from the env. When dev:desktop is
  // launched from terminals running inside Electron-based apps (e.g. Claude
  // Code, VS Code), this flag is inherited and forces Electron to run as
  // plain Node.js, making the `electron` module API unavailable.
  const desktopRequire = createRequire(resolve(projectRoot, "apps/desktop/package.json"));
  const electronBin = desktopRequire("electron");
  const electronEnv = { ...process.env, ELECTRON_RENDERER_URL: devServerUrl };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  electronProcess = spawn(electronBin, ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: electronEnv,
    shell: true,
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
// Step 3: Restart Electron on main process rebuild (debounced)
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
// Step 4: Cleanup on exit signals
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
