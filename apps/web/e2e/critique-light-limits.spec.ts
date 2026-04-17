import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Captures screenshots of light mode and the SidebarUsagePanel limits popover
 * for design critique. Writes into the per-test output directory.
 */
test.describe("Critique: light mode + limits", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("06-light-empty-state", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      localStorage.setItem("mcode-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.screenshot({
      path: testInfo.outputPath("06-light-empty-state.png"),
      fullPage: false,
    });
  });

  test("07-light-settings", async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      localStorage.setItem("mcode-theme", "light");
      document.documentElement.classList.remove("dark");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    const settingsLink = page.getByText("Settings", { exact: true }).first();
    if (await settingsLink.count()) {
      await settingsLink.click();
      await expect(page.getByRole("heading", { name: /Settings/i })).toBeVisible({ timeout: 1000 }).catch(() => {});
    }
    await page.screenshot({
      path: testInfo.outputPath("07-light-settings.png"),
      fullPage: false,
    });
  });

  test("08-dark-limits-popover", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Hover over the usage panel in the sidebar footer to surface the popover
    const usageTrigger = page.locator('[data-testid="sidebar-usage-trigger"]').first();
    if (await usageTrigger.count()) {
      await usageTrigger.hover();
      // Popover renders into a portal — wait for the role to appear.
      await expect(page.getByRole("tooltip").or(page.getByRole("dialog"))).toBeVisible({ timeout: 1000 }).catch(() => {});
    }
    await page.screenshot({
      path: testInfo.outputPath("08-dark-limits-popover.png"),
      fullPage: false,
    });
  });

  test("09-light-limits-popover", async ({ page }, testInfo) => {
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
      await expect(page.getByRole("tooltip").or(page.getByRole("dialog"))).toBeVisible({ timeout: 1000 }).catch(() => {});
    }
    await page.screenshot({
      path: testInfo.outputPath("09-light-limits-popover.png"),
      fullPage: false,
    });
  });
});
