import { test, expect, type Page } from "@playwright/test";
import type { Thread, TurnSnapshot } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

/**
 * Covers the Review tab's dual-scope view selection (issues #614, #640): the
 * toolbar's view selection is a dropdown labelled with the active view. With no
 * thread it offers the git working-tree views (Unstaged/Staged/Commit/Branch);
 * with a thread it adds the turn views (Last turn / Cumulative) on top. Opening
 * the dropdown and selecting a view swaps the single rendered diff. A contextual
 * operand slot sits beside the dropdown for the comparison views (Branch,
 * Commit) and stays absent for fixed-operand views.
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

  test("threadless: dropdown offers the git working-tree views, not the turn views", async ({
    page,
  }) => {
    await openThreadlessReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    // The dropdown is labelled with the default threadless view (Unstaged).
    await expect(switcher).toBeVisible({ timeout: 5_000 });
    await expect(switcher).toContainText("Unstaged");

    // Open the dropdown — the items render in a portal, not inside the trigger.
    await switcher.click();
    await expect(page.getByTestId("review-view-unstaged")).toBeVisible();
    // The active view exposes its selected state to assistive tech.
    await expect(page.getByTestId("review-view-unstaged")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("review-view-staged")).toBeVisible();
    await expect(page.getByTestId("review-view-commit")).toBeVisible();
    await expect(page.getByTestId("review-view-branch")).toBeVisible();

    // The thread-scoped turn views must not appear with no thread.
    await expect(page.getByTestId("review-view-last-turn")).toHaveCount(0);
    await expect(page.getByTestId("review-view-cumulative")).toHaveCount(0);

    // Selecting Staged swaps the view: the dropdown relabels and the menu closes.
    await page.getByTestId("review-view-staged").click();
    await expect(switcher).toContainText("Staged");
    await expect(page.getByTestId("review-view-staged")).toHaveCount(0);
    // Staged is a fixed-operand view — no operand slot.
    await expect(page.getByTestId("review-operand-slot")).toHaveCount(0);
  });

  test("thread: dropdown adds the turn views on top of the git working-tree views", async ({
    page,
  }) => {
    await openThreadReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    // Last turn is the default glance in a thread.
    await expect(switcher).toBeVisible({ timeout: 5_000 });
    await expect(switcher).toContainText("Last turn");

    await switcher.click();
    // All seven entries are reachable in a thread (additive, dual-scope).
    await expect(page.getByTestId("review-view-last-turn")).toBeVisible();
    await expect(page.getByTestId("review-view-cumulative")).toBeVisible();
    await expect(page.getByTestId("review-view-unstaged")).toBeVisible();
    await expect(page.getByTestId("review-view-staged")).toBeVisible();
    await expect(page.getByTestId("review-view-commit")).toBeVisible();
    await expect(page.getByTestId("review-view-branch")).toBeVisible();

    // Selecting Branch swaps the diff without leaving the thread, and reveals the
    // contextual operand slot (Branch carries a picked operand).
    await page.getByTestId("review-view-branch").click();
    await expect(switcher).toContainText("Branch");
    await expect(page.getByTestId("review-operand-slot")).toHaveAttribute("data-operand", "branch");
  });
});
