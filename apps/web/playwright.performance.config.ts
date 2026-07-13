import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5330";

function previewCommand(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("PLAYWRIGHT_BASE_URL must use http://localhost or http://127.0.0.1");
  }
  const port = Number.parseInt(url.port || "80", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PLAYWRIGHT_BASE_URL must include a valid TCP port");
  }
  return `bunx vite preview --host ${url.hostname} --port ${port} --strictPort`;
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "pull-request-performance.spec.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["line"]],
  use: {
    baseURL: BASE_URL,
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: previewCommand(BASE_URL),
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
