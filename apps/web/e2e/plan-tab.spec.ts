import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * E2E tests for the plan view inside the Plan tab.
 *
 * The Plan tab renders saved plan content only.
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

test.describe("Plan view in Plan tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await setupWorkspace(page);
  });

  test("plan tab button exists in the right panel rail", async ({ page }) => {
    await showRightPanel(page, WORKSPACE.id, THREAD.id);

    await expect(page.getByRole("button", { name: "Plan", exact: true })).toBeVisible({
      timeout: 3000,
    });
  });

  test("plan tab shows saved plan content without task docket", async ({ page }) => {
    await page.evaluate(
      ({ tid }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const planStore = stores.find((s) => {
          const st = s.getState();
          return "plansByThread" in st && "generatingThreads" in st;
        });
        if (!planStore) throw new Error("[E2E] plan store not found");
        planStore.setState({
          plansByThread: {
            [tid]: [
              {
                id: "plan-e2e-1",
                threadId: tid,
                messageId: "message-e2e-1",
                version: 1,
                title: "Add retry mechanism for failed API calls",
                contentMd: "## Objective\n\nAdd retry handling.\n\n## Approach\n\nUse bounded backoff.",
                sectionsJson: [
                  { id: "objective", title: "Objective", level: 2 },
                  { id: "approach", title: "Approach", level: 2 },
                ],
                changeSummary: null,
                status: "draft",
                createdAt: new Date().toISOString(),
              },
            ],
          },
          activeVersionByThread: { [tid]: null },
        });
      },
      { tid: THREAD.id },
    );
    await showRightPanel(page, WORKSPACE.id, THREAD.id);

    await expect(page.getByTestId("plan-panel-viewport")).toBeVisible({ timeout: 3000 });
    await expect(page.getByText("Add retry mechanism for failed API calls")).toBeVisible();
    await expect(page.getByText("Nothing on the docket")).toHaveCount(0);
  });

  test("composer plan preview is hidden while the Plan tab is open", async ({ page }) => {
    await page.evaluate(
      ({ tid }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const planStore = stores.find((s) => {
          const st = s.getState();
          return "plansByThread" in st && "livePreviewByThread" in st;
        });
        if (!planStore) throw new Error("[E2E] plan store not found");
        planStore.setState({
          plansByThread: {
            [tid]: [
              {
                id: "plan-preview-hidden-1",
                threadId: tid,
                messageId: "message-preview-hidden-1",
                version: 1,
                title: "Sequential implementation tasks for README update",
                contentMd: "## Objective\n\nUpdate README.",
                sectionsJson: [{ id: "objective", title: "Objective", level: 2 }],
                changeSummary: null,
                status: "draft",
                createdAt: new Date().toISOString(),
              },
            ],
          },
          activeVersionByThread: { [tid]: null },
          livePreviewByThread: {
            [tid]: {
              id: "plan-preview-hidden-1",
              version: 1,
              title: "Sequential implementation tasks for README update",
            },
          },
        });
      },
      { tid: THREAD.id },
    );

    await showRightPanel(page, WORKSPACE.id, THREAD.id);

    await expect(page.getByTestId("plan-panel-viewport")).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId("plan-preview")).toHaveCount(0);
  });
});
