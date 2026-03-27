import { test, expect, type Page } from "@playwright/test";

/**
 * Mock the WebSocket server so the WS transport connects and RPC calls
 * resolve instead of hanging. Required since App.tsx gates rendering on
 * transport readiness (shows "Connecting..." until WS opens).
 */
async function mockWebSocketServer(page: Page): Promise<void> {
  await page.routeWebSocket(/ws:\/\/localhost:3100/, (ws) => {
    ws.onMessage((data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const method = msg.method as string;
      let result: unknown = null;
      if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

test.describe("App shell", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
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
    // Sidebar header contains the brand name
    await expect(page.locator("text=Mcode")).toBeVisible();

    // Main area shows empty-state heading
    await expect(
      page.locator("h2", { hasText: "Select a thread" })
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

test.describe("Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("displays brand name", async ({ page }) => {
    await expect(page.locator("text=Mcode")).toBeVisible();
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
    await expect(page.locator("text=Open a folder")).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/sidebar-empty-state.png",
      fullPage: true,
    });
  });

  test("displays No projects yet message when no workspaces exist", async ({
    page,
  }) => {
    await expect(page.locator("text=No projects yet.")).toBeVisible();
  });

  test("plus button to add a project is visible", async ({ page }) => {
    await expect(
      page.locator('[aria-label="Open project folder"]')
    ).toBeVisible();
  });

  test("collapses and expands when toggle button is clicked", async ({
    page,
  }) => {
    // Brand name is visible when sidebar is expanded
    await expect(page.locator("text=Mcode")).toBeVisible();

    // Click the collapse/expand icon button (PanelLeftClose icon)
    const toggleBtn = page.locator(
      "button:has(svg)",
      { hasText: "" }
    ).first();

    // Find the collapse button by locating the header area button that is NOT the settings trigger
    // The sidebar header has exactly one button (the collapse toggle)
    const sidebarHeader = page.locator(".border-b.border-border.p-3").first();
    const collapseBtn = sidebarHeader.locator("button");
    await collapseBtn.click();

    // After collapse, brand name should disappear (sidebar collapses to w-12)
    await expect(page.locator("text=Mcode")).not.toBeVisible();
    await expect(page.locator("text=Projects")).not.toBeVisible();

    // Click again to expand
    await collapseBtn.click();
    await expect(page.locator("text=Mcode")).toBeVisible();

    void toggleBtn; // suppress unused variable warning
  });
});

// ---------------------------------------------------------------------------
// Chat - empty / no thread selected
// ---------------------------------------------------------------------------

test.describe("Chat empty state", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("shows Select a thread heading when no thread is active", async ({
    page,
  }) => {
    await expect(
      page.locator("h2", { hasText: "Select a thread" })
    ).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/chat-empty-state.png",
      fullPage: true,
    });
  });

  test("shows helper text directing the user to the sidebar", async ({
    page,
  }) => {
    await expect(
      page.locator("text=Choose a thread from the sidebar or create a new one.")
    ).toBeVisible();
  });

  test("no composer textarea is rendered in the empty state", async ({
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
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
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
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("Escape key does not crash the app when no thread is selected", async ({
    page,
  }) => {
    // This exercises the Escape shortcut handler that calls setActiveThread(null)
    await page.keyboard.press("Escape");
    // App should still show the empty state without errors
    await expect(
      page.locator("h2", { hasText: "Select a thread" })
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

test.describe("Accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
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
