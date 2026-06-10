import { test, expect, type Page } from "@playwright/test";
import type { Thread, TurnSnapshot } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

/**
 * Covers the Review tab's dual-scope view selection (issue #614): with no thread
 * the toolbar offers the git working-tree views (Unstaged/Staged/Commit/Branch);
 * with a thread it offers the turn views (Last turn / Cumulative). The two view
 * sets never overlap, and each view renders a single diff.
 */

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-review-dual",
  name: "Review Dual Scope",
  path: "/tmp/review-dual",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const THREAD: Thread = {
  id: "thread-review-dual",
  workspace_id: WORKSPACE.id,
  title: "Review Dual Thread",
  status: "paused",
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
};

const SNAPSHOT: TurnSnapshot = {
  id: "s1",
  message_id: "m-s1",
  thread_id: THREAD.id,
  ref_before: "aaaaaaa",
  ref_after: "bbbbbbb",
  files_changed: ["src/a.ts"],
  worktree_path: null,
  created_at: now,
};

/** Opens the Review tab with no active thread (threadless workspace scope). */
async function openThreadlessReview(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, wid }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) =>
        (s as { getState: () => Record<string, unknown> }).getState();
      const wsStore = stores.find(
        (s) => "activeThreadId" in getState(s) && "pendingNewThread" in getState(s),
      );
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [],
        activeThreadId: null,
        pendingNewThread: true,
      });
      const diffStore = stores.find((s) => "showRightPanel" in getState(s));
      const api = (
        diffStore as {
          getState: () => {
            showRightPanel: (id: string, threadId?: string) => void;
            setRightPanelTab: (id: string, t: string) => void;
          };
        }
      ).getState();
      api.showRightPanel(wid);
      api.setRightPanelTab(wid, "changes");
    },
    { workspace: WORKSPACE, wid: WORKSPACE.id },
  );
}

/** Opens the Review tab on an active thread with one turn snapshot. */
async function openThreadReview(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, wid, tid, snapshot }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) =>
        (s as { getState: () => Record<string, unknown> }).getState();
      const wsStore = stores.find(
        (s) => "activeThreadId" in getState(s) && "threads" in getState(s),
      );
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: tid,
      });
      const diffStore = stores.find(
        (s) => "showRightPanel" in getState(s) && "setSnapshots" in getState(s),
      );
      const api = (
        diffStore as {
          getState: () => {
            setSnapshots: (id: string, snaps: unknown) => void;
            showRightPanel: (id: string, threadId?: string) => void;
            setRightPanelTab: (id: string, t: string) => void;
          };
        }
      ).getState();
      api.setSnapshots(tid, [snapshot]);
      api.showRightPanel(wid, tid);
      api.setRightPanelTab(wid, "changes");
    },
    { workspace: WORKSPACE, thread: THREAD, wid: WORKSPACE.id, tid: THREAD.id, snapshot: SNAPSHOT },
  );
}

test.describe("Review tab — dual-scope view selection", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "settings.get": getDefaultSettings(),
      "snapshot.listByThread": [SNAPSHOT],
      "snapshot.getDiff": "",
      "git.workingTreeFiles": (params) =>
        (params as { staged?: boolean })?.staged ? ["src/staged.ts"] : ["src/unstaged.ts"],
      "git.workingTreeDiff": "",
      "git.branchFiles": ["src/branch.ts"],
      "git.branchDiff": "",
      "git.log": [],
      "git.commitFiles": [],
    });
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete ===
        true,
      { timeout: 30_000 },
    );
  });

  test("threadless: offers the git working-tree views, not the turn views", async ({ page }) => {
    await openThreadlessReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    await expect(switcher.getByTestId("review-view-unstaged")).toBeVisible({ timeout: 5_000 });
    await expect(switcher.getByTestId("review-view-staged")).toBeVisible();
    await expect(switcher.getByTestId("review-view-commit")).toBeVisible();
    await expect(switcher.getByTestId("review-view-branch")).toBeVisible();

    // The thread-scoped turn views must not appear with no thread.
    await expect(switcher.getByTestId("review-view-last-turn")).toHaveCount(0);
    await expect(switcher.getByTestId("review-view-cumulative")).toHaveCount(0);

    // Switching to Staged activates it (the segmented control marks it pressed).
    await switcher.getByTestId("review-view-staged").click();
    await expect(switcher.getByTestId("review-view-staged")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("thread: adds the turn views on top of the git working-tree views", async ({ page }) => {
    await openThreadReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    // Last turn is the default glance; Cumulative is the thread's net diff.
    await expect(switcher.getByTestId("review-view-last-turn")).toBeVisible({ timeout: 5_000 });
    await expect(switcher.getByTestId("review-view-last-turn")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(switcher.getByTestId("review-view-cumulative")).toBeVisible();

    // The git working-tree views stay available in a thread (additive, dual-scope).
    await expect(switcher.getByTestId("review-view-unstaged")).toBeVisible();
    await expect(switcher.getByTestId("review-view-staged")).toBeVisible();
    await expect(switcher.getByTestId("review-view-commit")).toBeVisible();
    await expect(switcher.getByTestId("review-view-branch")).toBeVisible();

    // Switching to a git view activates it without leaving the thread.
    await switcher.getByTestId("review-view-branch").click();
    await expect(switcher.getByTestId("review-view-branch")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
