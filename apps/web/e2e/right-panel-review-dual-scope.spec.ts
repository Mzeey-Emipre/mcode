import { test, expect, type Page } from "@playwright/test";
import type { GitCommit, Thread, TurnSnapshot } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
  type WsController,
} from "./helpers/e2e-helpers";

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
  files_changed: ["src/a.ts", "src/beta.ts"],
  worktree_path: null,
  created_at: now,
};

const SETTINGS = {
  ...getDefaultSettings(),
  diffSummary: { enabled: true },
};

let branchFilesCalls: unknown[] = [];
let branchDiffCalls: unknown[] = [];
let branchDiffVersion = 0;
let snapshotListCalls = 0;
let snapshotsForList: TurnSnapshot[] = [];
let commitsForLog: GitCommit[] = [];
let wsController: WsController;

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

test.describe("Review tab: dual-scope view selection", () => {
  test.beforeEach(async ({ page }) => {
    branchFilesCalls = [];
    branchDiffCalls = [];
    branchDiffVersion = 0;
    snapshotListCalls = 0;
    snapshotsForList = [SNAPSHOT];
    commitsForLog = [];
    wsController = await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "settings.get": SETTINGS,
      "snapshot.listByThread": () => {
        snapshotListCalls += 1;
        return snapshotsForList;
      },
      "snapshot.getDiff": (params) => {
        const filePath = (params as { filePath?: string }).filePath ?? "src/a.ts";
        return `@@ -1 +1 @@\n-old ${filePath}\n+new ${filePath}\n`;
      },
      "snapshot.getCumulativeDiff": (params) => {
        const filePath = (params as { filePath?: string }).filePath ?? "src/a.ts";
        return `@@ -1 +1 @@\n-old ${filePath}\n+new ${filePath}\n`;
      },
      "diffSummary.get": null,
      "git.workingTreeFiles": (params) =>
        (params as { staged?: boolean })?.staged ? ["src/staged.ts"] : ["src/unstaged.ts"],
      "git.workingTreeDiff": "",
      "git.branchFiles": (params) => {
        branchFilesCalls.push(params);
        return ["src/branch.ts"];
      },
      "git.branchDiff": (params) => {
        branchDiffCalls.push(params);
        const base = (params as { base?: string }).base ?? "unknown";
        const target = (params as { target?: string }).target ?? "unknown";
        const suffix = branchDiffVersion === 0 ? "line" : `reload ${branchDiffVersion}`;
        return `@@ -1 +1 @@\n-old ${base} to ${target} ${suffix}\n+new ${base} to ${target} ${suffix}\n`;
      },
      "git.branchComparison": {
        base: "origin/main",
        target: "feat/x",
        refs: [
          { name: "main", shortSha: "aaaaaaa", type: "local", isCurrent: false },
          { name: "feat/x", shortSha: "bbbbbbb", type: "local", isCurrent: true },
          { name: "origin/main", shortSha: "aaaaaaa", type: "remote", isCurrent: false },
        ],
        isUnborn: false,
        isComparisonAvailable: true,
      },
      "git.log": () => commitsForLog,
      "git.commitFiles": [],
    });
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
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

    // Open the dropdown. The items render in a portal, not inside the trigger.
    await switcher.click();
    await expect(page.getByTestId("review-view-unstaged")).toBeVisible();
    // The active view exposes its selected state to assistive tech.
    await expect(page.getByTestId("review-view-unstaged")).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("review-view-staged")).toBeVisible();
    await expect(page.getByTestId("review-view-commit")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(page.getByTestId("review-view-branch")).toBeVisible();

    // The thread-scoped turn views must not appear with no thread.
    await expect(page.getByTestId("review-view-last-turn")).toHaveCount(0);
    await expect(page.getByTestId("review-view-cumulative")).toHaveCount(0);

    // Selecting Staged swaps the view: the dropdown relabels and the menu closes.
    await page.getByTestId("review-view-staged").click();
    await expect(switcher).toContainText("Staged");
    await expect(page.getByTestId("review-view-staged")).toHaveCount(0);
    // Staged is a fixed-operand view, so there is no operand slot.
    await expect(page.getByTestId("review-operand-slot")).toHaveCount(0);
  });

  test("threadless: Commit enables after the menu refreshes commit availability", async ({
    page,
  }) => {
    await openThreadlessReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    await expect(switcher).toContainText("Unstaged");

    await switcher.click();
    await expect(page.getByTestId("review-view-commit")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("review-view-commit")).toHaveCount(0);

    commitsForLog = [
      {
        sha: "dddddddd4",
        shortSha: "ddddddd",
        message: "feat: terminal commit",
        author: "Dev",
        date: now,
        filesChanged: 1,
      },
    ];

    await switcher.click();
    await expect(page.getByTestId("review-view-commit")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
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
    // All thread and git entries are listed in a thread.
    await expect(page.getByTestId("review-view-last-turn")).toBeVisible();
    await expect(page.getByTestId("review-view-cumulative")).toBeVisible();
    await expect(page.getByTestId("review-view-unstaged")).toBeVisible();
    await expect(page.getByTestId("review-view-staged")).toBeVisible();
    await expect(page.getByTestId("review-view-commit")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(page.getByTestId("review-view-branch")).toBeVisible();
    await expect(page.getByTestId("review-view-summary")).toHaveCount(0);

    // Selecting Branch swaps the diff without leaving the thread, and reveals the
    // contextual operand slot (Branch carries a picked operand).
    await page.getByTestId("review-view-branch").click();
    await expect(switcher).toContainText("Branch");
    await expect(page.getByTestId("review-operand-slot")).toHaveAttribute("data-operand", "branch");
  });

  test("thread: Cumulative owns Summary and jump-to-file autocomplete", async ({ page }) => {
    await openThreadReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    await expect(switcher).toBeVisible({ timeout: 5_000 });
    await switcher.click();
    await page.getByTestId("review-view-cumulative").click();
    await expect(switcher).toContainText("All turns");
    await expect(page.getByTestId("cumulative-summary-toggle")).toBeVisible();

    await expect(page.getByTestId("review-file-filter")).toHaveCount(0);
    await page.getByTestId("review-file-jump-trigger").click();
    const filter = page.getByTestId("review-file-filter");
    await filter.fill("beta");
    await expect(page.locator('[data-review-file="src/beta.ts"]')).toBeVisible();
    await expect(page.locator('[data-review-file="src/a.ts"]')).toBeVisible();
    await page.getByTestId("review-file-jump-item-src/beta.ts").click();
    await expect(page.getByTestId("review-file-filter")).toHaveCount(0);
    await expect(page.locator('[data-review-file="src/beta.ts"]')).toHaveAttribute(
      "data-jump-highlight",
      "true",
    );
    await expect(page.getByText("new src/beta.ts")).toBeVisible();

    await page.getByTestId("cumulative-summary-toggle").click();
    await expect(page.getByText("no summary")).toBeVisible();
    await expect(page.getByTestId("review-file-filter")).toHaveCount(0);
  });

  test("thread: Cumulative offers refresh from turn.persisted while open", async ({ page }) => {
    await openThreadReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    await switcher.click();
    await page.getByTestId("review-view-cumulative").click();
    await expect(switcher).toContainText("All turns");
    await expect(page.locator('[data-review-file="src/new.ts"]')).toHaveCount(0);

    snapshotsForList = [
      SNAPSHOT,
      {
        id: "s2",
        message_id: "m-s2",
        thread_id: THREAD.id,
        ref_before: "bbbbbbb",
        ref_after: "ccccccc",
        files_changed: ["src/new.ts"],
        worktree_path: null,
        created_at: now,
      },
    ];

    const listCallsBeforePush = snapshotListCalls;
    await wsController.sendPush("turn.persisted", {
      threadId: THREAD.id,
      messageId: "m-s2",
      toolCallCount: 1,
      filesChanged: ["src/new.ts"],
    });

    await expect(page.getByTestId("cumulative-view-refresh")).toBeVisible();
    await expect(page.locator('[data-review-file="src/new.ts"]')).toHaveCount(0);
    expect(snapshotListCalls).toBe(listCallsBeforePush);
    await page.getByTestId("cumulative-view-refresh").click();
    await expect(page.locator('[data-review-file="src/new.ts"]')).toBeVisible();
    await expect(page.getByTestId("cumulative-view-refresh")).toHaveCount(0);
    expect(snapshotListCalls).toBeGreaterThan(listCallsBeforePush);
  });

  test("branch: the operand slot fixes the current branch and picks only the comparison ref", async ({
    page,
  }) => {
    await openThreadReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    await expect(switcher).toBeVisible({ timeout: 5_000 });
    await switcher.click();
    await page.getByTestId("review-view-branch").click();

    // The operand slot fixes the current branch on the left and only the right
    // comparison ref is selectable. The server default `origin/main...feat/x` is
    // adapted to the user-facing `feat/x -> origin/main` shape.
    const picker = page.getByTestId("branch-ref-picker");
    await expect(picker).toBeVisible();
    await expect(page.getByTestId("branch-base-picker")).toHaveCount(0);
    await expect(page.getByTestId("branch-current-ref")).toContainText("feat/x");
    const targetPicker = page.getByTestId("branch-target-picker");
    await expect(page.getByTestId("branch-range-arrow")).toBeVisible();
    await expect(targetPicker).toContainText("origin/main");
    // Branch diffs open automatically after the comparison resolves; no file row
    // click is needed to see the inline diff.
    await expect(page.getByText("new origin/main to feat/x line")).toBeVisible();
    await expect
      .poll(() =>
        branchFilesCalls.some(
          (params) =>
            (params as { base?: string; target?: string }).base === "origin/main" &&
            (params as { base?: string; target?: string }).target === "feat/x",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        branchDiffCalls.some(
          (params) =>
            (params as { base?: string; target?: string; filePath?: string }).base ===
              "origin/main" &&
            (params as { base?: string; target?: string; filePath?: string }).target ===
              "feat/x" &&
            (params as { base?: string; target?: string; filePath?: string }).filePath ===
              "src/branch.ts",
        ),
      )
      .toBe(true);

    // Picking a new comparison ref updates only the right side.
    await targetPicker.click();
    await page.getByTestId("branch-ref-target-main").click();
    await expect(page.getByTestId("branch-current-ref")).toContainText("feat/x");
    await expect(targetPicker).toContainText("main");
    await expect
      .poll(() =>
        branchDiffCalls.some(
          (params) =>
            (params as { base?: string; target?: string; filePath?: string }).base ===
              "main" &&
            (params as { base?: string; target?: string; filePath?: string }).target ===
              "feat/x" &&
            (params as { base?: string; target?: string; filePath?: string }).filePath ===
              "src/branch.ts",
        ),
      )
      .toBe(true);
    await expect(page.getByText("new main to feat/x line")).toBeVisible();
  });

  test("branch: file-change pushes refetch the visible comparison", async ({ page }) => {
    await openThreadReview(page);

    const switcher = page.getByTestId("review-view-switcher");
    await expect(switcher).toBeVisible({ timeout: 5_000 });
    await switcher.click();
    await page.getByTestId("review-view-branch").click();

    await expect(page.getByText("new origin/main to feat/x line")).toBeVisible();
    branchDiffVersion = 1;

    await wsController.sendPush("files.changed", {
      workspaceId: WORKSPACE.id,
      threadId: THREAD.id,
    });

    await expect(page.getByText("new origin/main to feat/x reload 1")).toBeVisible();
    await expect
      .poll(() =>
        branchDiffCalls.filter(
          (params) =>
            (params as { base?: string; target?: string; filePath?: string }).base ===
              "origin/main" &&
            (params as { base?: string; target?: string; filePath?: string }).target ===
              "feat/x" &&
            (params as { base?: string; target?: string; filePath?: string }).filePath ===
              "src/branch.ts",
        ).length,
      )
      .toBeGreaterThan(1);
  });
});
