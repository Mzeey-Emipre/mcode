import { expect, test, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
  seedActiveThread,
} from "./helpers/e2e-helpers";

const now = new Date("2026-06-25T00:00:00.000Z").toISOString();

const WORKSPACE = {
  id: "ws-responsive-shell",
  name: "Responsive Shell",
  path: "/tmp/responsive-shell",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const WORKSPACE_TWO = {
  ...WORKSPACE,
  id: "ws-responsive-shell-two",
  name: "Responsive Shell Two",
  path: "/tmp/responsive-shell-two",
  last_opened_at: Date.now() - 1000,
  sort_order: 1,
};

const WORKSPACES = [WORKSPACE, WORKSPACE_TWO];

const THREAD: Thread = {
  id: "thread-responsive-shell",
  workspace_id: WORKSPACE.id,
  title: "Responsive Thread",
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

const THREADS: Thread[] = Array.from({ length: 10 }, (_, index) => ({
  ...THREAD,
  id: index === 0 ? THREAD.id : `${THREAD.id}-${index}`,
  title: index === 0 ? THREAD.title : `Responsive Thread ${index + 1}`,
  updated_at: new Date(Date.parse(now) + index * 1000).toISOString(),
}));

const THREADS_TWO: Thread[] = Array.from({ length: 8 }, (_, index) => ({
  ...THREAD,
  id: `thread-responsive-shell-two-${index}`,
  workspace_id: WORKSPACE_TWO.id,
  title: `Second Project Thread ${index + 1}`,
  updated_at: new Date(Date.parse(now) + index * 1000).toISOString(),
}));

const ALL_THREADS = [...THREADS, ...THREADS_TWO];

async function openChangesPanel(page: Page): Promise<void> {
  await page.getByTestId("header-panel-toggle").click();
  await page.evaluate(
    ({ wid, tid }) => {
      const stores =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
          .__mcodeStores ?? [];
      const diffStore = stores.find((s) => {
        const state = s.getState();
        return "showRightPanel" in state && "setRightPanelTab" in state;
      });
      if (!diffStore) throw new Error("[E2E] diff store not found");
      const api = diffStore.getState() as {
        setRightPanelTab: (workspaceId: string, threadId: string | null, tab: string) => void;
      };
      api.setRightPanelTab(wid, tid, "changes");
    },
    { wid: WORKSPACE.id, tid: THREAD.id },
  );
}

async function shellState(page: Page): Promise<{
  sidebarCollapsed: boolean;
  sidebarCollapsedByLayout: boolean;
  rightPanelVisible: boolean;
  rightPanelMaximized: boolean;
  rightPanelMaximizedByLayout: boolean;
}> {
  return page.evaluate(
    ({ wid, tid }) => {
      const stores =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
          .__mcodeStores ?? [];
      const uiStore = stores.find((s) => {
        const state = s.getState();
        return "rightPanelMaximized" in state && "sidebarCollapsed" in state;
      });
      const diffStore = stores.find((s) => {
        const state = s.getState();
        return "getRightPanelVisible" in state;
      });
      if (!uiStore || !diffStore) throw new Error("[E2E] shell stores not found");
      const ui = uiStore.getState() as {
        sidebarCollapsed: boolean;
        sidebarCollapsedByLayout: boolean;
        rightPanelMaximized: boolean;
        rightPanelMaximizedByLayout: boolean;
      };
      const diff = diffStore.getState() as {
        getRightPanelVisible: (workspaceId: string, threadId?: string) => boolean;
      };
      return {
        sidebarCollapsed: ui.sidebarCollapsed,
        sidebarCollapsedByLayout: ui.sidebarCollapsedByLayout,
        rightPanelVisible: diff.getRightPanelVisible(wid, tid),
        rightPanelMaximized: ui.rightPanelMaximized,
        rightPanelMaximizedByLayout: ui.rightPanelMaximizedByLayout,
      };
    },
    { wid: WORKSPACE.id, tid: THREAD.id },
  );
}

test.describe("responsive shell resizing", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": WORKSPACES,
      "thread.list": ALL_THREADS,
      "conversation.page": {
        messages: [],
        hasMore: false,
        answeredPlanMessageIds: [],
        narrativeByMessage: {},
      },
      "github.branchPr": null,
      "git.getRemoteUrl": {
        label: "local/responsive-shell",
        webUrl: "https://github.com/local/responsive-shell",
      },
      "git.workingTreeFiles": [],
      "git.branchComparison": null,
      "snapshot.listByThread": [],
    });
    await interceptZustandStores(page);
    await page.addInitScript((workspaceIds: string[]) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify(Object.fromEntries(workspaceIds.map((id) => [id, true]))),
      );
    }, WORKSPACES.map((workspace) => workspace.id));
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete ===
        true,
      { timeout: 30_000 },
    );
    await seedActiveThread(page, WORKSPACE, THREAD);
    await page.evaluate((payload) => {
      const stores =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown>; setState: (patch: Record<string, unknown>) => void }> })
          .__mcodeStores ?? [];
      const workspaceStore = stores.find((s) => {
        const state = s.getState();
        return "activeThreadId" in state && "threads" in state;
      });
      if (!workspaceStore) throw new Error("[E2E] workspace store not found");
      workspaceStore.setState({ workspaces: payload.workspaces, threads: payload.threads });
    }, { workspaces: WORKSPACES, threads: ALL_THREADS });
  });

  test("preserves open panels on shrink and restores layout-owned state on grow", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await expect(page.getByTestId("thread-overview-body")).toBeVisible();
    await expect(page.getByTestId("thread-item")).toHaveCount(12);
    await expect
      .poll(async () =>
        page.getByTestId("chat-composer-stage").evaluate((node) =>
          Number.parseFloat(getComputedStyle(node).paddingRight),
        ),
      )
      .toBeGreaterThan(0);

    const preOpenChatBox = await page.getByTestId("chat-view").boundingBox();
    expect(preOpenChatBox).not.toBeNull();

    await openChangesPanel(page);
    await expect(page.getByTestId("right-panel")).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId("right-panel").boundingBox())?.width ?? 0)
      .toBeGreaterThan(preOpenChatBox!.width * 0.49);
    await expect
      .poll(async () => (await page.getByTestId("right-panel").boundingBox())?.width ?? 0)
      .toBeLessThan(preOpenChatBox!.width * 0.51);
    await expect(page.getByTestId("thread-overview-body")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer-stage")).toHaveCSS("padding-right", "0px");
    await expect.poll(() => shellState(page)).toMatchObject({
      sidebarCollapsed: false,
      rightPanelVisible: true,
      rightPanelMaximized: false,
    });

    for (const width of [1250, 1180, 1040, 900, 640]) {
      await page.setViewportSize({ width, height: 900 });
    }

    await expect.poll(() => shellState(page)).toMatchObject({
      sidebarCollapsed: true,
      sidebarCollapsedByLayout: true,
      rightPanelVisible: true,
      rightPanelMaximized: true,
      rightPanelMaximizedByLayout: true,
    });
    await expect(page.getByTestId("right-panel")).toBeVisible();
    await expect(page.getByTestId("thread-overview-body")).toHaveCount(0);

    for (const width of [900, 1040, 1180, 1250, 1600]) {
      await page.setViewportSize({ width, height: 900 });
    }

    await expect.poll(() => shellState(page)).toMatchObject({
      sidebarCollapsed: false,
      sidebarCollapsedByLayout: false,
      rightPanelVisible: true,
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
    await expect(page.getByTestId("sidebar-docked")).toBeVisible();
    await expect(page.getByTestId("right-panel")).toBeVisible();
    await expect(page.getByTestId("thread-overview-body")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
