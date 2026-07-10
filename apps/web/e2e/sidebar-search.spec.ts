import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

test.describe("Sidebar thread actions", () => {
  test.beforeEach(async ({ page }) => {
    const now = new Date().toISOString();
    await mockWebSocketServer(page, {
      "workspace.list": [
        {
          id: "ws-1",
          name: "Test Workspace",
          path: "/test/path",
          provider_config: {},
          is_git_repo: true,
          pinned: false,
          last_opened_at: Date.now() - 3600_000,
          sort_order: 0,
          created_at: now,
          updated_at: now,
        },
      ],
      "thread.list": [
        {
          id: "thread-1",
          workspace_id: "ws-1",
          title: "Test Thread",
          status: "active",
          mode: "direct",
          worktree_path: null,
          branch: "main",
          worktree_managed: false,
          issue_number: null,
          pr_number: null,
          pr_status: null,
          sdk_session_id: null,
          created_at: now,
          updated_at: now,
          model: "claude-3-5-sonnet",
          provider: "claude",
          deleted_at: null,
          last_context_tokens: null,
          context_window: null,
          reasoning_level: null,
          interaction_mode: null,
          permission_mode: null,
          parent_thread_id: null,
          forked_from_message_id: null,
          copilot_agent: null,
          last_compact_summary: null,
        },
      ],
    });
  });

  test("Search threads opens the cross-project finder", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Search threads" }).click();

    const searchInput = page.locator('[data-slot="palette-input"]');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute(
      "placeholder",
      "Search thread title, project, provider, branch, or worktree…",
    );
    await expect(page.getByText("Recent activity", { exact: true })).toBeVisible();
  });

  test("Ctrl+Shift+F opens and focuses the thread finder", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("heading", { name: "What should we work on?" }).click();
    await page.keyboard.press("Control+Shift+F");
    const searchInput = page.locator('[data-slot="palette-input"]');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toBeFocused();
  });

  test("New thread opens the projectless workbench", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New thread", exact: true }).click();

    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page.getByTestId("new-thread-project-picker")).toBeVisible();
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
  });

  test("top actions and project rows share one left alignment", async ({ page }) => {
    await page.goto("/");
    const actionIcon = page.getByRole("button", { name: "New thread", exact: true }).locator("svg");
    const projectIcon = page.getByTestId("project-row-ws-1").locator("svg").first();
    const [actionBox, projectBox] = await Promise.all([
      actionIcon.boundingBox(),
      projectIcon.boundingBox(),
    ]);

    expect(actionBox).not.toBeNull();
    expect(projectBox).not.toBeNull();
    expect(Math.abs(actionBox!.x - projectBox!.x)).toBeLessThanOrEqual(1);
  });

  test("project controls appear only when the project row is hovered", async ({ page }) => {
    await page.goto("/");
    const projectRow = page.getByTestId("project-row-ws-1");
    const newThread = projectRow.getByRole("button", { name: "New thread in Test Workspace" });
    const options = projectRow.getByRole("button", { name: "Project options for Test Workspace" });

    await expect(newThread).toHaveCSS("opacity", "0");
    await expect(options).toHaveCSS("opacity", "0");
    await projectRow.hover();
    await expect(newThread).toHaveCSS("opacity", "1");
    await expect(options).toHaveCSS("opacity", "1");

    const [optionsBox, newThreadBox] = await Promise.all([
      options.boundingBox(),
      newThread.boundingBox(),
    ]);
    expect(optionsBox).not.toBeNull();
    expect(newThreadBox).not.toBeNull();
    expect(optionsBox!.x).toBeLessThan(newThreadBox!.x);
  });

  test("the finder keeps sort and filter controls with its results", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Search threads" }).click();
    const sortButton = page.getByLabel("Sort threads");
    await expect(sortButton).toBeVisible();
    const filterButton = page.getByLabel("Filter threads");
    await expect(filterButton).toBeVisible();
  });
});
