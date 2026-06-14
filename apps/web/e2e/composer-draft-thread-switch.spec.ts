import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import {
  interceptZustandStores,
  mockWebSocketServer,
} from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const workspace = {
  id: "ws-draft-test",
  name: "Draft Test",
  path: "/test/path",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const threadA = {
  id: "thread-a",
  workspace_id: workspace.id,
  title: "Thread A",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: now,
  updated_at: now,
  model: "claude-sonnet-4-6",
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

const threadB = { ...threadA, id: "thread-b", title: "Thread B" };

/** Seed the workspace store with two threads and open the chat view. */
async function setupDraftSwitchChat(page: Page): Promise<void> {
  await page.evaluate(
    ({ ws, threads }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: [ws],
        threads,
        activeWorkspaceId: ws.id,
        activeThreadId: threads[0]?.id ?? null,
        loading: false,
        error: null,
      });
    },
    { ws: workspace, threads: [threadA, threadB] },
  );
}

/** Boot the app with two threads and an empty conversation for draft switching. */
async function openDraftSwitchChat(page: Page): Promise<void> {
  await page.addInitScript((wsId: string) => {
    localStorage.setItem(
      "mcode-expanded-projects",
      JSON.stringify({ [wsId]: true }),
    );
  }, workspace.id);

  await mockWebSocketServer(page, {
    "workspace.enrich": { items: [] },
    "workspace.list": [workspace],
    "thread.list": [threadA, threadB],
    "conversation.page": {
      messages: [],
      hasMore: false,
      answeredPlanMessageIds: [],
      narrativeByMessage: {},
    },
    "settings.get": getDefaultSettings(),
    "provider.listModels": () => [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
    ],
  });
  await interceptZustandStores(page);

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () =>
      (window as unknown as { __mcodeHydrationComplete?: boolean })
        .__mcodeHydrationComplete === true,
  );
  await setupDraftSwitchChat(page);
  await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
}

test.describe("composer draft thread switch", () => {
  test.beforeEach(async ({ page }) => {
    await openDraftSwitchChat(page);
  });

  test("restores per-thread draft text after switching away and back", async ({ page }) => {
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.click();
    await editor.fill("draft for thread A");

    await page
      .locator('[data-testid="thread-item"][data-thread-id="thread-b"]')
      .click();
    await editor.click();
    await editor.fill("draft for thread B");
    await expect(editor).toHaveText("draft for thread B");

    await page
      .locator('[data-testid="thread-item"][data-thread-id="thread-a"]')
      .click();
    await expect(editor).toHaveText("draft for thread A");
  });
});
