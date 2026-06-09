import { test, expect, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-activity-rail",
  name: "Activity Rail",
  path: "/tmp/activity-rail",
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

const THREAD = makeThread("thread-activity-rail", "Rail Thread");

/**
 * Seeds the stores and opens the right panel, optionally with an active thread
 * and a list of tabs pre-opened (in order; the last becomes active). With no
 * tabs the panel renders its empty-state card grid.
 */
async function seed(
  page: Page,
  opts: { thread?: boolean; tabs?: readonly string[] } = {},
): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, wid, tid, withThread, tabs }) => {
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
        threads: withThread ? [thread] : [],
        activeThreadId: withThread ? tid : null,
        pendingNewThread: !withThread,
      });

      const diffStore = stores.find((s) => "showRightPanel" in getState(s));
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              showRightPanel: (id: string, threadId?: string) => void;
              setRightPanelTab: (id: string, t: string) => void;
            };
          }
        ).getState();
        api.showRightPanel(wid, withThread ? tid : undefined);
        for (const t of tabs) api.setRightPanelTab(wid, t);
      }
    },
    {
      workspace: WORKSPACE,
      thread: THREAD,
      wid: WORKSPACE.id,
      tid: THREAD.id,
      withThread: opts.thread ?? false,
      tabs: opts.tabs ?? [],
    },
  );
}

test.describe("Right panel activity rail", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "thread.getTasks": [],
      "snapshot.listByThread": [],
      "terminal.create": { ptyId: "pty-rail", shell: "bash" },
      "terminal.resize": true,
      "terminal.kill": true,
      "terminal.killByThread": true,
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

  test("switches the active tab when a rail icon is clicked", async ({ page }) => {
    // Browser then Terminal open; Terminal is active (opened last).
    await seed(page, { tabs: ["preview", "terminal"] });

    const browserIcon = page.locator('[data-rail-tab="preview"]');
    const terminalIcon = page.locator('[data-rail-tab="terminal"]');
    await expect(browserIcon).toBeVisible();
    await expect(terminalIcon).toHaveClass(/text-primary/);

    // Clicking the Browser icon moves the active lamp to it.
    await browserIcon.click();
    await expect(browserIcon).toHaveClass(/text-primary/);
    await expect(terminalIcon).not.toHaveClass(/text-primary/);
  });

  test("closes a tab via its hover-× and refocuses a survivor", async ({ page }) => {
    await seed(page, { tabs: ["preview", "terminal"] });

    const terminalIcon = page.locator('[data-rail-tab="terminal"]');
    await terminalIcon.hover();
    // The × is a sibling control revealed on hover; its name carries the tab label.
    await page.getByRole("button", { name: "Close Terminal" }).click();

    // Terminal is gone and Browser takes the active lamp.
    await expect(page.locator('[data-rail-tab="terminal"]')).toHaveCount(0);
    await expect(page.locator('[data-rail-tab="preview"]')).toHaveClass(/text-primary/);

    // Closing the last tab returns to the empty-state card grid.
    await page.locator('[data-rail-tab="preview"]').hover();
    await page.getByRole("button", { name: "Close Browser" }).click();
    await expect(page.getByTestId("panel-empty-state")).toBeVisible();
  });

  test("add control: hidden when nothing is creatable", async ({ page }) => {
    // Threadless, both creatable types open → nothing left to create.
    await seed(page, { tabs: ["preview", "terminal"] });

    const rail = page.getByTestId("activity-rail");
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("button", { name: /^New / })).toHaveCount(0);
  });

  test("add control: one creatable type opens directly", async ({ page }) => {
    // Threadless with only Terminal open → Browser is the sole creatable type.
    await seed(page, { tabs: ["terminal"] });

    const addDirect = page.getByRole("button", { name: "New Browser" });
    await expect(addDirect).toBeVisible();
    // No menu trigger when a single type opens directly.
    await expect(page.getByRole("button", { name: "New tab" })).toHaveCount(0);

    await addDirect.click();
    await expect(page.locator('[data-rail-tab="preview"]')).toHaveClass(/text-primary/);
  });

  test("add control: several creatable types show a menu", async ({ page }) => {
    // Thread scope with only Scope open → Browser, Terminal, Review remain.
    await seed(page, { thread: true, tabs: ["tasks"] });

    const addMenu = page.getByRole("button", { name: "New tab" });
    await expect(addMenu).toBeVisible();
    await addMenu.click();

    // The menu presents the creatable set plus the Files coming-soon teaser.
    await expect(page.getByRole("menuitem", { name: /Browser/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Review/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Files/ })).toBeDisabled();

    // Choosing Terminal opens and activates it.
    await page.getByRole("menuitem", { name: /Terminal/ }).click();
    await expect(page.locator('[data-rail-tab="terminal"]')).toHaveClass(/text-primary/);
  });
});
