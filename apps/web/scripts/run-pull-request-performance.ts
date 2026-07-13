const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5330";
const child = Bun.spawn(
  [
    process.execPath,
    "x",
    "playwright",
    "test",
    "--config=playwright.performance.config.ts",
  ],
  {
    cwd: import.meta.dir.replace(/[\\/]scripts$/, ""),
    env: {
      ...process.env,
      PLAYWRIGHT_BASE_URL: baseUrl,
      PULL_REQUEST_PERFORMANCE_E2E: "1",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exit(await child.exited);
