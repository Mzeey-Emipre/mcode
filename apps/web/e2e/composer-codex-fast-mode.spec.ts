import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";
import { getDefaultSettings, type Settings } from "@mcode/contracts";

const WORKSPACE = {
  id: "ws-codex-fast",
  name: "Codex Fast Mode Test",
  path: "/tmp/codex-fast",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const CODEX_THREAD = {
  id: "thread-codex-fast",
  workspace_id: WORKSPACE.id,
  title: "Codex Thread",
  status: "active" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: "gpt-5.2-codex",
  deleted_at: null,
  worktree_managed: false,
  sdk_session_id: null,
  provider: "codex",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: "medium",
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
  codex_fast_mode: null,
};

const updateCalls: Array<{ threadId: string; codexFastMode?: boolean | null }> = [];

async function setupCodexChat(page: Page): Promise<void> {
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
      const diffStore = stores.find((s: { getState: () => Record<string, unknown> }) => {
        const st = s.getState();
        return "showRightPanel" in st && "hideRightPanel" in st;
      });
      if (diffStore) {
        diffStore.getState().hideRightPanel(ws.id);
      }
    },
    { ws: WORKSPACE, th: CODEX_THREAD },
  );
}

/** Boots the composer page with mocked settings and a Codex thread selected. */
async function bootComposer(page: Page, settings: Settings): Promise<void> {
  updateCalls.length = 0;
  await mockWebSocketServer(page, {
    "workspace.enrich": { items: [] },
    "settings.get": settings,
    "thread.updateSettings": (params) => {
      const p = params as { threadId: string; codexFastMode?: boolean | null };
      updateCalls.push(p);
      return true;
    },
  });
  await interceptZustandStores(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () => (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete === true,
  );
  await setupCodexChat(page);
  await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
}

test.describe("Composer Codex fast mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("fast mode switch toggles and persists per thread", async ({ page }) => {
    await bootComposer(page, getDefaultSettings());
    await page.getByRole("button", { name: /Medium/ }).click();
    const fastSwitch = page.getByTestId("composer-codex-fast-switch");
    await expect(fastSwitch).toBeVisible({ timeout: 10_000 });
    await expect(fastSwitch).toHaveAttribute("aria-checked", "false");

    await fastSwitch.click({ force: true });
    await expect(fastSwitch).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => updateCalls.some((c) => c.codexFastMode === true)).toBe(true);
    expect(updateCalls.at(-1)?.threadId).toBe(CODEX_THREAD.id);

    await fastSwitch.click({ force: true });
    await expect(fastSwitch).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => updateCalls.some((c) => c.codexFastMode === null)).toBe(true);
  });

  test("fast mode switch respects global-fast-default=true", async ({ page }) => {
    const settings = getDefaultSettings();
    settings.provider.codex.fastMode = true;
    await bootComposer(page, settings);
    await page.getByRole("button", { name: /Medium/ }).click();
    const fastSwitch = page.getByTestId("composer-codex-fast-switch");
    await expect(fastSwitch).toBeVisible({ timeout: 10_000 });
    await expect(fastSwitch).toHaveAttribute("aria-checked", "true");

    await fastSwitch.click({ force: true });
    await expect(fastSwitch).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => updateCalls.some((c) => c.codexFastMode === false)).toBe(true);
    expect(updateCalls.at(-1)?.threadId).toBe(CODEX_THREAD.id);

    await fastSwitch.click({ force: true });
    await expect(fastSwitch).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => updateCalls.some((c) => c.codexFastMode === null)).toBe(true);
  });
});
