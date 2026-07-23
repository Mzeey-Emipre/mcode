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

type SmokePreviewBridge = {
  sync(payload: {
    visible: boolean;
    bounds: { x: number; y: number; width: number; height: number } | null;
    threadId: string;
    resumeUrlHint?: string;
    workspaceId: string;
  }): Promise<void>;
  navigate(url: string): Promise<{ ok: boolean }>;
};

type SmokeDesktopBridge = {
  getServerUrl(): Promise<{ url: string }>;
  preview: SmokePreviewBridge;
};

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
      const titleBar = win.getByTestId("desktop-title-bar");
      await expect(titleBar).toBeVisible();
      await expect(titleBar).toHaveCSS("height", "40px");
      const sidebarToggle = titleBar.getByRole("button", {
        name: "Toggle sidebar",
      });
      await expect(sidebarToggle).toBeVisible();

      await expect(win.getByTestId("sidebar-docked")).toBeVisible();
      await sidebarToggle.click();
      await expect(win.getByTestId("sidebar-docked")).toBeHidden();
      await sidebarToggle.click();
      await expect(win.getByTestId("sidebar-docked")).toBeVisible();
      await win.keyboard.press("Control+\\");
      await expect(win.getByTestId("sidebar-docked")).toBeHidden();
      await win.keyboard.press("Control+\\");
      await expect(win.getByTestId("sidebar-docked")).toBeVisible();

      await win.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(titleBar.getByRole("button", { name: "Back" })).toBeEnabled();
      await titleBar.getByRole("button", { name: "Back" }).click();
      await expect(win.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
      await titleBar.getByRole("button", { name: "Forward" }).click();
      await expect(win.getByText("Settings", { exact: true }).first()).toBeVisible();

      const previewHistoryUrl = await win.evaluate(async () => {
        const bridge = (window as unknown as { desktopBridge: SmokeDesktopBridge }).desktopBridge;
        const server = await bridge.getServerUrl();
        const firstUrl = new URL(server.url.replace(/^ws/, "http"));
        firstUrl.pathname = "/health";
        firstUrl.search = "";
        firstUrl.hash = "one";
        const secondUrl = new URL(firstUrl);
        secondUrl.hash = "two";

        await bridge.preview.sync({
          visible: true,
          bounds: { x: 760, y: 100, width: 360, height: 320 },
          threadId: "desktop-titlebar-e2e",
          resumeUrlHint: firstUrl.href,
          workspaceId: "desktop-titlebar-e2e",
        });
        const navigation = await bridge.preview.navigate(secondUrl.href);
        if (!navigation.ok) throw new Error("Preview navigation failed during desktop smoke");
        return secondUrl.href;
      });

      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow, WebContentsView }) => {
            const window = BrowserWindow.getAllWindows()[0];
            return (
              window?.contentView.children
                .filter((child) => child instanceof WebContentsView)
                .map((child) => child.webContents.getURL()) ?? []
            );
          }),
        )
        .toContain(previewHistoryUrl);

      const focusedPreviewUrl = await app.evaluate(({ BrowserWindow, WebContentsView }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const preview = window?.contentView.children.find(
          (child) => child instanceof WebContentsView && child.webContents.getURL().length > 0,
        );
        if (!(preview instanceof WebContentsView)) {
          throw new Error("Preview WebContentsView was not mounted");
        }
        preview.webContents.focus();
        return preview.webContents.getURL();
      });
      expect(focusedPreviewUrl).toBe(previewHistoryUrl);

      await app.evaluate(({ BrowserWindow, WebContentsView }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const preview = window?.contentView.children.find(
          (child) => child instanceof WebContentsView && child.webContents.getURL().length > 0,
        );
        if (!(preview instanceof WebContentsView)) {
          throw new Error("Preview WebContentsView was not mounted");
        }
        const isMac = process.platform === "darwin";
        preview.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: isMac ? "[" : "Left",
          modifiers: [isMac ? "meta" : "alt"],
        });
        preview.webContents.sendInputEvent({
          type: "keyUp",
          keyCode: isMac ? "[" : "Left",
          modifiers: [isMac ? "meta" : "alt"],
        });
      });

      await expect(win.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
      const previewUrlAfterHostBack = await app.evaluate(({ BrowserWindow, WebContentsView }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const preview = window?.contentView.children.find(
          (child) => child instanceof WebContentsView && child.webContents.getURL().length > 0,
        );
        if (!(preview instanceof WebContentsView)) {
          throw new Error("Preview WebContentsView was not mounted");
        }
        return preview.webContents.getURL();
      });
      expect(previewUrlAfterHostBack).toBe(previewHistoryUrl);
      await win.evaluate(async () => {
        const bridge = (window as unknown as { desktopBridge: SmokeDesktopBridge }).desktopBridge;
        await bridge.preview.sync({
          visible: false,
          bounds: null,
          threadId: "desktop-titlebar-e2e",
          workspaceId: "desktop-titlebar-e2e",
        });
      });
      await titleBar.getByRole("button", { name: "Forward" }).click();
      await expect(win.getByText("Settings", { exact: true }).first()).toBeVisible();

      await win.keyboard.press("Alt+f");
      await expect(win.getByText("New project", { exact: true })).toBeVisible();
      await win.keyboard.press("Escape");

      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setSize(640, 720);
      });
      await expect(titleBar.getByRole("button", { name: "Application menu" })).toBeVisible();
      await expect(titleBar.getByText("File", { exact: true })).toBeHidden();
      await titleBar.getByRole("button", { name: "Application menu" }).click();
      await win.getByRole("menuitem", { name: "File" }).click();
      await expect(win.getByText("New project", { exact: true })).toBeVisible();
      await win.keyboard.press("Escape");

      const maximized = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) return false;
        window.maximize();
        const result = window.isMaximized();
        window.unmaximize();
        return result;
      });
      expect(maximized).toBe(true);

      await win.screenshot({
        path: resolve(
          DESKTOP_DIR,
          "..",
          "..",
          ".dev",
          "verification",
          "desktop-titlebar",
          "narrow.png",
        ),
        fullPage: true,
      });

      expect(rendererErrors, "renderer console errors").toEqual([]);
    } finally {
      await app.close();
    }
  });
});
