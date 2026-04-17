import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  workers: 1,
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
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
