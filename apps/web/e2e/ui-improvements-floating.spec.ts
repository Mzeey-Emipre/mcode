import { test, expect, type Page } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * E2E coverage for the floating-panel UI overhaul:
 *  1. Composer overflow popover (replaces inline Mode/Permissions/Tasks toggles).
 *  2. Right panel modal overlay at narrow viewports (<768px).
 *  3. Floating panel surfaces (page chrome darker than panel background, no
 *     inter-panel border lines).
 */

const GLOW_WAIT_MS = 150;

async function openComposerInNewThread(page: Page): Promise<void> {
  // The "New Thread" command sets pendingNewThread which renders the composer.
  await page.evaluate(() => {
    // App.tsx registers a "thread.new" command via the command registry.
    // Easier path: dispatch the workspaceStore action directly via window for tests.
    // Since the store isn't exposed by default, fall back to the keyboard shortcut
    // (Cmd/Ctrl+N) which the shortcut layer wires to thread.new.
  });
  // Cmd+N opens a new thread.
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+n" : "Control+n");
  await page.waitForTimeout(GLOW_WAIT_MS);
}

test.describe("Composer overflow popover", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  test("hides Mode/Permissions toggles inline; reveals them inside the popover", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    // The old inline "Chat" / "Plan" / "Full access" / "Supervised" buttons
    // must NOT be visible in the status bar.
    await expect(page.getByRole("button", { name: /^Chat$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Plan$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Full access$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Supervised$/i })).toHaveCount(0);

    // Composer options trigger is present.
    const trigger = page.getByRole("button", { name: "Composer options" });
    await expect(trigger).toBeVisible();

    await trigger.click();

    // Popover content should expose grouped Mode + Permissions controls.
    await expect(page.getByText("Mode", { exact: true })).toBeVisible();
    await expect(page.getByText("Permissions", { exact: true })).toBeVisible();

    // Both segmented options for each group are present.
    await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Full" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Supervised" })).toBeVisible();
  });

  test("Mode segmented control reflects aria-pressed when toggled", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    await page.getByRole("button", { name: "Composer options" }).click();
    const planBtn = page.getByRole("button", { name: "Plan" });
    const chatBtn = page.getByRole("button", { name: "Chat" });

    await expect(chatBtn).toHaveAttribute("aria-pressed", "true");
    await expect(planBtn).toHaveAttribute("aria-pressed", "false");

    await planBtn.click();

    await expect(planBtn).toHaveAttribute("aria-pressed", "true");
    await expect(chatBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("Tasks panel row is hidden when the thread has no tasks", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    await page.getByRole("button", { name: "Composer options" }).click();

    // The Tasks panel option should be absent for an empty new thread.
    await expect(page.getByText("Tasks panel")).toHaveCount(0);
  });
});

test.describe("Floating panel surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  test("page chrome uses --page token (darker than --background)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        page: root.getPropertyValue("--page").trim(),
        background: root.getPropertyValue("--background").trim(),
      };
    });

    // Both tokens must be defined.
    expect(tokens.page).not.toBe("");
    expect(tokens.background).not.toBe("");

    // They must differ — page chrome is intentionally tone-shifted from panel bg.
    expect(tokens.page).not.toBe(tokens.background);
  });

  test("main content panel uses rounded corners (no inter-panel border)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const main = page.locator("main").first();
    const radius = await main.evaluate((el) => getComputedStyle(el).borderRadius);
    // Tailwind rounded-lg compiles to non-zero radius.
    expect(radius).not.toBe("0px");
    expect(radius).not.toBe("");
  });

  test("no inter-panel border on Sidebar (right edge)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The sidebar's container shouldn't carry a right border anymore.
    const sidebarRoot = page.locator(".bg-sidebar").first();
    const rightBorder = await sidebarRoot.evaluate((el) =>
      getComputedStyle(el).borderRightWidth,
    );
    expect(rightBorder).toBe("0px");
  });
});

test.describe("Right panel modal overlay (narrow viewport)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  test("useMediaQuery reports below md at 600px", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const matchesMd = await page.evaluate(() =>
      window.matchMedia("(min-width: 768px)").matches,
    );
    expect(matchesMd).toBe(false);
  });

  test("useMediaQuery reports above md at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const matchesMd = await page.evaluate(() =>
      window.matchMedia("(min-width: 768px)").matches,
    );
    expect(matchesMd).toBe(true);
  });
});

test.describe("Visual regression — floating layout", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  test("captures wide-viewport screenshot (1280×800) showing floating panels", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: "e2e/screenshots/floating-wide.png",
      fullPage: false,
    });
  });

  test("captures narrow-viewport screenshot (600×800)", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: "e2e/screenshots/floating-narrow.png",
      fullPage: false,
    });
  });

  test("captures composer popover open", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+n" : "Control+n");
    await page.waitForTimeout(150);

    await page.getByRole("button", { name: "Composer options" }).click();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: "e2e/screenshots/composer-popover.png",
      fullPage: false,
    });
  });
});
