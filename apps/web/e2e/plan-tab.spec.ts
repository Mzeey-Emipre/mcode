import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * E2E tests for the plan view inside the Scope tab.
 *
 * The plan document renders above the task list in the Scope tab.
 * When no plan exists, only the task list (or empty state) shows.
 */

const WORKSPACE = {
  id: "ws-plan-tab-1",
  name: "Plan Tab Test",
  path: "/tmp/plan-tab-test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-plan-tab-1",
  workspace_id: "ws-plan-tab-1",
  title: "Plan tab test",
  branch_name: "main",
  branch_ref: "main",
  worktree_path: null,
  worktree_managed: false,
  sdk_session_id: null,
  status: "idle",
  model: "claude-sonnet-4-20250514",
  provider: "claude",
  goal: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

async function setupWorkspace(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const wsStore = stores.find((s) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: thread.id,
        loading: false,
        error: null,
      });
    },
    { workspace: WORKSPACE, thread: THREAD },
  );
}

async function showRightPanel(page: Page, workspaceId: string, threadId: string): Promise<void> {
  await page.evaluate(
    ({ wid, tid }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const diffStore = stores.find((s) => {
        const st = s.getState();
        return "rightPanelByThread" in st && "showRightPanel" in st;
      });
      if (!diffStore) throw new Error("[E2E] diff store not found");
      // The whole panel record is per-thread (ADR-0012).
      diffStore.getState().showRightPanel(wid, tid);
      diffStore.getState().setRightPanelTab(wid, tid, "tasks");
    },
    { wid: workspaceId, tid: threadId },
  );
}

async function seedPlanStore(page: Page, threadId: string): Promise<void> {
  await page.evaluate(
    ({ tid }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const planStore = stores.find((s) => {
        const st = s.getState();
        return "plansByThread" in st && "generatingThreads" in st;
      });
      if (planStore) {
        planStore.setState({
          plansByThread: { [tid]: [] },
          activeVersionByThread: { [tid]: null },
        });
      }
    },
    { tid: threadId },
  );
}

test.describe("Plan view in Scope tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await setupWorkspace(page);
  });

  test("scope tab button exists in the right panel header", async ({ page }) => {
    await showRightPanel(page, WORKSPACE.id, THREAD.id);

    const scopeTab = page.getByRole("button", { name: "Scope", exact: true });
    await expect(scopeTab).toBeVisible({ timeout: 3000 });
  });

  test("scope tab shows empty state when no plan and no tasks exist", async ({ page }) => {
    await seedPlanStore(page, THREAD.id);
    await showRightPanel(page, WORKSPACE.id, THREAD.id);

    // The empty state shows the existing "Nothing on the docket" message
    await expect(page.getByText("Nothing on the docket")).toBeVisible({ timeout: 3000 });
  });
});
