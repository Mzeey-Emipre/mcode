import { test, expect } from "@playwright/test";

test.describe("Mcode App", () => {
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
