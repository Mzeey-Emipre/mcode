import { test } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Captures screenshots of light mode and the SidebarUsagePanel limits popover
 * for design critique. Writes to e2e/screenshots/critique/.
 */
test.describe("Critique: light mode + limits", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("06-light-empty-state", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      localStorage.setItem("mcode-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.waitForTimeout(200);
    await page.screenshot({
      path: "e2e/screenshots/critique/06-light-empty-state.png",
      fullPage: false,
    });
  });

  test("07-light-settings", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      localStorage.setItem("mcode-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.getByText("Settings", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({
      path: "e2e/screenshots/critique/07-light-settings.png",
      fullPage: false,
    });
  });

  test("08-dark-limits-popover", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Hover over the usage panel in the sidebar footer to surface the popover
    const usageTrigger = page.locator('[data-testid="sidebar-usage-trigger"]').first();
    if (await usageTrigger.count()) {
      await usageTrigger.hover();
    } else {
      // Fallback: hover any element in the sidebar footer area
      await page.locator("aside, .bg-sidebar").first().hover({ position: { x: 100, y: 800 } }).catch(() => {});
    }
    await page.waitForTimeout(600);
    await page.screenshot({
      path: "e2e/screenshots/critique/08-dark-limits-popover.png",
      fullPage: false,
    });
  });

  test("09-light-limits-popover", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      localStorage.setItem("mcode-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    const usageTrigger = page.locator('[data-testid="sidebar-usage-trigger"]').first();
    if (await usageTrigger.count()) {
      await usageTrigger.hover();
    } else {
      await page.locator("aside, .bg-sidebar").first().hover({ position: { x: 100, y: 800 } }).catch(() => {});
    }
    await page.waitForTimeout(600);
    await page.screenshot({
      path: "e2e/screenshots/critique/09-light-limits-popover.png",
      fullPage: false,
    });
  });
});
