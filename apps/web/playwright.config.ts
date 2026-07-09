import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

function webServerCommand(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("PLAYWRIGHT_BASE_URL must use http://localhost or http://127.0.0.1");
  }

  const port = Number.parseInt(url.port || "80", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PLAYWRIGHT_BASE_URL must include a valid TCP port");
  }

  return `bun run dev -- --host ${url.hostname} --port ${port} --strictPort`;
}

/**
 * Attach to an already-running dev server on `BASE_URL` instead of starting one.
 * Only honored locally — CI always boots a fresh server so runs stay reproducible.
 * Useful when you intentionally keep `bun run dev` open and want faster test iteration.
 */
const reuseExistingServer =
  !process.env.CI && process.env.PLAYWRIGHT_REUSE_WEB_SERVER === "1";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : 4,
  reporter: [["html", { outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    actionTimeout: 10000,
  },
  projects: [
    { name: "chromium" },
  ],
  webServer: {
    command: webServerCommand(BASE_URL),
    url: BASE_URL,
    reuseExistingServer,
    timeout: 120_000,
    // Spawning inherits the parent process env. React Fast Refresh in Vite
    // assumes development; a production NODE_ENV causes `$RefreshReg$` runtime errors.
    env: {
      ...process.env,
      NODE_ENV: "development",
    },
  },
});
