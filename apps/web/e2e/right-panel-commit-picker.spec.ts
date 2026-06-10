import { test, expect, type Page } from "@playwright/test";
import type { GitCommit } from "@mcode/contracts";
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

/** Three commits since base, newest first (the order `git log` returns). */
const COMMITS: GitCommit[] = [
  { sha: "aaaaaaaa1", shortSha: "aaaaaaa", message: "feat: add the widget", author: "Dev", date: now, filesChanged: 1 },
  { sha: "bbbbbbbb2", shortSha: "bbbbbbb", message: "fix: the broken seam", author: "Dev", date: now, filesChanged: 1 },
  { sha: "cccccccc3", shortSha: "ccccccc", message: "chore: tidy imports", author: "Dev", date: now, filesChanged: 1 },
];

/** Each commit resolves to its own single file, so the rendered diff is identifiable. */
const FILES_BY_SHA: Record<string, string[]> = {
  aaaaaaaa1: ["src/widget.ts"],
  bbbbbbbb2: ["src/seam.ts"],
  cccccccc3: ["src/imports.ts"],
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

test.describe("Review tab — Commit picker", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [],
      "settings.get": getDefaultSettings(),
      "git.currentBranch": "feature/widget",
      "git.log": COMMITS,
      "git.commitFiles": (params) => FILES_BY_SHA[(params as { sha: string }).sha] ?? [],
      "git.commitDiff": "",
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
  });

  test("searches by short SHA", async ({ page }) => {
    await openCommitView(page);

    const trigger = page.getByTestId("commit-picker-trigger");
    await trigger.click();
    await page.getByPlaceholder("Search commits…").fill("ccccccc");
    await expect(page.getByTestId("commit-picker-item-ccccccc")).toBeVisible();
    await expect(page.getByTestId("commit-picker-item-aaaaaaa")).toHaveCount(0);
  });
});
