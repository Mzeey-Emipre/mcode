/**
 * Electron lifecycle spec: closing the desktop app must stop the detached
 * server child (via the main.ts before-quit handler), not leave it running for
 * the idle grace period. Launches into a throwaway, env-isolated data dir so it
 * never touches a real Mcode server on the same machine.
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_BUNDLE = join(DESKTOP_DIR, "dist", "main", "main.cjs");

/**
 * Build a launch env that points the app at an isolated data dir and removes
 * inherited runtime vars that would otherwise (a) make Electron run as plain
 * Node and reject GUI flags (ELECTRON_RUN_AS_NODE), or (b) bind it to a real
 * server's data dir, port, or native binding.
 */
function isolatedEnv(dataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("MCODE_") || k.startsWith("ELECTRON_") || k.startsWith("BETTER_SQLITE3_")) {
      continue;
    }
    env[k] = v;
  }
  env.MCODE_DATA_DIR = dataDir;
  env.NODE_ENV = "development";
  return env;
}

/** True while the OS reports the PID as a live process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe("Electron server lifecycle", () => {
  test.beforeAll(() => {
    if (!existsSync(MAIN_BUNDLE)) {
      throw new Error(
        `Missing ${MAIN_BUNDLE}. Run \`cd apps/desktop && bun run build\` first.`,
      );
    }
  });

  test("stops the detached server when the app quits", async () => {
    // A fresh data dir cold-starts the server (runs migrations), so allow more
    // than the default 90s for startup + the post-quit reap poll.
    test.setTimeout(180_000);
    const dataDir = mkdtempSync(join(tmpdir(), "mcode-e2e-shutdown-"));
    const lockPath = join(dataDir, "server.lock");

    const app = await electron.launch({
      args: ["."],
      cwd: DESKTOP_DIR,
      env: isolatedEnv(dataDir),
    });

    let pid = -1;
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      // The sidebar shell renders only after the transport connects, by which
      // point the server has bound its port and written the lock file.
      await win
        .getByPlaceholder("Search threads...")
        .waitFor({ state: "visible", timeout: 60_000 });

      // Lock may land a beat after /health returns 200; poll briefly.
      let lock: { pid: number; port: number } | null = null;
      for (let i = 0; i < 50 && !lock; i++) {
        if (existsSync(lockPath)) {
          try {
            lock = JSON.parse(readFileSync(lockPath, "utf-8"));
          } catch {
            /* partial write — retry */
          }
        }
        if (!lock) await sleep(200);
      }

      expect(lock, "server lock file should exist while app is running").toBeTruthy();
      pid = lock!.pid;
      expect(isAlive(pid), "server process should be alive before quit").toBe(true);

      await app.close();

      // before-quit awaits stopServerHeldByLock, but the OS may take a moment
      // to reap the process after it exits. Poll up to the spec timeout budget.
      let aliveAfter = true;
      for (let i = 0; i < 75 && aliveAfter; i++) {
        aliveAfter = isAlive(pid);
        if (aliveAfter) await sleep(200);
      }

      expect(aliveAfter, `server PID ${pid} should be dead after quit`).toBe(false);
      expect(existsSync(lockPath), "lock file should be removed after quit").toBe(false);
    } finally {
      // Safety net: never leave an isolated test server alive.
      if (pid > 0 && isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
});
