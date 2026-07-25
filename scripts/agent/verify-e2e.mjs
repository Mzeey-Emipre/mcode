#!/usr/bin/env node
/**
 * Cross-platform E2E test runner.
 * Probes the base URL for an already-running dev server; when found, sets
 * PLAYWRIGHT_REUSE_WEB_SERVER=1 so Playwright attaches instead of cold-booting
 * a fresh Vite server (saves ~30-60s per run for UI-iterating agents).
 */
import { execSync } from "node:child_process";
import { createConnection } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateNodeRuntime } from "../node-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const webDir = resolve(repoRoot, "apps/web");

if (!validateNodeRuntime().ok) process.exit(1);

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

/**
 * Resolves to true when a TCP connection to `url`'s host:port completes within
 * `timeoutMs`. A bare TCP probe is enough: Playwright's own readiness check
 * still gates spec execution on the HTTP response, so we just need to know
 * whether something is listening.
 */
function probeBaseUrl(url, timeoutMs = 1000) {
  return new Promise((resolveProbe) => {
    let host;
    let port;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    } catch {
      resolveProbe(false);
      return;
    }
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

const env = { ...process.env };
const devServerUp = await probeBaseUrl(BASE_URL);
if (devServerUp) {
  console.log(`=== Dev server detected at ${BASE_URL}, reusing ===`);
  env.PLAYWRIGHT_REUSE_WEB_SERVER = "1";
} else {
  // Explicitly clear in case the caller's shell exported it: an inherited
  // truthy value plus no server listening would make Playwright skip its
  // own boot and every spec would fail with ECONNREFUSED.
  delete env.PLAYWRIGHT_REUSE_WEB_SERVER;
  console.log(`=== No dev server at ${BASE_URL}, Playwright will boot one ===`);
}

console.log("=== E2E Tests ===");
execSync("bun run e2e", { stdio: "inherit", cwd: webDir, env });
