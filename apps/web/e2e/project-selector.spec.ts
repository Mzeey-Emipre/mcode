import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const NOW = Date.now();

const MOCK_WORKSPACES = [
  {
    id: "ws-pinned",
    name: "pinned-app",
    path: "/home/user/pinned-app",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: true,
    last_opened_at: NOW - 3600_000,
    sort_order: 0,
  },
  {
    id: "ws-recent",
    name: "recent-app",
    path: "/home/user/recent-app",
    provider_config: {},
    is_git_repo: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: NOW - 7200_000,
    sort_order: 1,
  },
  {
    id: "ws-older",
    name: "older-app",
    path: "/home/user/older-app",
    provider_config: {},
    is_git_repo: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: false,
    last_opened_at: NOW - 86400_000,
    sort_order: 2,
  },
];

const MOCK_ENRICHMENT = {
  items: [
    { id: "ws-pinned", branch: "main", isGit: true, isClean: true, threadCount: 3 },
    { id: "ws-recent", branch: null, isGit: false, isClean: true, threadCount: 0 },
    { id: "ws-older", branch: "feat/new-feature", isGit: true, isClean: false, threadCount: 1 },
  ],
};

const MOCK_SETTINGS = getDefaultSettings();

async function setupLanding(page: import("@playwright/test").Page) {
  await mockWebSocketServer(page, {
    "workspace.list": MOCK_WORKSPACES,
    "workspace.enrich": MOCK_ENRICHMENT,
    "workspace.touchLastOpened": null,
    "workspace.pin": null,
    "workspace.removeRecent": null,
    "settings.get": MOCK_SETTINGS,
  });
  await page.goto("/");
  // Wait for React to mount — "pinned-app" appears in multiple places (sidebar
  // + landing), so use .first() to avoid strict-mode violations.
  await expect(page.getByText("pinned-app").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(200);
}

test.describe("Project selector — cold-start landing", () => {
  test.setTimeout(30000);

  test("shows landing screen when no workspace is active", async ({ page }) => {
    await setupLanding(page);
    // The landing shows the pinned section (workspace is pinned in mock data)
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
    // Landing wordmark — exact match avoids matching "Mcode" in the sidebar
    await expect(page.getByText("mcode", { exact: true })).toBeVisible();
  });

  test("landing shows pinned and recent project sections", async ({ page }) => {
    await setupLanding(page);
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
    await expect(page.getByText("pinned-app").first()).toBeVisible();
    await expect(page.getByText("recent-app").first()).toBeVisible();
  });

  test("clicking a project on the landing opens it (hides landing)", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": MOCK_WORKSPACES,
      "workspace.enrich": MOCK_ENRICHMENT,
      "workspace.touchLastOpened": null,
      "thread.list": [],
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    await expect(page.getByText("pinned-app").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(200);

    // Click the pinned project row — target the testid to avoid matching the sidebar entry.
    await page.getByTestId("project-row").filter({ hasText: "pinned-app" }).click();
    // Landing wordmark should disappear once a workspace is active.
    // Use exact: true to avoid matching "Mcode" in the persistent sidebar.
    await expect(page.getByText("mcode", { exact: true })).not.toBeVisible({ timeout: 3000 });
  });

  test("empty state shows Add project CTA when no workspaces exist", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [],
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    // Empty state renders without projects — wait for the CTA.
    // "No projects yet" appears in both sidebar and landing, so use .first().
    await expect(page.getByText("No projects yet").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(200);
    await expect(page.getByTestId("landing-add-project")).toBeVisible();
  });

  test("Add project CTA opens the palette in browse mode", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [],
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "filesystem.browse": {
        path: "/home/user",
        parent: "/home",
        entries: [{ name: "my-app", isDir: true }],
      },
    });
    await page.goto("/");
    await expect(page.getByText("No projects yet").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(200);
    await page.getByTestId("landing-add-project").click();
    // Palette opens with the input pre-seeded to "~/", so browse mode is active
    // and the inline Add chip is visible.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId("palette-add-folder")).toBeVisible();
    await expect(page.locator('[data-slot="palette-input"]')).toHaveValue("~/");
  });

  test("Ctrl+Enter on landing opens add-project palette (browse mode)", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [],
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "filesystem.browse": {
        path: "/home/user",
        parent: "/home",
        entries: [{ name: "my-app", isDir: true }],
      },
    });
    await page.goto("/");
    await expect(page.getByText("No projects yet").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(200);
    // New keyboard-hint row — fails fast if Playwright hits a stale dev server (reuseExistingServer).
    await expect(page.getByText("Add project", { exact: true })).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Control+Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId("palette-add-folder")).toBeVisible();
    await expect(page.locator('[data-slot="palette-input"]')).toHaveValue("~/");
  });

  test("Add project button does not emit dragstart when mouse-dragged", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [],
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
    });
    await page.goto("/");
    await expect(page.getByText("No projects yet").first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      (window as unknown as { __landingDragStarts?: number }).__landingDragStarts = 0;
      document.addEventListener(
        "dragstart",
        () => {
          const w = window as unknown as { __landingDragStarts?: number };
          w.__landingDragStarts = (w.__landingDragStarts ?? 0) + 1;
        },
        true,
      );
    });
    const btn = page.getByTestId("landing-add-project");
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 60, box!.y + box!.height / 2 + 40);
    await page.mouse.up();
    const dragStarts = await page.evaluate(
      () => (window as unknown as { __landingDragStarts?: number }).__landingDragStarts ?? 0,
    );
    expect(dragStarts).toBe(0);
  });
});
