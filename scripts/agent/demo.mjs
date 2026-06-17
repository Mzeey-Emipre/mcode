#!/usr/bin/env node
/**
 * Boots an isolated `bun run dev:web` stack on a free port, polls the Vite dev
 * URL until it responds, then prints the URL plus a copy-pasteable Playwright
 * MCP entry point so an agent can immediately drive the app.
 *
 * Isolation matters: `dev:web` starts its OWN backend server pinned to a unique
 * temp data dir and database (`MCODE_DATA_DIR` + `MCODE_DB_PATH`), never your
 * real `~/.mcode` profile and never the shared dev/worktree DB. The browser is
 * pinned to that server via `VITE_SERVER_URL`. This matters twice over: a shared
 * DB lets a second dev server fail to boot under SQLite lock contention (leaving
 * the page to wander onto another server), and reusing whatever listens on the
 * default port once let a demo attach to a running production app and mutate
 * real data. We assume the default port is taken, pick the first free one, give
 * the backend its own DB so it always boots clean, and drive only that URL.
 *
 * Set `MCODE_DEMO_URL` to opt into an existing server (e.g. a stack you trust);
 * the script will reuse it instead of spawning a new one. Set
 * `MCODE_DEMO_USE_REAL_DATA=1` to point the fresh stack at your real profile
 * instead of an isolated temp DB (rarely wanted — it can mutate real data).
 *
 * Intended to be invoked by the /demo slash command (Claude) or directly by
 * any agent harness (`node scripts/agent/demo.mjs`).
 *
 * Exits 0 once the server is reachable, 1 on timeout.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = Number(process.env.MCODE_DEMO_TIMEOUT_MS ?? 60_000);
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_WEB_PORT = 5173;
const SCREENSHOT_DIR = join("apps", "web", "e2e", "screenshots", "demo");

/**
 * Ping the dev server. Resolves true if it returns any HTTP status.
 *
 * @param {string} url
 */
async function isReachable(url) {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Find the first TCP port free for listening at or above `preferred`, on the
 * given host. Mirrors the probe in scripts/dev-web.mjs so the port we hand to
 * Vite (`--strictPort`) is one we just confirmed is bindable.
 *
 * @param {number} preferred
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function findFreePort(preferred, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(findFreePort(preferred + 1, host));
      } else {
        reject(err);
      }
    });
    srv.listen(preferred, host, () => {
      srv.close(() => resolve(preferred));
    });
  });
}

async function main() {
  // Explicit override: reuse a server the caller already trusts.
  const overrideUrl = process.env.MCODE_DEMO_URL;
  if (overrideUrl) {
    console.log(`[demo] MCODE_DEMO_URL set — reusing ${overrideUrl}`);
    const start = Date.now();
    while (Date.now() - start < TIMEOUT_MS) {
      if (await isReachable(overrideUrl)) {
        announceReady(overrideUrl);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    console.error(`[demo] timed out after ${TIMEOUT_MS}ms waiting for ${overrideUrl}`);
    process.exitCode = 1;
    return;
  }

  // Assume the default port is in use; claim the first free one and boot a
  // fresh, isolated stack there. `localhost` (not `127.0.0.1`) — Vite's bind is
  // IPv6-friendly on Windows, so we drive the hostname even though we probed
  // the IPv4 loopback for availability.
  const webPort = await findFreePort(DEFAULT_WEB_PORT);
  const devUrl = `http://localhost:${webPort}`;
  console.log(`[demo] target: ${devUrl} (default ${DEFAULT_WEB_PORT}${webPort === DEFAULT_WEB_PORT ? " was free" : " in use"})`);

  // Give the spawned backend its own data dir + DB so it never touches the real
  // profile and never contends on the shared dev/worktree SQLite file (which
  // could leave it dead and send the page wandering onto another server).
  // `openDatabase()` (apps/server) reads MCODE_DB_PATH before any branch/worktree
  // resolution, and getMcodeDir() honors MCODE_DATA_DIR for the server.lock.
  const useRealData = process.env.MCODE_DEMO_USE_REAL_DATA === "1";
  const demoEnv = { ...process.env, MCODE_WEB_PORT: String(webPort) };
  if (!useRealData) {
    const dataDir = mkdtempSync(join(tmpdir(), "mcode-demo-web-"));
    demoEnv.MCODE_DATA_DIR = dataDir;
    demoEnv.MCODE_DB_PATH = join(dataDir, "mcode.db");
    console.log(`[demo] isolated data dir: ${dataDir}`);
  } else {
    console.log("[demo] MCODE_DEMO_USE_REAL_DATA=1 — using your real profile (may mutate real data)");
  }
  console.log("[demo] starting an isolated `bun run dev:web` (own server, own DB)…");

  const child = spawn("bun", ["run", "dev:web"], {
    stdio: "ignore",
    detached: true,
    shell: process.platform === "win32",
    env: demoEnv,
  });
  child.unref();

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (await isReachable(devUrl)) {
      announceReady(devUrl);
      // `process.exit(0)` after a fetch on Windows can trip a libuv async-handle
      // assertion. The work is already done, so we let the event loop drain.
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.error(`[demo] timed out after ${TIMEOUT_MS}ms waiting for ${devUrl}`);
  process.exitCode = 1;
}

/**
 * Print the ready banner with the exact URL the agent must drive.
 *
 * @param {string} devUrl
 */
function announceReady(devUrl) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  console.log("");
  console.log(`[demo] ready: ${devUrl}`);
  console.log(`[demo] screenshots dir: ${SCREENSHOT_DIR}`);
  console.log("");
  console.log("[demo] Drive THIS url (not a hardcoded :5173) via the Playwright MCP:");
  console.log(`  mcp__playwright__browser_navigate({ url: "${devUrl}" })`);
  console.log("  mcp__playwright__browser_snapshot()");
  console.log(`  mcp__playwright__browser_take_screenshot({ filename: "${SCREENSHOT_DIR}/<step>.png" })`);
  console.log("  mcp__playwright__browser_console_messages()");
}

// Only run when executed directly, so tests can import `findFreePort`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[demo] failed:", err);
    process.exit(1);
  });
}
