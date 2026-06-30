/**
 * Electron smoke spec. Launches the packaged main process via Playwright's
 * `_electron.launch()`, asserts a first window appears, captures a screenshot,
 * and fails on renderer-side console errors.
 *
 * Future Electron-only features (native menus, tray, BrowserView, deep links)
 * should be appended to this suite as additional specs in this directory.
 *
 * Requires `apps/desktop/dist/main/main.cjs` to exist. The Playwright config
 * does not run a build step automatically; build the bundles first with
 * `cd apps/desktop && bun run build` (CI should do the same before invoking
 * `bun run e2e`).
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(__dirname, "..");
const MAIN_BUNDLE = join(DESKTOP_DIR, "dist", "main", "main.cjs");

function electronLaunchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

test.describe("Electron smoke", () => {
  test.beforeAll(() => {
    if (!existsSync(MAIN_BUNDLE)) {
      throw new Error(
        `Missing ${MAIN_BUNDLE}. Run \`cd apps/desktop && bun run build\` first.`,
      );
    }
  });

  test("first window opens and has the expected title", async () => {
    const app = await electron.launch({
      args: ["."],
      cwd: DESKTOP_DIR,
      env: electronLaunchEnv(),
    });
    const rendererErrors: string[] = [];

    try {
      const win = await app.firstWindow();
      win.on("console", (m) => {
        if (m.type() === "error") rendererErrors.push(m.text());
      });

      await win.waitForLoadState("domcontentloaded");
      await expect(win).toHaveTitle(/Mcode/);

      await win.screenshot({
        path: resolve(
          DESKTOP_DIR,
          "..",
          "web",
          "e2e",
          "screenshots",
          "demo-desktop",
          "smoke-first-window.png",
        ),
        fullPage: true,
      });

      expect(rendererErrors, "renderer console errors").toEqual([]);
    } finally {
      await app.close();
    }
  });
});
