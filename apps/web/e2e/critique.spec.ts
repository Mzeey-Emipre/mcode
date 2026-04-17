import { test } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Critique screenshot spec — captures multiple representative views for design review.
 * Not an assertion test; only writes screenshots into e2e/screenshots/critique/.
 */
test.describe("Critique screenshots", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("01-empty-state", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: "e2e/screenshots/critique/01-empty-state.png",
      fullPage: false,
    });
  });

  test("02-sidebar-collapsed", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Collapse sidebar/i }).click().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({
      path: "e2e/screenshots/critique/02-sidebar-collapsed.png",
      fullPage: false,
    });
  });

  test("03-settings", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByText("Settings", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({
      path: "e2e/screenshots/critique/03-settings.png",
      fullPage: false,
    });
  });

  test("04-command-palette", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    await page.screenshot({
      path: "e2e/screenshots/critique/04-command-palette.png",
      fullPage: false,
    });
  });

  test("05-shortcuts-help", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+/");
    await page.waitForTimeout(300);
    await page.screenshot({
      path: "e2e/screenshots/critique/05-shortcuts-help.png",
      fullPage: false,
    });
  });
});
