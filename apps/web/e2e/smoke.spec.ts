import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_SETTINGS = getDefaultSettings();

test.describe("Mcode App", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
    });
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
    // Use exact: true to avoid matching "mcode" in the landing wordmark
    await expect(page.getByText("Mcode", { exact: true })).toBeVisible();
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/sidebar.png", fullPage: true });
  });

  test("shows landing when no workspace is active", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // When no workspace is active, the full-screen landing shows with "mcode" wordmark
    await expect(page.getByText("What should we work on?", { exact: true })).toBeVisible();
  });

  test("settings button is visible", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Settings")).toBeVisible();
  });

  test("open folder button is visible", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Both the sidebar and the landing's empty state surface "Open a folder";
    // `.first()` picks one without making the assertion mode-strict.
    await expect(page.locator("text=Open a folder").first()).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/open-folder.png", fullPage: true });
  });
});
