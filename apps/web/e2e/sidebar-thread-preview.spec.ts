import { test, expect } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

const now = new Date().toISOString();
const workspace = {
  id: "ws-preview",
  name: "Preview Workspace",
  path: "/tmp/preview-workspace",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: Date.now() - 3600_000,
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-direct",
    workspace_id: workspace.id,
    title: "Direct Thread",
    status: "paused",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    checkout_state: "named",
    base_branch: null,
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
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    default_open_in_app: null,
    has_file_changes: false,
    ...overrides,
  };
}

const threads = [
  thread(),
  thread({
    id: "thread-worktree",
    title: "Branchless Worktree",
    mode: "worktree",
    checkout_state: "branchless",
    branch: null,
    base_branch: "main",
    worktree_path: "/tmp/preview-workspace/.worktrees/branchless",
    provider: "codex",
  }),
  thread({
    id: "thread-pr",
    title: "Pull Request Thread",
    mode: "worktree",
    checkout_state: "named",
    branch: "feature/sidebar",
    worktree_path: "/tmp/preview-workspace/.worktrees/feature-sidebar",
    pr_number: 42,
    pr_status: "open",
  }),
  thread({ id: "thread-completed", title: "Completed Thread", status: "completed" }),
  thread({ id: "thread-errored", title: "Errored Thread", status: "errored" }),
  thread({ id: "thread-interrupted", title: "Interrupted Thread", status: "interrupted" }),
];

test.describe("Sidebar thread preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((workspaceId: string) => {
      localStorage.setItem("mcode-expanded-projects", JSON.stringify({ [workspaceId]: true }));
    }, workspace.id);

    const ws = await mockWebSocketServer(page, {
      "workspace.list": [workspace],
      "thread.list": threads,
      "settings.get": getDefaultSettings(),
      "providers.listAvailability": [
        {
          id: "claude",
          enabled: true,
          hasAdapter: true,
          beta: false,
          comingSoon: false,
          cli: { status: "found", resolvedPath: "claude", configuredPath: "" },
        },
        {
          id: "codex",
          enabled: true,
          hasAdapter: true,
          beta: false,
          comingSoon: false,
          cli: { status: "found", resolvedPath: "codex", configuredPath: "" },
        },
      ],
      "agent.listRunning": ["thread-worktree"],
    });

    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-list']");
    await ws.sendPush("thread.checksUpdated", {
      threadId: "thread-pr",
      checks: {
        aggregate: "failing",
        runs: [{ name: "build", status: "completed", conclusion: "failure" }],
      },
    });
  });

  test("opens on hover and focus with read-only project, branch, and provider", async ({ page }) => {
    const worktreeRow = page.locator('[data-testid="thread-item"][data-thread-id="thread-worktree"]');
    await expect(worktreeRow.getByLabel("Worktree mode")).toBeVisible();
    await expect(page.locator('[data-testid="thread-item"][data-thread-id="thread-direct"]').getByLabel("Worktree mode")).toHaveCount(0);

    await worktreeRow.hover();
    const hoverPreview = page.getByTestId("thread-preview-thread-worktree");
    await expect(hoverPreview).toBeVisible();
    await expect(page.getByLabel("Project, Preview Workspace")).toBeVisible();
    await expect(page.getByLabel("Branch, HEAD")).toBeVisible();
    await expect(page.getByLabel("Provider, Codex")).toBeVisible();
    await expect(page.getByLabel(/^Status,/)).toHaveCount(0);
    await expect(hoverPreview).not.toContainText("Running");
    await expect(hoverPreview).not.toContainText("Ready");
    await expect(hoverPreview).not.toContainText(/ago|now|yesterday/i);
    await page.screenshot({
      path: "e2e/screenshots/sidebar-thread-preview-hover.png",
      fullPage: true,
    });

    const directRow = page.locator('[data-testid="thread-item"][data-thread-id="thread-direct"] [role="button"]');
    await directRow.focus();
    await expect(page.getByTestId("thread-preview-thread-direct")).toBeVisible();
  });

  test("uses the light surface for the hover preview in light mode", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByRole("button", { name: "Back to projects" }).click();

    const worktreeRow = page.locator('[data-testid="thread-item"][data-thread-id="thread-worktree"]');
    await worktreeRow.hover();
    const hoverPreview = page.getByTestId("thread-preview-thread-worktree");
    await expect(hoverPreview).toBeVisible();
    await expect(page.getByLabel(/^Status,/)).toHaveCount(0);
    await expect(hoverPreview).not.toContainText("Running");
    await expect(hoverPreview).not.toContainText("Ready");
    await page.screenshot({
      path: "e2e/screenshots/sidebar-thread-preview-hover-light.png",
      fullPage: true,
    });
  });

  test("renders PR icon only at the leading edge and uses right-edge state precedence", async ({ page }) => {
    const directRow = page.locator('[data-testid="thread-item"][data-thread-id="thread-direct"]');
    await expect(directRow.locator("span.rounded-full")).toHaveCount(0);
    await expect(directRow.getByTitle(/PR #/)).toHaveCount(0);

    const prRow = page.locator('[data-testid="thread-item"][data-thread-id="thread-pr"]');
    await expect(prRow.getByTitle(/PR #42/)).toBeVisible();
    await expect(prRow.getByText("#42")).toHaveCount(0);
    await expect(prRow.getByLabel(/failing check/)).toHaveCount(0);
    const directTitle = await directRow.getByTestId("thread-title").boundingBox();
    const prTitle = await prRow.getByTestId("thread-title").boundingBox();
    expect(directTitle).not.toBeNull();
    expect(prTitle).not.toBeNull();
    expect(Math.abs((directTitle?.x ?? 0) - (prTitle?.x ?? 0))).toBeLessThanOrEqual(1);

    await expect(page.locator('[data-testid="thread-item"][data-thread-id="thread-worktree"]').getByLabel("Running")).toBeVisible();
    await expect(page.locator('[data-testid="thread-item"][data-thread-id="thread-completed"]').getByLabel("Completed")).toBeVisible();
    await expect(page.locator('[data-testid="thread-item"][data-thread-id="thread-errored"]').getByLabel("Errored")).toBeVisible();
    await expect(page.locator('[data-testid="thread-item"][data-thread-id="thread-interrupted"]').getByLabel("Interrupted")).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/sidebar-thread-row-states.png",
      fullPage: true,
    });
  });
});
