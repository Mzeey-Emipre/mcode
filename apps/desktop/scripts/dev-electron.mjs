/**
 * Dev orchestration script for the Electron desktop app.
 *
 * 1. Starts the web (renderer) dev server and esbuild in parallel.
 * 2. Compiles the backend server (`tsc` → `esbuild`, same pipeline as packaged
 *    builds) so the desktop child runs `server.cjs` without `--import tsx`.
 * 3. Detects the actual Vite dev server URL (auto-increments port if taken).
 * 4. Spawns Electron with ELECTRON_RENDERER_URL pointing at the dev server.
 * 5. Restarts Electron when dist/main/main.cjs or dist/server/server.cjs
 *    changes (debounced 300ms).
 * 6. Cleans up all child processes on SIGINT/SIGTERM.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import { killProcessTree } from "../../../scripts/kill-process-tree.mjs";
import { ensureElectronBinary } from "../../../scripts/ensure-electron.mjs";
import { makeCoalescedAsync } from "./coalesce-async.mjs";
import {
  buildRuntimeStateEnv,
  ensureRuntimeRoot,
} from "../../../scripts/agent/runtime-contract.mjs";
import { seedFixtureRepo } from "../../../scripts/agent/fixture-repo.mjs";
import { ensureDependencies } from "../../../scripts/agent/ensure-dependencies.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const projectRoot = NodePath.resolve(__dirname, "..");
const repoRoot = NodePath.resolve(projectRoot, "..", "..");
await ensureDependencies({ repoRoot });
const { context, build } = await import("esbuild");
const {
  rebuildServerDevBundle,
  resolveServerTscBin,
  copyClaudeSdkCliNextTo,
} = await import("../../../scripts/build-server-dev-bundle.mjs");
const webRoot = NodePath.resolve(projectRoot, "..", "web");
const serverRoot = NodePath.resolve(projectRoot, "..", "server");
const runtimePaths = ensureRuntimeRoot(repoRoot);
NodeFS.mkdirSync(runtimePaths.dbDir, { recursive: true });
NodeFS.mkdirSync(runtimePaths.logsDir, { recursive: true });
NodeFS.mkdirSync(runtimePaths.electronDir, { recursive: true });
const fixtureRepo = seedFixtureRepo(repoRoot);
const runtimeStateEnv = buildRuntimeStateEnv(repoRoot, {
  MCODE_AGENT_FIXTURE_REPO: fixtureRepo,
});

/** Paths to Electron main/preload bundles and server bundle (restart triggers). */
const mainOutFile = NodePath.resolve(projectRoot, "dist/main/main.cjs");
const preloadOutFile = NodePath.resolve(projectRoot, "dist/preload/preload.cjs");
const guestPreloadOutFile = NodePath.resolve(projectRoot, "dist/preload/preview-guest-preload.cjs");
const serverOutFile = NodePath.resolve(projectRoot, "dist/server/server.cjs");

/** Shared esbuild options. */
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  format: "cjs",
};

/**
 * Spawn `tsc --watch` so server source edits re-emit apps/server/dist-tsc.
 *
 * Returns both the subprocess and a promise that resolves the first time tsc
 * prints its watch-mode settle marker. Used to gate Electron startup so the
 * initial dist-tsc emission cannot masquerade as a real change and trigger
 * a spurious restart ~60s after the window opens.
 *
 * @returns {{ proc: import("child_process").ChildProcess, initialSettled: Promise<void> }}
 *   Subprocess handle (caller must kill via killProcessTree on shutdown) and
 *   a one-shot promise that resolves on the first settle marker.
 */
function startServerTscWatch() {
  const tscBin = resolveServerTscBin(serverRoot);
  const proc = NodeChildProcess.spawn(process.execPath, [
    tscBin,
    "--project",
    NodePath.resolve(serverRoot, "tsconfig.build.json"),
    "--watch",
    "--preserveWatchOutput",
  ], {
    cwd: serverRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });

  let resolveSettled;
  let rejectSettled;
  const initialSettled = new Promise((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  let firstSettle = true;

  const settleOnce = (fn) => {
    if (!firstSettle) return;
    firstSettle = false;
    fn();
  };

  proc.stdout.on("data", (data) => {
    const text = data.toString();
    process.stdout.write(text);
    if (firstSettle && /Watching for file changes\./.test(text)) {
      settleOnce(() => resolveSettled());
    }
  });

  proc.once("error", (err) => {
    settleOnce(() => rejectSettled(err));
  });

  proc.once("exit", (code, signal) => {
    settleOnce(() =>
      rejectSettled(
        new Error(
          `[dev] tsc --watch exited before initial settle (code=${code}, signal=${signal ?? "none"})`,
        ),
      ),
    );
  });

  return { proc, initialSettled };
}

/** esbuild entry point configs. */
const entries = [
  {
    ...shared,
    entryPoints: [NodePath.resolve(projectRoot, "src/main/main.ts")],
    outfile: mainOutFile,
    external: ["electron"],
  },
  {
    ...shared,
    entryPoints: [NodePath.resolve(projectRoot, "src/main/preload.ts")],
    outfile: NodePath.resolve(projectRoot, "dist/preload/preload.cjs"),
    external: ["electron"],
  },
  {
    ...shared,
    entryPoints: [NodePath.resolve(projectRoot, "src/features/preview/preload/guest-input.ts")],
    outfile: guestPreloadOutFile,
    external: ["electron"],
  },
];

console.log("[dev] Building bundled server entry (apps/desktop/dist/server/server.cjs)...");
await rebuildServerDevBundle();

/** Must run before server `esbuild` watch so `dist-tsc` emits complete graphs per save. */
let { proc: serverTscWatch, initialSettled: serverTscInitialSettled } =
  startServerTscWatch();

const serverEsbuildCfg = {
  ...shared,
  entryPoints: [NodePath.resolve(serverRoot, "dist-tsc/index.js")],
  outfile: serverOutFile,
  external: ["better-sqlite3", "node-pty", "electron", "koffi"],
  banner: {
    js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    "import.meta.url": "__importMetaUrl",
    // Do not bake NODE_ENV — the server child inherits Electron's runtime env.
  },
};

/**
 * Server bundle rebuild is coalesced via {@link makeCoalescedAsync}:
 *   - Bursty dist-tsc events within the debounce window collapse to one run.
 *   - Events that arrive WHILE a build is in flight (e.g. tsc still emitting
 *     during a multi-second esbuild) schedule exactly one follow-up run, not
 *     N parallel runs. Without this, Electron would restart multiple times
 *     per logical change because each completed build would write
 *     `server.cjs` and trip the file watcher.
 */
let distTscWatcher = null;

const scheduleServerBundleRebuild = makeCoalescedAsync(async () => {
  try {
    await build({ ...serverEsbuildCfg });
    copyClaudeSdkCliNextTo(serverOutFile, serverRoot);
  } catch (err) {
    console.error("[dev] server bundle rebuild failed:", err);
  }
}, 300);

// -------------------------------------------------------------------------
// Step 1: Start web dev server + esbuild in parallel
// -------------------------------------------------------------------------

let viteProcess = null;
/** Electron child handle; declared before Vite startup so early Vite exit cannot hit TDZ. */
let electronProcess = null;
/** Active esbuild watch contexts; initialized before startup so early cleanup is safe. */
let watchContexts = [];

/** True while `cleanup()` is tearing children down so Vite exit is not treated as a crash. */
let devSessionShuttingDown = false;

/**
 * Start the Vite dev server. Returns a promise that resolves with the
 * actual URL once Vite prints its "Local:" line (checks both stdout and
 * stderr since Vite's output stream varies by version).
 */
function startViteDevServer() {
  return new Promise((resolveUrl) => {
    let bootstrapResolved = false;

    function tryParseUrl(text) {
      if (bootstrapResolved) return;
      // Strip ANSI escape codes - Vite injects bold/color mid-token
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      const match = clean.match(/Local:\s+(https?:\/\/\S+)/);
      if (match) {
        bootstrapResolved = true;
        resolveUrl(match[1].replace(/\/+$/, ""));
      }
    }

    viteProcess = NodeChildProcess.spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development", ...runtimeStateEnv },
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
      if (!bootstrapResolved) {
        bootstrapResolved = true;
        resolveUrl(null);
      }
      console.error(`[web] Vite dev server exited with code ${code}`);

      if (devSessionShuttingDown) return;

      if (electronProcess) {
        console.error(
          "[dev] The renderer loads modules from Vite; with the dev server gone the window " +
            "will show ERR_CONNECTION_REFUSED and failed dynamic imports. Stopping Electron.",
        );
        cleanup();
        process.exit(code ?? 1);
      }
    });
  });
}

// Run Vite startup and esbuild (main/preload) watch in parallel
const [devServerUrl, initialWatchContexts] = await Promise.all([
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
watchContexts = initialWatchContexts;

if (!devServerUrl) {
  console.error("[dev] Vite dev server failed to start");
  process.exit(1);
}

console.log("[dev] Initial build complete, watching for changes...");
console.log(`[dev] Web dev server is ready at ${devServerUrl}`);

// Wait for tsc --watch's initial pass to settle before starting Electron or
// the dist-tsc watcher. `rebuildServerDevBundle()` already wrote server.cjs
// synchronously above, but tsc --watch was spawned in parallel and takes
// ~60s to settle its first emission. Those redundant emissions, if observed
// by `distTscWatcher`, schedule a coalesced esbuild that rewrites server.cjs
// after Electron has spawned and `watch(serverOutFile)` is registered -
// triggering a spurious restart and (on Windows, where killProcessTree races
// the old child) a second visible Electron instance.
console.log("[dev] Waiting for tsc --watch initial pass to settle...");
try {
  await serverTscInitialSettled;
} catch (err) {
  console.error("[dev] tsc --watch failed during initial settle:", err);
  process.exit(1);
}
console.log("[dev] tsc settled; launching Electron.");

// Start the dist-tsc watcher AFTER settle so only real user edits fire it.
try {
  distTscWatcher = NodeFS.watch(NodePath.resolve(serverRoot, "dist-tsc"), { recursive: true }, () => {
    scheduleServerBundleRebuild();
  });
} catch (err) {
  console.warn("[dev] Could not watch apps/server/dist-tsc; server hot-rebuild disabled:", err);
}

// -------------------------------------------------------------------------
// Step 2: Spawn Electron
// -------------------------------------------------------------------------

/** Spawn (or restart) the Electron process. */
async function spawnElectron() {
  if (devSessionShuttingDown) return;
  if (electronProcess) {
    const previousProcess = electronProcess;
    electronProcess = null;
    await Promise.resolve(killProcessTree(previousProcess)).catch(() => undefined);
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
  const desktopRequire = NodeModule.createRequire(NodePath.resolve(projectRoot, "package.json"));
  const electronBin = desktopRequire("electron");
  const electronEnv = {
    ...process.env,
    ...runtimeStateEnv,
    ELECTRON_RENDERER_URL: devServerUrl,
    NODE_ENV: "development",
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  electronProcess = NodeChildProcess.spawn(electronBin, ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: electronEnv,
    shell: true,
  });

  const startedProcess = electronProcess;
  startedProcess.on("exit", (code) => {
    // If Electron exits on its own (user closed window), shut down dev script
    if (electronProcess === startedProcess) {
      electronProcess = null;
      void cleanup().finally(() => process.exit(code ?? 0));
    }
  });
}

ensureElectronBinary(projectRoot);
await spawnElectron();

// -------------------------------------------------------------------------
// Step 3: Restart Electron on main/server bundle rebuild (debounced)
// -------------------------------------------------------------------------

let debounceTimer = null;
let restartPromise = Promise.resolve();

/**
 * Debounce Electron restart so rapid esbuild increments coalesce.
 *
 * @param {string} reason Log line fragment after `[dev]`.
 */
function scheduleElectronRestart(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (devSessionShuttingDown) return;
    console.log(`[dev] ${reason}, restarting Electron...`);
    restartPromise = restartPromise
      .then(() => spawnElectron())
      .catch((error) => {
        console.error("[dev] Electron restart failed:", error);
      });
  }, 300);
}

NodeFS.watch(mainOutFile, () => scheduleElectronRestart("main bundle updated"));
NodeFS.watch(preloadOutFile, () => scheduleElectronRestart("preload bundle updated"));
NodeFS.watch(guestPreloadOutFile, () => scheduleElectronRestart("preview guest preload bundle updated"));
NodeFS.watch(serverOutFile, () => scheduleElectronRestart("server bundle updated"));

// -------------------------------------------------------------------------
// Step 4: Cleanup on exit signals
// -------------------------------------------------------------------------

/** Stop all child processes and esbuild watchers. */
let cleanupPromise;
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  devSessionShuttingDown = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  // The server-bundle rebuild timer is owned by makeCoalescedAsync; we
  // can't cancel its in-flight build, but stopping the dist-tsc watcher
  // (below) prevents any further trigger.

  if (distTscWatcher) {
    try {
      distTscWatcher.close();
    } catch {
      /* ignore */
    }
    distTscWatcher = null;
  }

  const processes = [];
  if (serverTscWatch) {
    processes.push(killProcessTree(serverTscWatch));
    serverTscWatch = null;
  }

  for (const ctx of watchContexts) {
    processes.push(Promise.resolve(ctx.dispose()).catch(() => undefined));
  }

  if (electronProcess) {
    processes.push(killProcessTree(electronProcess));
    electronProcess = null;
  }

  if (viteProcess) {
    processes.push(killProcessTree(viteProcess));
    viteProcess = null;
  }
  cleanupPromise = Promise.all(
    processes.map((termination) => Promise.resolve(termination).catch(() => undefined)),
  );
  return cleanupPromise;
}

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0));
});
