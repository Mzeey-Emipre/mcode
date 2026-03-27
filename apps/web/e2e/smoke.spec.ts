import { test, expect, type Page } from "@playwright/test";

/**
 * Mock the WebSocket server so the WS transport connects and RPC calls
 * resolve instead of hanging. Required since App.tsx gates rendering on
 * transport readiness (shows "Connecting..." until WS opens).
 */
async function mockWebSocketServer(page: Page): Promise<void> {
  await page.routeWebSocket(/ws:\/\/localhost:3100/, (ws) => {
    ws.onMessage((data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const method = msg.method as string;
      let result: unknown = null;
      if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
}

test.describe("Mcode App", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });
  test("loads with dark theme", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "e2e/screenshots/dark-theme.png", fullPage: true });

    // Verify dark background
    const bg = await page.locator("body").evaluate((el) =>
      getComputedStyle(el).backgroundColor
    );
    // Should not be white
    expect(bg).not.toBe("rgb(255, 255, 255)");
  });

  test("sidebar shows Mcode title and Projects", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Mcode")).toBeVisible();
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/sidebar.png", fullPage: true });
  });

  test("shows select thread state when no thread active", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Select a thread")).toBeVisible();
  });

  test("settings button is visible", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Settings")).toBeVisible();
  });

  test("open folder button is visible", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Open a folder")).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/open-folder.png", fullPage: true });
  });
});
