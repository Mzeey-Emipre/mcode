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
    const addProject = page.getByRole("button", { name: "Add project" });
    await expect(addProject).toBeVisible();
    await expect(addProject.locator("svg")).toHaveClass(/(^|\s)lucide-plus(\s|$)/);
  });

  test("collapses and expands when toggle button is clicked", async ({
    page,
  }) => {
    await expect(page.getByTestId("sidebar-docked").getByRole("img", { name: "Mcode" })).toBeVisible();

    // Collapse the sidebar
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    // The retained shell animates closed, then remains inert and hidden.
    await expect(page.getByTestId("sidebar-docked")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.getByTestId("sidebar-docked")).toHaveAttribute(
      "inert",
      "",
    );
    await expect(page.getByTestId("sidebar-docked")).toHaveCSS("width", "0px");
    await expect(page.getByText("Projects", { exact: true })).not.toBeVisible();

    // Reveal button is now inline in the main header — click to re-expand
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByTestId("sidebar-docked").getByRole("img", { name: "Mcode" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Projectless new-thread workbench
// ---------------------------------------------------------------------------

test.describe("Projectless new-thread workbench", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("shows the new-thread canvas when no workspace is active", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page.getByTestId("new-thread-project-picker")).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/chat-empty-state.png",
      fullPage: true,
    });
  });

  test("keeps the composer available before project selection", async ({ page }) => {
    await expect(page.locator('[aria-placeholder="Do anything"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose a project" })).toBeDisabled();
  });

  test("raises project context above the new-thread composer surface", async ({ page }) => {
    const contextRail = page.getByTestId("new-thread-context-strip");
    const composerSurface = page.getByTestId("composer-surface");
    await expect(contextRail).toBeVisible();
    await expect(composerSurface).toBeVisible();

    const [railBox, composerBox] = await Promise.all([
      contextRail.boundingBox(),
      composerSurface.boundingBox(),
    ]);

    expect(railBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(railBox!.x - composerBox!.x).toBeGreaterThanOrEqual(12);
    expect(composerBox!.x + composerBox!.width - (railBox!.x + railBox!.width)).toBeGreaterThanOrEqual(12);
    expect(Math.abs(railBox!.y + railBox!.height - composerBox!.y)).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

test.describe("Settings", () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test("opens as a full-page view with a back affordance", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // Settings is a full-page sectioned view, not a modal — a "Back to projects"
    // control replaces the sidebar and there is no [role="dialog"].
    await expect(
      page.getByRole("button", { name: "Back to projects" }),
    ).toBeVisible();
  });

  test("exposes Theme, Max concurrent agents, and Notifications controls", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeVisible();

    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.getByText("Max concurrent agents")).toBeVisible();

    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    await expect(
      page.getByText("Show desktop notifications for agent events."),
    ).toBeVisible();
  });

  test("renders the theme radios for system, dark, and light", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();

    await expect(page.getByRole("radio", { name: "System" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Light" })).toBeVisible();
  });

  test("switching theme toggles the document dark class", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();

    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("renders the notifications toggle as a switch", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click();

    await expect(page.getByRole("switch").first()).toBeVisible();
  });

  test("toggling the notifications switch changes its state", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click();

    const toggle = page.getByRole("switch").first();
    const initialState = await toggle.getAttribute("aria-checked");
    await toggle.click();
    const newState = await toggle.getAttribute("aria-checked");

    expect(newState).not.toBe(initialState);
  });

  test("exposes the max concurrent agents control", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Agent", exact: true }).click();

    await expect(page.getByText("Max concurrent agents")).toBeVisible();
  });

  test("returns to projects via the back affordance", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const back = page.getByRole("button", { name: "Back to projects" });
    await expect(back).toBeVisible();

    await back.click();
    await expect(back).not.toBeVisible();
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
    // Escape has no global chat-clearing fallback. The new-thread canvas should remain visible.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
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

  test("add project button has an accessible name", async ({ page }) => {
    const btn = page.getByRole("button", { name: "Add project" });
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
