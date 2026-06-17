import { test, expect, type Page } from "@playwright/test";
import type { GitCommit, Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

/**
 * Covers the Review tab's Commit picker (issue #642): the Commit view's operand
 * slot holds a searchable list of the branch's commits since base. The default
 * selection is the latest commit; searching filters by message and short SHA;
 * selecting a commit renders exactly that one commit's diff.
 */

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-commit-picker",
  name: "Commit Picker",
  path: "/tmp/commit-picker",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const THREAD: Thread = {
  id: "thread-commit-picker",
  workspace_id: WORKSPACE.id,
  title: "Commit Picker Thread",
  status: "paused",
  mode: "worktree",
  worktree_path: "/tmp/commit-picker-worktree",
  branch: "feature/thread-head",
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

/** Three commits since base, newest first (the order `git log` returns). */
const COMMITS: GitCommit[] = [
  { sha: "aaaaaaaa1", shortSha: "aaaaaaa", message: "feat: add the widget", author: "Dev", date: now, filesChanged: 1 },
  { sha: "bbbbbbbb2", shortSha: "bbbbbbb", message: "fix: the broken seam", author: "Dev", date: now, filesChanged: 1 },
  { sha: "cccccccc3", shortSha: "ccccccc", message: "chore: tidy imports", author: "Dev", date: now, filesChanged: 1 },
];

const FIRST_PAGE_COMMITS: GitCommit[] = [
  ...COMMITS,
  ...Array.from({ length: 97 }, (_, i) => ({
    sha: `f${String(i).padStart(7, "0")}`,
    shortSha: `f${String(i).padStart(6, "0")}`,
    message: `test: filler commit ${i}`,
    author: "Dev",
    date: now,
    filesChanged: 0,
  })),
];

const OLDER_COMMITS: GitCommit[] = [
  { sha: "999999999", shortSha: "9999999", message: "fix: older regression", author: "Dev", date: now, filesChanged: 1 },
];

let firstPageCommits: GitCommit[] = FIRST_PAGE_COMMITS;

/** Thread-scoped commits come from the thread worktree HEAD, not the workspace root. */
const THREAD_COMMITS: GitCommit[] = [
  { sha: "dddddddd4", shortSha: "ddddddd", message: "feat: thread worktree head", author: "Dev", date: now, filesChanged: 1 },
  { sha: "eeeeeeee5", shortSha: "eeeeeee", message: "fix: thread fallback path", author: "Dev", date: now, filesChanged: 1 },
];

/** Each commit resolves to its own single file, so the rendered diff is identifiable. */
const FILES_BY_SHA: Record<string, string[]> = {
  aaaaaaaa1: ["src/widget.ts"],
  bbbbbbbb2: ["src/seam.ts"],
  cccccccc3: ["src/imports.ts"],
  "999999999": ["src/older.ts"],
  dddddddd4: ["src/thread.ts"],
  eeeeeeee5: ["src/thread-fallback.ts"],
};

const DIFF_BY_SHA_AND_FILE: Record<string, string> = {
  "aaaaaaaa1:src/widget.ts": [
    "diff --git a/src/widget.ts b/src/widget.ts",
    "--- a/src/widget.ts",
    "+++ b/src/widget.ts",
    "@@ -1 +1 @@",
    "-old widget",
    "+latest widget diff body",
  ].join("\n"),
  "bbbbbbbb2:src/seam.ts": [
    "diff --git a/src/seam.ts b/src/seam.ts",
    "--- a/src/seam.ts",
    "+++ b/src/seam.ts",
    "@@ -1 +1 @@",
    "-old seam",
    "+selected commit diff body",
  ].join("\n"),
  "dddddddd4:src/thread.ts": [
    "diff --git a/src/thread.ts b/src/thread.ts",
    "--- a/src/thread.ts",
    "+++ b/src/thread.ts",
    "@@ -1 +1 @@",
    "-old thread",
    "+thread worktree head diff body",
  ].join("\n"),
  "999999999:src/older.ts": [
    "diff --git a/src/older.ts b/src/older.ts",
    "--- a/src/older.ts",
    "+++ b/src/older.ts",
    "@@ -1 +1 @@",
    "-old path",
    "+older searched diff body",
  ].join("\n"),
};

/** Opens the Review tab threadless and selects the Commit view. */
async function openCommitView(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, wid }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
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
            setViewMode: (m: string) => void;
          };
        }
      ).getState();
      api.showRightPanel(wid);
      api.setRightPanelTab(wid, "changes");
      api.setViewMode("commit");
    },
    { workspace: WORKSPACE, wid: WORKSPACE.id },
  );
}

/** Opens the Review tab on an active thread and selects the Commit view. */
async function openThreadCommitView(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, wid, tid }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
      const wsStore = stores.find(
        (s) => "activeThreadId" in getState(s) && "threads" in getState(s),
      );
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: tid,
      });
      const diffStore = stores.find((s) => "showRightPanel" in getState(s));
      const api = (
        diffStore as {
          getState: () => {
            showRightPanel: (id: string, threadId?: string) => void;
            setRightPanelTab: (id: string, t: string) => void;
            setReviewViewForThread: (threadId: string, m: string) => void;
          };
        }
      ).getState();
      api.showRightPanel(wid, tid);
      api.setRightPanelTab(wid, "changes");
      // In a thread, selecting a view is a sticky per-thread pick (ADR-0011);
      // a bare setViewMode would be reverted by the live default effect.
      api.setReviewViewForThread(tid, "commit");
    },
    { workspace: WORKSPACE, thread: THREAD, wid: WORKSPACE.id, tid: THREAD.id },
  );
}

test.describe("Review tab — Commit picker", () => {
  let gitLogCalls: unknown[];

  test.beforeEach(async ({ page }) => {
    gitLogCalls = [];
    firstPageCommits = FIRST_PAGE_COMMITS;
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "settings.get": getDefaultSettings(),
      "git.currentBranch": "feature/widget",
      "git.log": (params) => {
        gitLogCalls.push(params);
        const p = params as { threadId?: string; skip?: number } | undefined;
        if (p?.threadId === THREAD.id) return THREAD_COMMITS;
        return p?.skip ? OLDER_COMMITS : firstPageCommits;
      },
      "git.commitFiles": (params) => FILES_BY_SHA[(params as { sha: string }).sha] ?? [],
      "git.commitDiff": (params) => {
        const { sha, filePath } = params as { sha: string; filePath: string };
        return DIFF_BY_SHA_AND_FILE[`${sha}:${filePath}`] ?? "";
      },
      "git.inlineDiff": "",
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

  test("defaults to the latest commit and renders its diff", async ({ page }) => {
    await openCommitView(page);

    const slot = page.getByTestId("review-operand-slot");
    await expect(slot).toHaveAttribute("data-operand", "commit", { timeout: 5_000 });

    // The picker trigger labels itself with the latest commit (catalog order [0]).
    const trigger = page.getByTestId("commit-picker-trigger");
    await expect(trigger).toContainText("aaaaaaa");
    await expect(trigger).toContainText("add the widget");

    // The default selection's diff renders — the latest commit's single file.
    await expect(page.getByText("widget.ts")).toBeVisible();
    await expect(page.getByText("latest widget diff body")).toBeVisible();
  });

  test("searches by message, selects, and renders exactly that commit's diff", async ({ page }) => {
    await openCommitView(page);

    const trigger = page.getByTestId("commit-picker-trigger");
    await expect(trigger).toBeVisible({ timeout: 5_000 });
    await trigger.click();

    // Search narrows the list to the matching commit; the others drop out.
    await page.getByPlaceholder("Search commits…").fill("broken seam");
    await expect(page.getByTestId("commit-picker-item-bbbbbbb")).toBeVisible();
    await expect(page.getByTestId("commit-picker-item-aaaaaaa")).toHaveCount(0);

    // Selecting swaps the rendered diff to exactly that commit's file.
    await page.getByTestId("commit-picker-item-bbbbbbb").click();
    await expect(trigger).toContainText("bbbbbbb");
    await expect(page.getByText("seam.ts")).toBeVisible();
    await expect(page.getByText("widget.ts")).toHaveCount(0);
    await expect(page.getByText("selected commit diff body")).toBeVisible();
  });

  test("searches by short SHA", async ({ page }) => {
    await openCommitView(page);

    const trigger = page.getByTestId("commit-picker-trigger");
    await trigger.click();
    await page.getByPlaceholder("Search commits…").fill("ccccccc");
    await expect(page.getByTestId("commit-picker-item-ccccccc")).toBeVisible();
    await expect(page.getByTestId("commit-picker-item-aaaaaaa")).toHaveCount(0);
  });

  test("refreshes the commit list when the picker opens", async ({ page }) => {
    await openCommitView(page);

    const trigger = page.getByTestId("commit-picker-trigger");
    await expect(trigger).toContainText("aaaaaaa", { timeout: 5_000 });
    await trigger.click();
    const search = page.getByPlaceholder("Search commits…");
    await search.fill("broken seam");
    await expect(page.getByTestId("commit-picker-item-bbbbbbb")).toBeVisible();

    firstPageCommits = [
      {
        sha: "dddddddd4",
        shortSha: "ddddddd",
        message: "feat: terminal commit",
        author: "Dev",
        date: now,
        filesChanged: 1,
      },
      ...FIRST_PAGE_COMMITS,
    ];

    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(page.getByTestId("commit-picker-item-ddddddd")).toHaveCount(0);
    await expect(page.getByTestId("commit-picker-item-bbbbbbb")).toBeVisible();

    await search.fill("");
    await expect(page.getByTestId("commit-picker-item-ddddddd")).toBeVisible();
  });

  test("searches older commits on demand", async ({ page }) => {
    await openCommitView(page);

    const trigger = page.getByTestId("commit-picker-trigger");
    await trigger.click();
    await page.getByPlaceholder("Search commits…").fill("older regression");
    await page.getByRole("button", { name: "Search older commits" }).click();

    await expect(page.getByTestId("commit-picker-item-9999999")).toBeVisible();
    await page.getByTestId("commit-picker-item-9999999").click();
    await expect(trigger).toContainText("9999999");
    await expect(page.getByText("older.ts")).toBeVisible();

    expect(gitLogCalls).toContainEqual(
      expect.objectContaining({
        workspaceId: WORKSPACE.id,
        branch: "feature/widget",
        limit: 100,
        skip: 100,
        includeStats: false,
      }),
    );
  });

  test("thread: uses the thread worktree commit list and renders its HEAD diff", async ({ page }) => {
    await openThreadCommitView(page);

    const trigger = page.getByTestId("commit-picker-trigger");
    await expect(trigger).toContainText("ddddddd", { timeout: 5_000 });
    await expect(trigger).toContainText("thread worktree head");

    expect(gitLogCalls).toContainEqual(
      expect.objectContaining({
        workspaceId: WORKSPACE.id,
        branch: THREAD.branch,
        limit: 100,
        threadId: THREAD.id,
      }),
    );

    await expect(page.getByText("thread.ts")).toBeVisible();
    await expect(page.getByText("thread worktree head diff body")).toBeVisible();
  });
});
