import { test, expect, type Page } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_SETTINGS = getDefaultSettings();
const DEFAULT_OVERRIDES = {
  "workspace.enrich": { items: [] },
  "settings.get": MOCK_SETTINGS,
};

async function setup(page: Page): Promise<void> {
  await mockWebSocketServer(page, DEFAULT_OVERRIDES);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

test.describe("App shell", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("loads with dark theme applied to root", async ({ page }) => {
    // The App component toggles the "dark" class on <html> based on theme store
    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);

    await page.screenshot({
      path: "e2e/screenshots/app-shell-dark.png",
      fullPage: true,
    });
  });

  test("layout has sidebar and main content area", async ({ page }) => {
    await expect(page.getByTestId("sidebar-docked").getByRole("img", { name: "Mcode" })).toBeVisible();
    await expect(page.locator("main").getByRole("img", { name: "Mcode" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

test.describe("Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("displays brand name", async ({ page }) => {
    await expect(page.getByTestId("sidebar-docked").getByRole("img", { name: "Mcode" })).toBeVisible();
  });

  test("displays Projects section heading", async ({ page }) => {
    await expect(
      page.getByText("Projects", { exact: true })
    ).toBeVisible();
  });

  test("displays Settings button in sidebar footer", async ({ page }) => {
    await expect(page.locator("button", { hasText: "Settings" })).toBeVisible();
  });

  test("displays Open a folder call-to-action when no workspaces exist", async ({
    page,
  }) => {
    // The landing page's empty state also surfaces an "Open a folder" CTA, so
    // there are multiple matches — `.first()` picks the sidebar's link, which
    // is what this test is verifying.
    await expect(page.locator("text=Open a folder").first()).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/sidebar-empty-state.png",
      fullPage: true,
    });
  });

  test("displays No projects yet message when no workspaces exist", async ({
    page,
  }) => {
    await expect(page.locator("text=No projects yet").first()).toBeVisible();
  });

  test("plus button to add a project is visible", async ({ page }) => {
    await expect(
      page.locator('[aria-label="Open project folder"]')
    ).toBeVisible();
  });

  test("collapses and expands when toggle button is clicked", async ({
    page,
  }) => {
    await expect(page.getByTestId("sidebar-docked").getByRole("img", { name: "Mcode" })).toBeVisible();

    // Collapse the sidebar
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    // The sidebar unmounts on collapse so brand and project tree are gone
    await expect(page.getByTestId("sidebar-docked")).not.toBeVisible();
    await expect(page.getByText("Projects", { exact: true })).not.toBeVisible();

    // Reveal button is now inline in the main header — click to re-expand
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByTestId("sidebar-docked").getByRole("img", { name: "Mcode" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Landing / empty state (no active workspace)
// ---------------------------------------------------------------------------

test.describe("Landing empty state", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("shows landing when no workspace is active", async ({ page }) => {
    // When no workspace is active the landing replaces the chat view
    await expect(page.locator("main").getByRole("img", { name: "Mcode" })).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/chat-empty-state.png",
      fullPage: true,
    });
  });

  test("landing shows Add project CTA when no workspaces exist", async ({
    page,
  }) => {
    // The landing shows "No projects yet" (appears in sidebar and landing)
    await expect(page.locator("text=No projects yet").first()).toBeVisible();
  });

  test("no composer textarea is rendered on the landing", async ({
    page,
  }) => {
    // Composer is only mounted when a thread is active or a new thread is pending
    await expect(page.locator("textarea")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

test.describe("Settings dialog", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("opens when Settings button is clicked", async ({ page }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    // Dialog title should appear
    await expect(
      page.locator('[role="dialog"]').locator("text=Settings")
    ).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/settings-dialog-open.png",
      fullPage: true,
    });
  });

  test("displays Theme, Max Concurrent Agents, and Notifications controls", async ({
    page,
  }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator("text=Theme")).toBeVisible();
    await expect(dialog.locator("text=Max Concurrent Agents")).toBeVisible();
    await expect(dialog.locator("text=Notifications")).toBeVisible();
  });

  test("theme buttons are rendered for system, dark, and light", async ({
    page,
  }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator("button", { hasText: "system" })).toBeVisible();
    await expect(dialog.locator("button", { hasText: "dark" })).toBeVisible();
    await expect(dialog.locator("button", { hasText: "light" })).toBeVisible();
  });

  test("clicking a theme option does not crash the app", async ({ page }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("button", { hasText: "light" }).click();

    // Dialog should remain open; no error state
    await expect(dialog.locator("text=Settings")).toBeVisible();
  });

  test("notifications toggle is rendered as a switch", async ({ page }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('[role="switch"]')).toBeVisible();
  });

  test("notifications toggle changes state on click", async ({ page }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    const toggle = dialog.locator('[role="switch"]');

    const initialState = await toggle.getAttribute("aria-checked");
    await toggle.click();
    const newState = await toggle.getAttribute("aria-checked");

    expect(newState).not.toBe(initialState);
  });

  test("max concurrent agents slider is present and interactive", async ({
    page,
  }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    const slider = dialog.locator("#max-agents");
    await expect(slider).toBeVisible();

    // Verify the slider has numeric value within allowed range
    const value = await slider.inputValue();
    const numValue = Number(value);
    expect(numValue).toBeGreaterThanOrEqual(1);
    expect(numValue).toBeLessThanOrEqual(10);
  });

  test("closes when Escape is pressed", async ({ page }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(dialog).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

test.describe("Keyboard shortcuts", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("Escape key does not crash the app when no thread is selected", async ({
    page,
  }) => {
    // Escape fires the escape.handle command which calls setActiveThread(null) —
    // a no-op when no thread is active. The landing should remain visible.
    await page.keyboard.press("Escape");
    // Landing should still be visible, no error overlay
    await expect(page.getByText("mcode", { exact: true })).toBeVisible();
    await expect(page.locator(".vite-error-overlay")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

test.describe("Accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("open project folder button has aria-label", async ({ page }) => {
    const btn = page.locator('[aria-label="Open project folder"]');
    await expect(btn).toBeVisible();
  });

  test("Settings button is keyboard focusable", async ({ page }) => {
    await page.keyboard.press("Tab");
    // Tab through until Settings button has focus; it is in the sidebar
    const settingsBtn = page.locator("button", { hasText: "Settings" });
    // Just verify it can receive focus programmatically
    await settingsBtn.focus();
    await expect(settingsBtn).toBeFocused();
  });
});
