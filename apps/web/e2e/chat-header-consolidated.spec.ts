import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_SETTINGS = getDefaultSettings();
const now = new Date().toISOString();
const WS_ID = "ws-1";

const workspace = {
  id: WS_ID,
  name: "Test Workspace",
  path: "/test/path",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now() - 3600_000,
  sort_order: 0,
};

const thread = {
  id: "thread-1",
  workspace_id: WS_ID,
  title: "Consolidated Header Thread",
  status: "paused" as const,
  mode: "worktree" as const,
  worktree_path: "/test/path/.worktrees/feat-x",
  branch: "feat/consolidated-header",
  worktree_managed: true,
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
};

const gitCommit = {
  sha: "abc1234",
  message: "feat: work",
  author: "Tester",
  date: now,
};

test.describe("Consolidated chat header", () => {
  // Dock the right panel inline (not as a modal overlay) so the header toggle
  // stays clickable for the show/hide assertions. The default panel width is 50%
  // of the viewport, so the panel only stays inline (rather than popping out as a
  // modal that intercepts the toggle click) on a wide desktop viewport.
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((wsId: string) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify({ [wsId]: true }),
      );
    }, WS_ID);

    await mockWebSocketServer(page, {
      "workspace.list": [workspace],
      "workspace.enrich": { items: [] },
      "workspace.touchLastOpened": null,
      "thread.list": [thread],
      "settings.get": MOCK_SETTINGS,
      // Keep PR polling deterministic: no existing PR, one commit ahead so the
      // Create PR affordance renders enabled.
      "github.branchPr": null,
      "git.log": [gitCommit],
    });
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-item']");
    await page.locator("[data-testid='thread-item']").first().click();
    await page.waitForSelector("[data-testid='chat-header-title']");
  });

  test("keeps Create PR and Open visible alongside the consolidated controls", async ({ page }) => {
    await expect(page.getByRole("button", { name: /create pr/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^open in /i })).toBeVisible();
    await expect(page.getByTestId("header-workspace-menu")).toBeVisible();
    await expect(page.getByTestId("header-panel-toggle")).toBeVisible();
  });

  test("consolidated menu holds Changes / Branch / Commit or push and not Create PR", async ({ page }) => {
    await page.getByTestId("header-workspace-menu").click();

    await expect(page.getByTestId("workspace-menu-changes")).toBeVisible();
    await expect(page.getByTestId("workspace-menu-branch")).toBeVisible();
    await expect(page.getByTestId("workspace-menu-commit")).toBeVisible();

    // The branch item surfaces the current branch name.
    await expect(page.getByTestId("workspace-menu-branch")).toContainText("feat/consolidated-header");
    // Create PR is its own button — it must not be duplicated inside the menu.
    await expect(page.getByTestId("workspace-menu-changes")).not.toContainText(/create pr/i);
    await expect(page.getByTestId("workspace-menu-commit")).not.toContainText(/create pr/i);
  });

  test("panel toggle shows and hides the workspace-global right panel", async ({ page }) => {
    const toggle = page.getByTestId("header-panel-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // The panel's tab rail becomes visible once the panel opens.
    await expect(page.getByText("Changes", { exact: true })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("Changes menu item opens the right panel", async ({ page }) => {
    const toggle = page.getByTestId("header-panel-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await page.getByTestId("header-workspace-menu").click();
    await page.getByTestId("workspace-menu-changes").click();

    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});
