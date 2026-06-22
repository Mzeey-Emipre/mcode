import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Visual demo: Overview PR row action flow across branch readiness and PR states.
 * Captures screenshots to e2e/screenshots/demo/ for review without a live app.
 */

const now = new Date("2026-06-19T00:00:00.000Z").toISOString();
const WS_ID = "ws-pr-demo";

const workspace = {
  id: WS_ID,
  name: "mcode",
  path: "/tmp/mcode",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const thread = {
  id: "thread-pr-demo",
  workspace_id: WS_ID,
  title: "PR row polish",
  status: "paused" as const,
  mode: "worktree" as const,
  worktree_path: "/tmp/mcode/.worktrees/feat-pr-row",
  branch: "feat/pr-row-and-actions",
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

test.use({ viewport: { width: 1280, height: 900 } });

async function openOverview(page: import("@playwright/test").Page) {
  await page.addInitScript((wsId: string) => {
    localStorage.setItem("mcode-expanded-projects", JSON.stringify({ [wsId]: true }));
  }, WS_ID);
  await page.goto("/");
  await page.waitForSelector("[data-testid='thread-item']");
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector("[data-testid='chat-header-title']");
  await page.getByTestId("header-workspace-menu").click();
  await expect(page.getByTestId("thread-overview-body")).toBeVisible();
}

test("PR row demo: ready to create", async ({ page }) => {
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [thread],
    "github.branchPr": null,
    "git.log": [{ sha: "abc1234", message: "feat: pr row", author: "Tester", date: now }],
    "git.listBranches": [
      { name: "feat/pr-row-and-actions", shortSha: "abc1234", type: "local", isCurrent: true },
    ],
    "git.getRemoteUrl": {
      label: "Mzeey-Empire/mcode",
      webUrl: "https://github.com/Mzeey-Empire/mcode",
    },
    "git.workingTreeFiles": [],
  });

  await openOverview(page);

  await expect(page.getByTestId("workspace-menu-create-pr")).toContainText("Create PR");
  await expect(page.getByTestId("thread-overview-pr-status")).toHaveCount(0);

  await page.locator("[data-testid='thread-overview-pr']").screenshot({
    path: "e2e/screenshots/demo/pr-row-ready-create.png",
  });
});

test("PR row demo: push commits first", async ({ page }) => {
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [thread],
    "github.branchPr": null,
    "git.log": [],
    "git.listBranches": [
      { name: "feat/pr-row-and-actions", shortSha: "abc1234", type: "local", isCurrent: true },
    ],
    "git.getRemoteUrl": {
      label: "Mzeey-Empire/mcode",
      webUrl: "https://github.com/Mzeey-Empire/mcode",
    },
    "git.workingTreeFiles": ["apps/web/src/components/chat/ThreadOverview.tsx"],
  });

  await openOverview(page);

  await expect(page.getByTestId("workspace-menu-commit")).toContainText("Commit or push");
  await expect(page.getByTestId("workspace-menu-create-pr")).toHaveCount(0);

  await page.locator("[data-testid='thread-overview-pr']").screenshot({
    path: "e2e/screenshots/demo/pr-row-commit-first.png",
  });
});

test("PR row demo: view open PR", async ({ page }) => {
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [{ ...thread, pr_number: 790, pr_status: "OPEN" }],
    "github.branchPr": {
      number: 790,
      state: "OPEN",
      url: "https://github.com/Mzeey-Empire/mcode/pull/790",
    },
    "git.log": [{ sha: "abc1234", message: "feat: pr row", author: "Tester", date: now }],
    "git.listBranches": [
      { name: "feat/pr-row-and-actions", shortSha: "abc1234", type: "local", isCurrent: true },
    ],
    "git.getRemoteUrl": {
      label: "Mzeey-Empire/mcode",
      webUrl: "https://github.com/Mzeey-Empire/mcode",
    },
    "git.workingTreeFiles": [],
  });

  await openOverview(page);

  await expect(page.getByTestId("workspace-menu-open-pr")).toContainText("View PR #790");
  await expect(page.getByRole("button", { name: "Open PR menu" })).toBeVisible();

  await page.locator("[data-testid='thread-overview-pr']").screenshot({
    path: "e2e/screenshots/demo/pr-row-view-open.png",
  });
});
