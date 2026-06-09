import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_WORKSPACES = [
  {
    id: "ws-1",
    name: "my-app",
    path: "/home/user/my-app",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: true,
    last_opened_at: Date.now() - 3600_000,
    sort_order: 0,
  },
  {
    id: "ws-2",
    name: "side-project",
    path: "/home/user/side-project",
    provider_config: {},
    is_git_repo: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: Date.now() - 86400_000,
    sort_order: 1,
  },
];

const MOCK_BROWSE_RESULT = {
  path: "/home/user",
  parent: "/home",
  entries: [
    { name: "my-app", isDir: true },
    { name: "side-project", isDir: true },
    { name: "README.md", isDir: false },
  ],
};

const MOCK_SETTINGS = getDefaultSettings();

async function setupPage(page: import("@playwright/test").Page) {
  await mockWebSocketServer(page, {
    "workspace.list": MOCK_WORKSPACES,
    "workspace.enrich": { items: [] },
    "workspace.touchLastOpened": null,
    "filesystem.browse": MOCK_BROWSE_RESULT,
    "workspace.create": {
      id: "ws-new",
      name: "new-project",
      path: "/home/user/new-project",
      provider_config: {},
      is_git_repo: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pinned: false,
      last_opened_at: null,
      sort_order: 0,
    },
    "settings.get": MOCK_SETTINGS,
    "thread.list": [],
  });
  await page.goto("/");
  // Wait for React to mount — "my-app" appears in the sidebar once the WS connects
  // and initTransport resolves. Then allow useEffects (initShortcuts) to run.
  // "my-app" appears in multiple places (sidebar + landing), so use .first().
  await expect(page.getByText("my-app").first()).toBeVisible({ timeout: 15000 });
  // React schedules useEffect after the first render/paint. Give effects time to
  // attach the keydown listener before the test fires keyboard shortcuts.
  await page.waitForTimeout(200);
}

test.describe("Command palette", () => {
  test.setTimeout(30000);

  test("opens with Ctrl+K", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    // Palette input should be focused
    await expect(page.locator('[data-slot="palette-input"]')).toBeFocused();
  });

  test("opens with Ctrl+P (legacy keybinding)", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+p");
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("closes with Escape", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("> prefix filters to Actions only", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    await page.locator('[data-slot="palette-input"]').fill(">");
    // Should show Actions section — use exact to avoid matching "Actions only" text
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Actions", { exact: true })).toBeVisible();
    // Should NOT show Recent Projects heading
    await expect(dialog.getByText("Recent Projects")).not.toBeVisible();
  });

  test("typing a path prefix flips the palette into browse mode", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    const input = page.locator('[data-slot="palette-input"]');
    await input.fill("~/");
    // The Add chip is the unmistakable signal that browse mode is active.
    await expect(page.getByTestId("palette-add-folder")).toBeVisible();
    // The mode label is exposed on the wrapper for diagnostics.
    await expect(page.locator('[data-slot="palette-input-wrapper"]')).toHaveAttribute(
      "data-palette-mode",
      "browse",
    );
  });

  test("Backspace on empty input pops from projects view to root", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    // Navigate to projects view via Ctrl+O
    await page.keyboard.press("Control+o");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Backspace on empty input should pop back to root
    const input = page.locator('[data-slot="palette-input"]');
    await expect(input).toHaveValue("");
    await page.keyboard.press("Backspace");
    await expect(dialog.getByText("Actions", { exact: true })).toBeVisible();
  });

  test("Ctrl+Enter in browse mode triggers the Add action", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    const input = page.locator('[data-slot="palette-input"]');
    await input.fill("~/");
    // The Add chip appears the instant browse mode flips on (purely query-based),
    // but BrowseView's handleAdd needs the resolved server path from the
    // filesystem.browse RPC before it can fire. Wait for entries to render.
    const dialog = page.getByRole("dialog");
    await expect(page.getByTestId("palette-add-folder")).toBeVisible();
    await expect(dialog.locator('[data-slot="command-item"]').first()).toBeVisible();
    await page.keyboard.press("Control+Enter");
    // Successful add closes the palette.
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 3000 });
  });

  test("adding a project lands in the new-thread composer on that project", async ({ page }) => {
    await setupPage(page);
    await page.keyboard.press("Control+k");
    const input = page.locator('[data-slot="palette-input"]');
    await input.fill("~/");
    const dialog = page.getByRole("dialog");
    await expect(page.getByTestId("palette-add-folder")).toBeVisible();
    await expect(dialog.locator('[data-slot="command-item"]').first()).toBeVisible();
    await page.keyboard.press("Control+Enter");
    // The palette closes and we drop straight into the new-thread composer for
    // the just-added project — not back to the cold-start landing.
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByText("New thread", { exact: true })).toBeVisible({ timeout: 3000 });
    // The composer badge names the just-added project (from the workspace.create mock).
    await expect(page.getByText("new-project").first()).toBeVisible();
    // The landing wordmark is gone — exact match avoids matching "Mcode" in the sidebar.
    await expect(page.getByText("mcode", { exact: true })).not.toBeVisible();
  });
});
