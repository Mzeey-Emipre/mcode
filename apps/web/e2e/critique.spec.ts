import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Critique screenshot spec — captures multiple representative views for design review.
 * Not an assertion test; only writes screenshots into the per-test output directory.
 */
test.describe("Critique screenshots", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("01-empty-state", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: testInfo.outputPath("01-empty-state.png"),
      fullPage: false,
    });
  });

  test("02-sidebar-collapsed", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const collapseBtn = page.getByRole("button", { name: /Collapse sidebar/i });
    if (await collapseBtn.count()) {
      await collapseBtn.first().click();
      // Sidebar collapse is a CSS width transition; wait for the animation to settle.
      await expect(collapseBtn.first()).toBeHidden({ timeout: 1000 }).catch(() => {});
    }
    await page.screenshot({
      path: testInfo.outputPath("02-sidebar-collapsed.png"),
      fullPage: false,
    });
  });

  test("03-settings", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const settingsLink = page.getByText("Settings", { exact: true }).first();
    if (await settingsLink.count()) {
      await settingsLink.click();
      // Settings panel renders a heading; wait for it instead of sleeping.
      await expect(page.getByRole("heading", { name: /Settings/i })).toBeVisible({ timeout: 1000 }).catch(() => {});
    }
    await page.screenshot({
      path: testInfo.outputPath("03-settings.png"),
      fullPage: false,
    });
  });

  test("04-command-palette", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+k");
    // Command palette mounts an input; wait for it to be focusable.
    await expect(page.getByRole("dialog").or(page.getByRole("combobox"))).toBeVisible({ timeout: 1000 }).catch(() => {});
    await page.screenshot({
      path: testInfo.outputPath("04-command-palette.png"),
      fullPage: false,
    });
  });

  test("05-shortcuts-help", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+/");
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 }).catch(() => {});
    await page.screenshot({
      path: testInfo.outputPath("05-shortcuts-help.png"),
      fullPage: false,
    });
  });
});
