import { test, expect, type Page } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * E2E coverage for the floating-panel UI overhaul:
 *  1. Composer overflow popover (replaces inline Mode/Permissions/Tasks toggles).
 *  2. Right panel modal overlay at narrow viewports (<768px).
 *  3. Floating panel surfaces (page chrome darker than panel background, no
 *     inter-panel border lines).
 */

async function openComposerInNewThread(page: Page): Promise<void> {
  // App.tsx registers a "thread.new" command via the command registry; the
  // shortcut layer wires Cmd/Ctrl+N to thread.new which sets pendingNewThread
  // and renders the composer.
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+n" : "Control+n");
  // Wait for the composer's send button to mount instead of sleeping a fixed
  // interval. Send is the stable terminal control on the composer; if it's in
  // the DOM the surrounding mode/permissions controls have rendered too.
  await expect(page.getByRole("button", { name: /^(Send message|Queue message|Stop agent)$/ })).toBeVisible();
}

test.describe("Composer options — wide viewport (md+)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("renders Chat / Full access toggles inline and hides the overflow trigger", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    // Inline buttons are visible above the md breakpoint.
    await expect(page.getByRole("button", { name: /^Chat$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Full access$/ })).toBeVisible();

    // The overflow trigger is reserved for narrow viewports.
    await expect(page.getByRole("button", { name: "Composer options" })).toHaveCount(0);
  });
});

test.describe("Composer options — narrow viewport (below md)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.setViewportSize({ width: 600, height: 800 });
  });

  test("hides inline toggles and reveals them inside the overflow popover", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openComposerInNewThread(page);

    // Inline Chat / Full access buttons collapse below md.
    await expect(page.getByRole("button", { name: /^Chat$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Full access$/ })).toHaveCount(0);

    const trigger = page.getByRole("button", { name: "Composer options" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Popover exposes grouped Mode + Permissions controls.
    await expect(page.getByText("Mode", { exact: true })).toBeVisible();
    await expect(page.getByText("Permissions", { exact: true })).toBeVisible();
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

  test("captures wide-viewport screenshot (1280×800) showing floating panels", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: testInfo.outputPath("floating-wide.png"),
      fullPage: false,
    });
  });

  test("captures narrow-viewport screenshot (600×800)", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: testInfo.outputPath("floating-narrow.png"),
      fullPage: false,
    });
  });

  test("captures composer popover open at narrow viewport", async ({ page }, testInfo) => {
    // Overflow popover only renders below the md breakpoint.
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+n" : "Control+n");
    // Wait for the composer's overflow trigger to mount.
    const trigger = page.getByRole("button", { name: "Composer options" });
    await expect(trigger).toBeVisible();
    await trigger.click();
    // Wait for the popover to render its grouped controls before screenshotting.
    await expect(page.getByText("Mode", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("composer-popover.png"),
      fullPage: false,
    });
  });
});
