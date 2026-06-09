import { test, expect, type Page } from "@playwright/test";
import type { Thread, TurnSnapshot } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-tab-status",
  name: "Tab Status",
  path: "/tmp/tab-status",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

function makeThread(id: string, title: string): Thread {
  return {
    id,
    workspace_id: WORKSPACE.id,
    title,
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
}

const THREAD = makeThread("thread-tab-status", "Tab Status Thread");

/** Two completed of five parent tasks → Scope reads "2/5". */
const TASKS = [
  { id: "t1", content: "Map data sources", status: "completed", group: "Tasks" },
  { id: "t2", content: "Build tab status", status: "completed", group: "Tasks" },
  { id: "t3", content: "Wire freshness", status: "in_progress", group: "Tasks" },
  { id: "t4", content: "Fix drag handle", status: "pending", group: "Tasks" },
  { id: "t5", content: "Verify in browser", status: "pending", group: "Tasks" },
] as const;

function makeSnapshot(id: string, files: string[]): TurnSnapshot {
  return {
    id,
    message_id: `m-${id}`,
    thread_id: THREAD.id,
    ref_before: "aaaaaaa",
    ref_after: "bbbbbbb",
    files_changed: files,
    worktree_path: null,
    created_at: now,
  };
}

/** Two snapshots covering four distinct files → Changes reads "4". */
const SNAPSHOTS = [
  makeSnapshot("s1", ["RightPanel.tsx", "diffStore.ts"]),
  makeSnapshot("s2", ["index.css", "RightPanel.tsx", "App.tsx"]),
];

/**
 * Seeds workspace, thread, tasks, and snapshots into the live stores, then
 * opens the right panel on the given tab. Mirrors the store-poking pattern used
 * by right-panel-terminal-resize.spec.ts.
 */
async function seedPanel(page: Page, tab: "tasks" | "changes"): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, tid, wid, snapshots, tab }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) =>
        (s as { getState: () => Record<string, unknown> }).getState();

      const wsStore = stores.find((s) => "activeThreadId" in getState(s) && "threads" in getState(s));
      if (wsStore) {
        (wsStore as { setState: (p: unknown) => void }).setState({
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          threads: [thread],
          activeThreadId: tid,
        });
      }

      const diffStore = stores.find(
        (s) => "showRightPanel" in getState(s) && "setSnapshots" in getState(s),
      );
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              setSnapshots: (id: string, snaps: unknown) => void;
              showRightPanel: (id: string, threadId?: string) => void;
              setRightPanelTab: (id: string, t: string) => void;
            };
          }
        ).getState();
        api.setSnapshots(tid, snapshots);
        api.showRightPanel(wid, tid);
        // Open both rail tabs so switching can be exercised; the requested tab
        // is activated last.
        api.setRightPanelTab(wid, "tasks");
        api.setRightPanelTab(wid, "changes");
        api.setRightPanelTab(wid, tab);
      }
    },
    { workspace: WORKSPACE, thread: THREAD, tid: THREAD.id, wid: WORKSPACE.id, snapshots: SNAPSHOTS, tab },
  );
}

/** Appends one snapshot with a new file so the cumulative file count grows. */
async function addSnapshotWithNewFile(page: Page): Promise<void> {
  await page.evaluate((tid) => {
    const stores: unknown[] =
      (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
    const diffStore = stores.find((s) => "setSnapshots" in getState(s));
    if (!diffStore) return;
    const api = (
      diffStore as {
        getState: () => {
          snapshotsByThread: Record<string, unknown[]>;
          setSnapshots: (id: string, snaps: unknown) => void;
        };
      }
    ).getState();
    const existing = api.snapshotsByThread[tid] ?? [];
    const fresh = {
      id: "s3",
      message_id: "m-s3",
      thread_id: tid,
      ref_before: "ccccccc",
      ref_after: "ddddddd",
      files_changed: ["TabStatus.tsx"],
      worktree_path: null,
      created_at: new Date().toISOString(),
    };
    api.setSnapshots(tid, [...existing, fresh]);
  }, THREAD.id);
}

test.describe("Right panel tab status", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      // The auxiliary hydrator loads tasks from this RPC on thread activation;
      // returning them here (rather than poking the store) avoids a race where
      // the hydrator's default empty result overwrites a seeded task list.
      "thread.getTasks": TASKS,
      "snapshot.listByThread": SNAPSHOTS,
      "settings.get": getDefaultSettings(),
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

  test("rail icons show scope progress, change count, and the active-tab lamp", async ({ page }, testInfo) => {
    await seedPanel(page, "tasks");

    // Rail icons are addressed by their stable data attribute: the hover-× close
    // control shares the tab's product label in its accessible name, so a name
    // match would be ambiguous.
    const scopeTab = page.locator('[data-rail-tab="tasks"]');
    const changesTab = page.locator('[data-rail-tab="changes"]');
    await expect(scopeTab).toBeVisible();

    // Scope progress (2 completed of 5) and Review file count (4 distinct).
    await expect(scopeTab).toContainText("2/5");
    await expect(changesTab).toContainText("4");

    // The active icon carries the amber lamp + its indicator bar.
    await expect(scopeTab).toHaveClass(/text-primary/);
    await expect(page.getByTestId("rail-active-indicator")).toBeAttached();

    await page.screenshot({ path: testInfo.outputPath("scope-active.png") });

    // Switching tabs moves the lamp to Review.
    await changesTab.click();
    await expect(changesTab).toHaveClass(/text-primary/);
    await expect(scopeTab).not.toHaveClass(/text-primary/);

    await page.screenshot({ path: testInfo.outputPath("changes-active.png") });
  });

  test("review tab pulses fresh when new files land while viewing another tab", async ({ page }) => {
    // Open on Scope so the Review tab is inactive; this also baselines the
    // current file count so pre-existing changes do not pulse.
    await seedPanel(page, "tasks");

    const changesTab = page.locator('[data-rail-tab="changes"]');
    await expect(changesTab).toContainText("4");
    await expect(changesTab.locator(".changes-fresh-ring")).toHaveCount(0);

    // A new turn lands while the user is on Scope → Review goes fresh.
    await addSnapshotWithNewFile(page);
    await expect(changesTab).toContainText("5");
    await expect(changesTab.locator(".changes-fresh-ring")).toBeVisible();

    // Viewing Review clears the freshness signal.
    await changesTab.click();
    await expect(changesTab.locator(".changes-fresh-ring")).toHaveCount(0);
  });

  test("review badge caps the count for very large diffs", async ({ page }) => {
    // Seed on Scope (Changes inactive) so the DiffPanel does not refetch and
    // overwrite the large snapshot we poke in below.
    await seedPanel(page, "tasks");

    await page.evaluate((tid) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
      const diffStore = stores.find((s) => "setSnapshots" in getState(s));
      if (!diffStore) return;
      const files = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
      (
        diffStore as { getState: () => { setSnapshots: (id: string, snaps: unknown) => void } }
      )
        .getState()
        .setSnapshots(tid, [
          {
            id: "big",
            message_id: "m-big",
            thread_id: tid,
            ref_before: "aaaaaaa",
            ref_after: "bbbbbbb",
            files_changed: files,
            worktree_path: null,
            created_at: new Date().toISOString(),
          },
        ]);
    }, THREAD.id);

    // 200 distinct files renders as the capped label, not "200".
    const changesTab = page.locator('[data-rail-tab="changes"]');
    await expect(changesTab).toContainText("99+");
  });
});
