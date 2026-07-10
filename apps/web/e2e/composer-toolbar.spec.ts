import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_SETTINGS = getDefaultSettings();

const WORKSPACE = {
  id: "ws-composer-toolbar",
  name: "Composer Toolbar Test",
  path: "/tmp/composer-toolbar",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-composer-toolbar",
  workspace_id: WORKSPACE.id,
  title: "Active Thread",
  status: "active" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: "claude-sonnet-4-6",
  deleted_at: null,
  worktree_managed: false,
  sdk_session_id: null,
  provider: "claude",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

async function setupChat(page: Page): Promise<void> {
  await page.evaluate(
    ({ ws, th }) => {
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
        threads: [th],
        activeWorkspaceId: ws.id,
        activeThreadId: th.id,
        loading: false,
        error: null,
      });
    },
    { ws: WORKSPACE, th: THREAD },
  );
}

test.describe("Composer toolbar", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "provider.listModels": () => [
        { id: "alpha-model", name: "Alpha Model", group: "Test" },
        { id: "beta-model", name: "Beta Model", group: "Test" },
      ],
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete === true);
    await setupChat(page);

    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
  });

  test("opens the add menu and keeps the file input available", async ({ page }) => {
    await expect(page.getByTestId("composer-add")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("composer-attachment-input")).toBeAttached();
    await page.getByTestId("composer-add").click();
    const menu = page.getByTestId("composer-add-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: /Files/ })).toBeVisible();
    await expect(menu.getByText("Images, PDFs, documents, and code")).toBeVisible();
    await expect(menu.getByRole("button", { name: /Goal/ })).toHaveCount(0);
    await expect(menu.getByRole("button", { name: /Plan mode/ })).toHaveCount(0);
    await expect(menu.getByRole("button", { name: /Mention an agent or file/ })).toHaveCount(0);
    await page.screenshot({
      path: "e2e/screenshots/composer-toolbar-add-menu.png",
      fullPage: true,
    });
  });

  test("locked-provider model search filters RPC-backed models", async ({ page }) => {
    await page.getByTestId("model-selector-trigger").click();
    await expect(page.getByTestId("model-selector-locked-search")).toBeVisible({ timeout: 10_000 });
    const search = page.getByTestId("model-selector-locked-search");
    await search.fill("Beta");

    await expect(page.getByRole("button", { name: "Select Beta Model", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Alpha Model", exact: true })).toHaveCount(0);

    await page.screenshot({
      path: "e2e/screenshots/model-selector-search-filter.png",
      fullPage: true,
    });
  });

  test("model selector left rail switches search context", async ({ page }) => {
    await page.getByTestId("model-selector-trigger").click();
    await expect(page.getByTestId("model-selector-rail-favorites")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("model-selector-rail-favorites").click();
    await expect(page.getByTestId("model-selector-locked-search")).toHaveAttribute(
      "placeholder",
      "Search favorites…",
    );

    await page.getByTestId("model-group-claude").click();
    await expect(page.getByTestId("model-selector-locked-search")).toHaveAttribute(
      "placeholder",
      "Search models…",
    );
  });
});
