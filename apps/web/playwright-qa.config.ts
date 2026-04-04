import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  workers: 1,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:5190",
    colorScheme: "dark",
    screenshot: "only-on-failure",
    actionTimeout: 10000,
  },
  projects: [{ name: "chromium" }],
});
