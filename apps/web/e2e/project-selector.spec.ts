import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

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
    last_opened_at: NOW - 3_600_000,
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
    last_opened_at: NOW - 7_200_000,
    sort_order: 1,
  },
];

async function setupProjectlessWorkbench(page: Page, workspaces = MOCK_WORKSPACES) {
  await mockWebSocketServer(page, {
    "workspace.list": workspaces,
    "workspace.touchLastOpened": null,
    "thread.list": [],
    "git.listBranches": [{ name: "main", isCurrent: true }],
    "git.listWorktrees": [],
    "github.listOpenPrs": [],
    "settings.get": getDefaultSettings(),
    "filesystem.browse": {
      path: "/home/user",
      parent: "/home",
      isExactDirectory: true,
      entries: [{ name: "my-app", isDir: true }],
    },
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Projectless new-thread workbench", () => {
  test.setTimeout(30_000);

  test("replaces the recent-project landing", async ({ page }) => {
    await setupProjectlessWorkbench(page);

    await expect(page.getByTestId("new-thread-context-strip")).toBeVisible();
    await expect(page.locator('[aria-placeholder="Do anything"]')).toBeVisible();
    await expect(page.getByText("Recent Projects", { exact: true })).toHaveCount(0);
  });

  test("opens a searchable project chooser above the composer", async ({ page }) => {
    await setupProjectlessWorkbench(page);
    await page.getByTestId("new-thread-project-picker").click();

    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover.getByRole("combobox", { name: "Search projects" })).toBeFocused();
    await expect(popover.getByText("pinned-app", { exact: true })).toBeVisible();
    await expect(popover.getByText("recent-app", { exact: true })).toBeVisible();
    await expect(popover.getByRole("button", { name: "New project" })).toBeVisible();
  });

  test("selecting a project updates the canvas in place", async ({ page }) => {
    await setupProjectlessWorkbench(page);
    const editor = page.locator('[aria-placeholder="Do anything"]');
    await editor.fill("Keep this draft");
    await page.getByTestId("new-thread-project-picker").click();
    await page.locator('[data-slot="popover-content"]').getByText("pinned-app", { exact: true }).click();

    await expect(page.getByRole("heading", { name: "What should we build in pinned-app?" })).toBeVisible();
    await expect(page.getByTestId("new-thread-context-strip")).toContainText("pinned-app");
    await expect(editor).toHaveText("Keep this draft");
  });

  test("switches projects from the welcome heading without losing the draft", async ({ page }) => {
    await setupProjectlessWorkbench(page);
    const editor = page.locator('[aria-placeholder="Do anything"]');
    await editor.fill("Keep this draft");
    await page.getByTestId("new-thread-project-picker").click();
    await page.locator('[data-slot="popover-content"]').getByText("pinned-app", { exact: true }).click();

    await page.getByTestId("new-thread-active-project-picker").click();
    await page.locator('[data-slot="popover-content"]').getByText("recent-app", { exact: true }).click();

    await expect(page.getByRole("heading", { name: "What should we build in recent-app?" })).toBeVisible();
    await expect(page.getByTestId("new-thread-context-strip")).toContainText("recent-app");
    await expect(editor).toHaveText("Keep this draft");
  });

  test("clears selected project context without losing the draft", async ({ page }) => {
    await setupProjectlessWorkbench(page);
    const editor = page.locator('[aria-placeholder="Do anything"]');
    await editor.fill("Keep this draft");
    await page.getByTestId("new-thread-project-picker").click();
    await page.locator('[data-slot="popover-content"]').getByText("pinned-app", { exact: true }).click();

    await page.getByRole("button", { name: "Clear pinned-app project" }).click();

    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page.getByTestId("new-thread-project-picker")).toBeVisible();
    await expect(editor).toHaveText("Keep this draft");
  });

  test("New project opens the existing folder workflow", async ({ page }) => {
    await setupProjectlessWorkbench(page);
    await page.getByTestId("new-thread-project-picker").click();
    await page.locator('[data-slot="popover-content"]').getByRole("button", { name: "New project" }).click();

    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(page.locator('[data-slot="palette-input"]')).toHaveValue("~/");
  });

  test("handles an empty project list without restoring the old landing", async ({ page }) => {
    await setupProjectlessWorkbench(page, []);
    await page.getByTestId("new-thread-project-picker").click();

    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover.getByText("No matching projects.")).toBeVisible();
    await expect(popover.getByRole("button", { name: "New project" })).toBeVisible();
  });
});
