import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  workers: 1,
  reporter: [["line"]],
  use: {
    baseURL: "http://localhost:4173",
    colorScheme: "dark",
    actionTimeout: 10000,
  },
  projects: [{ name: "chromium" }],
});
