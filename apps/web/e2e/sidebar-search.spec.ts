import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

test.describe("Sidebar thread actions", () => {
  test.beforeEach(async ({ page }) => {
    const now = new Date().toISOString();
    const thread = {
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
    };
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
      "workspace.rename": {
        id: "ws-1",
        name: "Renamed Workspace",
        path: "/test/path",
        provider_config: {},
        is_git_repo: true,
        pinned: false,
        last_opened_at: Date.now() - 3600_000,
        sort_order: 0,
        created_at: now,
        updated_at: now,
      },
      "thread.list": [thread],
      "thread.recent": [
        {
          ...thread,
          workspace_name: "Test Workspace",
          workspace_path: "/test/path",
        },
        {
          ...thread,
          id: "thread-2",
          title: "Alpha thread",
          status: "completed",
          workspace_name: "Test Workspace",
          workspace_path: "/test/path",
        },
        {
          ...thread,
          id: "thread-3",
          title: "Beta thread",
          status: "paused",
          workspace_name: "Test Workspace",
          workspace_path: "/test/path",
        },
      ],
      "git.listBranches": [
        { name: "main", shortSha: "abc1234", type: "local", isCurrent: true },
        {
          name: "feature/canary",
          shortSha: "def5678",
          type: "local",
          isCurrent: false,
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
      "Search threads, projects, branches, worktrees…",
    );
    await expect(page.getByTestId("thread-search-toolbar")).toContainText(
      "3 recent threads",
    );
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

  test("selecting a project opens its new-thread workspace", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Select project Test Workspace" }).click();

    await expect(page.getByRole("heading", { name: "What should we build in Test Workspace?" })).toBeVisible();
    await expect(page.getByTestId("new-thread-context-strip")).toContainText("Test Workspace");
  });

  test("branch choices stay clickable above the new-thread context rail", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Select project Test Workspace" })
      .click();

    const branchTrigger = page.getByRole("button", { name: "From main" });
    await branchTrigger.click();

    const branchChoice = page.getByRole("button", { name: "feature/canary" });
    await expect(branchChoice).toBeVisible();
    const branchBox = await branchChoice.boundingBox();
    expect(branchBox).not.toBeNull();

    const branchHitText = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.textContent?.trim() ?? null,
      {
        x: branchBox!.x + branchBox!.width / 2,
        y: branchBox!.y + branchBox!.height / 2,
      },
    );
    expect(branchHitText).toContain("feature/canary");

    await branchChoice.click();
    await expect(
      page.getByRole("button", { name: "From feature/canary" }),
    ).toBeVisible();
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

  test("top actions use the same idle tone as project rows", async ({ page }) => {
    await page.goto("/");
    const newThread = page.getByRole("button", { name: "New thread", exact: true });
    const searchThreads = page.getByRole("button", { name: "Search threads" });
    const projectRow = page.getByTestId("project-row-ws-1");
    const [newThreadColor, searchThreadsColor, projectRowColor] = await Promise.all([
      newThread.evaluate((element) => getComputedStyle(element).color),
      searchThreads.evaluate((element) => getComputedStyle(element).color),
      projectRow.evaluate((element) => getComputedStyle(element).color),
    ]);

    expect(newThreadColor).toBe(projectRowColor);
    expect(searchThreadsColor).toBe(projectRowColor);
  });

  test("project row whitespace toggles its threads and reveals the nearby chevron", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("mcode-expanded-projects", JSON.stringify({ "ws-1": false }));
    });
    await page.goto("/");

    const projectRow = page.getByTestId("project-row-ws-1");
    const toggleThreads = projectRow.getByRole("button", {
      name: "Toggle threads for Test Workspace",
    });
    await expect(toggleThreads).toHaveAttribute("aria-expanded", "false");
    await expect(toggleThreads).toHaveCSS("opacity", "0");

    await projectRow.hover();
    await expect(toggleThreads).toHaveCSS("opacity", "1");

    const projectBox = await projectRow.boundingBox();
    expect(projectBox).not.toBeNull();
    await projectRow.click({ position: { x: projectBox!.width / 2, y: projectBox!.height / 2 } });
    await expect(toggleThreads).toHaveAttribute("aria-expanded", "true");

    await projectRow.focus();
    await expect(toggleThreads).toHaveCSS("opacity", "1");
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

  test("project options include Explorer and rename", async ({ page }) => {
    await page.goto("/");
    const options = page.getByRole("button", { name: "Project options for Test Workspace" });
    await options.click();

    await expect(page.getByText("Open in Explorer", { exact: true })).toBeVisible();
    await page.getByText("Rename project", { exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Rename project" })).toBeVisible();
    await dialog.getByLabel("Project name").fill("Renamed Workspace");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();

    await expect(
      page.getByRole("button", { name: "Select project Renamed Workspace" }),
    ).toBeVisible();
  });

  test("the finder keeps sort and filter controls with its results", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Search threads" }).click();
    const sortButton = page.getByLabel("Sort threads");
    await expect(sortButton).toBeVisible();
    const filterButton = page.getByLabel("Filter threads");
    await expect(filterButton).toBeVisible();
  });

  test("the finder applies filters to recent threads", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Search threads" }).click();
    await expect(page.getByTestId("thread-search-toolbar")).toContainText(
      "3 recent threads",
    );

    const filterButton = page.getByLabel("Filter threads");
    await filterButton.click();
    await expect(
      page.getByRole("checkbox", { name: "Action required" }),
    ).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Completed" }).click();

    await expect(page.getByTestId("thread-search-toolbar")).toContainText(
      "1 recent thread",
    );
    await expect(
      page.getByTestId("thread-search-result-thread-2"),
    ).toBeVisible();
    await expect(page.getByTestId("thread-search-result-thread-1")).toHaveCount(
      0,
    );
  });
});
