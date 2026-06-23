import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores, seedActiveThread } from "./helpers/e2e-helpers";

const now = new Date().toISOString();
const workspace = {
  id: "ws-branchless-pr",
  name: "Branchless PR Workspace",
  path: "/tmp/branchless-pr",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const thread: Thread = {
  id: "thread-branchless-pr",
  workspace_id: workspace.id,
  title: "Branchless PR Thread",
  status: "paused",
  mode: "worktree",
  worktree_path: "/tmp/branchless-pr/.worktrees/thread-branchless-pr",
  branch: "main",
  checkout_state: "branchless",
  base_branch: "main",
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
  context_window_mode: null,
  thinking: null,
  codex_fast_mode: null,
  copilot_agent: null,
  default_open_in_app: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

async function ensureOverviewOpen(page: Page): Promise<void> {
  const overview = page.getByTestId("thread-overview-body");
  if (!(await overview.isVisible().catch(() => false))) {
    await page.getByTestId("header-workspace-menu").click();
  }
  await expect(overview).toBeVisible();
}

async function getWorkspaceThread(page: Page): Promise<Partial<Thread> | null> {
  return page.evaluate((threadId) => {
    type StoreHandle = { getState: () => Record<string, unknown> };
    const stores = (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const store = stores.find((candidate) => {
      const state = candidate.getState();
      return "threads" in state && "activeThreadId" in state;
    });
    const threads = (store?.getState().threads ?? []) as Partial<Thread>[];
    return threads.find((candidate) => candidate.id === threadId) ?? null;
  }, thread.id);
}

test.describe("Branchless Create PR", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("creates a named branch before opening the Create PR dialog", async ({ page }) => {
    const createBranchCalls: unknown[] = [];
    const branchPrCalls: unknown[] = [];
    const gitLogCalls: unknown[] = [];

    await interceptZustandStores(page);
    await mockWebSocketServer(page, {
      "workspace.list": [workspace],
      "workspace.enrich": { items: [] },
      "thread.list": [thread],
      "github.branchPr": (params) => {
        branchPrCalls.push(params);
        return null;
      },
      "git.log": (params) => {
        gitLogCalls.push(params);
        return [];
      },
      "git.createBranch": (params) => {
        createBranchCalls.push(params);
        return { branch: "feat/issue-801" };
      },
      "github.generatePrDraft": () => ({
        title: "feat: branchless pull request flow",
        body: "Creates a named branch before opening the PR dialog.",
      }),
      "git.listBranches": [
        { name: "feat/issue-801", type: "local", isCurrent: true, shortSha: "abc1234" },
        { name: "main", type: "local", isCurrent: false, shortSha: "def5678" },
        { name: "release", type: "local", isCurrent: false, shortSha: "fed1234" },
      ],
      "git.getRemoteUrl": {
        label: "Mzeey-Empire/mcode",
        webUrl: "https://github.com/Mzeey-Empire/mcode",
      },
      "snapshot.listByThread": [],
      "git.workingTreeFiles": [],
    });

    await page.goto("/");
    await seedActiveThread(page, workspace, thread, []);
    await page.waitForSelector("[data-testid='chat-header-title']");

    await ensureOverviewOpen(page);
    await expect(page.getByTestId("workspace-menu-create-pr")).toBeVisible();
    expect(branchPrCalls).toEqual([]);
    expect(gitLogCalls).toEqual([]);

    await page.getByTestId("workspace-menu-create-pr").click();
    await expect(page.getByRole("heading", { name: "Name branch for PR" })).toBeVisible();
    await page.getByLabel("Branch name").fill("feat/issue-801");
    await page.getByRole("button", { name: "Create branch and continue" }).click();

    await expect(page.getByRole("heading", { name: "Create pull request" })).toBeVisible();
    const prDialog = page.getByLabel("Create pull request");
    await expect(prDialog.getByText("feat/issue-801")).toBeVisible();
    await expect(prDialog.getByRole("button", { name: "Base branch" })).toContainText("main");

    expect(createBranchCalls).toEqual([
      {
        workspaceId: workspace.id,
        name: "feat/issue-801",
        threadId: thread.id,
      },
    ]);
    await expect.poll(() => getWorkspaceThread(page)).toMatchObject({
      branch: "feat/issue-801",
      checkout_state: "named",
      base_branch: null,
    });
  });
});
