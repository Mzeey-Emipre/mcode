import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const WORKSPACE = {
  id: "ws-typed-mentions",
  name: "Typed Mentions",
  path: "/tmp/typed-mentions",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-typed-mentions",
  workspace_id: WORKSPACE.id,
  title: "Codex mentions",
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

async function setupCodexChat(page: Page): Promise<void> {
  await page.evaluate(
    ({ ws, th }) => {
      const stores: Array<{ getState: () => Record<string, unknown>; setState: (value: unknown) => void }> =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown>; setState: (value: unknown) => void }> }).__mcodeStores ?? [];
      const wsStore = stores.find((store) => {
        const state = store.getState();
        return "activeThreadId" in state && "threads" in state && "workspaces" in state;
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

test("Codex @ autocomplete groups agents and files, then sends selected agent metadata", async ({ page }) => {
  let sendParams: unknown;
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWebSocketServer(page, {
    "workspace.enrich": { items: [] },
    "settings.get": getDefaultSettings(),
    "provider.codexAgents": [
      {
        name: "planner",
        path: "C:/Users/example/.codex/agents/planner.toml",
        description: "Plans implementation work.",
      },
    ],
    "file.list": ["src/app.ts", "src/components/chat/Composer.tsx"],
    "agent.send": (params) => {
      sendParams = params;
      return null;
    },
  });
  await interceptZustandStores(page);
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete === true,
  );
  await setupCodexChat(page);

  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.type("@");

  const popup = page.getByRole("listbox", { name: "Mention suggestions" });
  await expect(popup).toBeVisible();
  await expect(popup.getByText("Agents", { exact: true })).toBeVisible();
  await expect(popup.getByText("Files", { exact: true })).toBeVisible();
  await expect(popup.getByRole("option", { name: /planner/ })).toBeVisible();
  await expect(popup.getByRole("option", { name: /src\/app\.ts/ })).toBeVisible();

  await page.getByRole("option", { name: /planner/ }).click();
  await expect(editor).toContainText("planner");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toHaveCount(0);

  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => sendParams).toBeTruthy();
  expect(sendParams).toMatchObject({
    threadId: THREAD.id,
    content: "@planner",
    mentions: [
      {
        kind: "agent",
        label: "planner",
        name: "planner",
        path: "C:/Users/example/.codex/agents/planner.toml",
        provider: "codex",
        range: { start: 0, end: 8 },
      },
    ],
  });
});
