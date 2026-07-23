import { test, expect, type Page } from "@playwright/test";
import type { Thread, TurnSnapshot } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
  type WsController,
} from "./helpers/e2e-helpers";

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

/** Two completed of five parent tasks → Task bubble reads "2/5 steps". */
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
let snapshotsForList: TurnSnapshot[] = SNAPSHOTS;
let wsController: WsController;

/**
 * Seeds the workspace and thread, then opens the right panel on the given tab.
 * Snapshot state hydrates through the mocked production RPC.
 */
async function seedPanel(page: Page, tab: "tasks" | "changes"): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, tid, wid, tab }) => {
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
          activeThreadId: null,
        });
        (
          wsStore as {
            getState: () => {
              setActiveThread: (threadId: string | null) => void;
            };
          }
        ).getState().setActiveThread(tid);
      }

      const diffStore = stores.find(
        (s) => "showRightPanel" in getState(s) && "setRightPanelTab" in getState(s),
      );
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              showRightPanel: (id: string, threadId?: string) => void;
              setRightPanelTab: (id: string, threadId: string | null, t: string) => void;
            };
          }
        ).getState();
        api.showRightPanel(wid, tid);
        // Open both rail tabs so switching can be exercised; the requested tab
        // is activated last.
        api.setRightPanelTab(wid, tid, "tasks");
        api.setRightPanelTab(wid, tid, "changes");
        api.setRightPanelTab(wid, tid, tab);
      }
    },
    { workspace: WORKSPACE, thread: THREAD, tid: THREAD.id, wid: WORKSPACE.id, tab },
  );
}

/** Publishes one real-change turn so Review refreshes from the authoritative snapshot RPC. */
async function addSnapshotWithNewFile(): Promise<void> {
  const fresh = makeSnapshot("s3", ["TabStatus.tsx"]);
  snapshotsForList = [...snapshotsForList, fresh];
  await wsController.sendPush("turn.persisted", {
    threadId: THREAD.id,
    messageId: fresh.message_id,
    toolCallCount: 1,
    filesChanged: fresh.files_changed,
  });
}

async function emitTaskCreate(page: Page): Promise<void> {
  await page.evaluate((tid) => {
    const stores: unknown[] =
      (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
    const threadStore = stores.find((s) => "handleAgentEvent" in getState(s));
    if (!threadStore) throw new Error("thread store not found");
    (
      threadStore as {
        getState: () => {
          handleAgentEvent: (event: unknown) => void;
        };
      }
    ).getState().handleAgentEvent({
      type: "toolUse",
      threadId: tid,
      toolCallId: "task-create-live",
      toolName: "TaskCreate",
      toolInput: {
        subject: "Buy groceries",
        description: "Pick up milk, eggs, bread",
      },
    });
  }, THREAD.id);
}

async function emitUpdatePlan(page: Page): Promise<void> {
  await page.evaluate((tid) => {
    const stores: unknown[] =
      (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
    const threadStore = stores.find((s) => "handleAgentEvent" in getState(s));
    if (!threadStore) throw new Error("thread store not found");
    (
      threadStore as {
        getState: () => {
          handleAgentEvent: (event: unknown) => void;
        };
      }
    ).getState().handleAgentEvent({
      type: "toolUse",
      threadId: tid,
      toolCallId: "update-plan-live",
      toolName: "update_plan",
      toolInput: {
        plan: [
          { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
          { status: "in_progress", step: "Test todo item two with CODE-A2 and CODE-B2" },
          { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
        ],
      },
    });
  }, THREAD.id);
}

test.describe("Right panel tab status", () => {
  test.beforeEach(async ({ page }) => {
    snapshotsForList = SNAPSHOTS;
    wsController = await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      // The auxiliary hydrator loads tasks from this RPC on thread activation;
      // returning them here (rather than poking the store) avoids a race where
      // the hydrator's default empty result overwrites a seeded task list.
      "thread.getTasks": TASKS,
      "snapshot.listByThread": () => snapshotsForList,
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

  test("rail icons show Plan, change count, and the active-tab lamp", async ({ page }, testInfo) => {
    await seedPanel(page, "tasks");

    // Rail icons are addressed by their stable data attribute: the hover-× close
    // control shares the tab's product label in its accessible name, so a name
    // match would be ambiguous.
    const planTab = page.locator('[data-rail-tab="tasks"]');
    const changesTab = page.locator('[data-rail-tab="review"]');
    await expect(planTab).toBeVisible();

    // Plan no longer carries task progress in the rail; Review keeps file count.
    await expect(planTab).toHaveAttribute("aria-label", "Plan");
    await expect(planTab).not.toContainText("2/5");
    await expect(changesTab).toContainText("4");

    // The active icon carries the amber lamp + its indicator bar.
    await expect(planTab).toHaveClass(/text-primary/);
    await expect(page.getByTestId("rail-active-indicator")).toBeAttached();

    await page.screenshot({ path: testInfo.outputPath("plan-active.png") });

    // Switching tabs moves the lamp to Review.
    await changesTab.click();
    await expect(changesTab).toHaveClass(/text-primary/);
    await expect(planTab).not.toHaveClass(/text-primary/);

    await page.screenshot({ path: testInfo.outputPath("changes-active.png") });
  });

  test("task bubble renders live TaskCreate tool calls", async ({ page }) => {
    await seedPanel(page, "tasks");
    await expect(page.getByText("2/5 steps")).toBeVisible();

    await emitTaskCreate(page);

    await expect(page.getByText("2/6 steps")).toBeVisible();
    await page.getByText("2/6 steps").click();
    await expect(page.getByText("Buy groceries - Pick up milk, eggs, bread")).toBeVisible();
    await expect(page.getByText(/nothing on the docket/i)).toHaveCount(0);
  });

  test("task bubble renders live Codex update_plan tool calls", async ({ page }) => {
    await seedPanel(page, "tasks");
    await expect(page.getByText("2/5 steps")).toBeVisible();

    await emitUpdatePlan(page);

    await expect(page.getByText("1/3 steps")).toBeVisible();
    await page.getByText("1/3 steps").click();
    await expect(page.getByText("Test todo item one with CODE-A1 and CODE-B1")).toBeVisible();
    await expect(page.getByText("Test todo item two with CODE-A2 and CODE-B2")).toBeVisible();
    await expect(page.getByText("Test todo item three with CODE-A3 and CODE-B3")).toBeVisible();
    await expect(page.getByText(/nothing on the docket/i)).toHaveCount(0);
  });

  test("review tab pulses fresh when new files land while viewing another tab", async ({ page }) => {
    // Open on Plan so the Review tab is inactive; this also baselines the
    // current file count so pre-existing changes do not pulse.
    await seedPanel(page, "tasks");

    const changesTab = page.locator('[data-rail-tab="review"]');
    await expect(changesTab).toContainText("4");
    await expect(changesTab.locator(".changes-fresh-ring")).toHaveCount(0);

    // A new turn lands while the user is on Plan, so Review goes fresh.
    await addSnapshotWithNewFile();
    await expect(changesTab).toContainText("5");
    await expect(changesTab.locator(".changes-fresh-ring")).toBeVisible();

    // Viewing Review clears the freshness signal.
    await changesTab.click();
    await expect(changesTab.locator(".changes-fresh-ring")).toHaveCount(0);
  });

  test("review badge caps the count for very large diffs", async ({ page }) => {
    // Keep Review inactive so turn.persisted refreshes snapshots immediately.
    await seedPanel(page, "tasks");

    const files = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
    const snapshot = makeSnapshot("big", files);
    snapshotsForList = [snapshot];
    await wsController.sendPush("turn.persisted", {
      threadId: THREAD.id,
      messageId: snapshot.message_id,
      toolCallCount: 1,
      filesChanged: files,
    });

    // 200 distinct files renders as the capped label, not "200".
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const reviewButton = Array.from(
              document.querySelectorAll("button"),
            ).find((button) =>
              button.getAttribute("aria-label")?.startsWith("Review,"),
            );
            return reviewButton?.textContent?.includes("99+") ?? false;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});
