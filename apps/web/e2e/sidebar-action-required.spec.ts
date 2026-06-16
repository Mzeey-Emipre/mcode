import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Mock the WebSocket server with optional pending permission injection.
 *
 * The app connects to ws://localhost:19400 by default. Permissions arrive
 * exclusively via the `permission.request` push channel — there is no
 * initial-fetch RPC. The push is sent in the same message-handler tick as
 * the `thread.list` reply so the thread already exists in the workspace store
 * when `addPermissionRequest` runs.
 */
async function mockWebSocketServer(
  page: Page,
  opts: { pendingPermission: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const workspace = {
    id: "ws-1",
    name: "Test Workspace",
    path: "/test/path",
    provider_config: {},
    is_git_repo: true,
    pinned: false,
    last_opened_at: Date.now() - 3600_000,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  const thread = {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Pending Thread",
    status: "active" as const,
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
    copilot_agent: null,
    last_compact_summary: null,
  };

  // Use the contract's full default settings. App.tsx reads nested keys on first
  // render (e.g. settings.appearance.theme and settings.performance.threadCacheSize),
  // so a hand-rolled partial object crashes the app the moment a new required key
  // is added to the schema. Sourcing defaults from the contract keeps this in sync.
  const defaultSettings = getDefaultSettings();

  // Match 5-digit ports (mcode range) to avoid intercepting Vite's HMR socket.
  await page.routeWebSocket(/ws:\/\/localhost:\d{5}/, (ws) => {
    ws.onMessage((data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const method = msg.method as string;
      let result: unknown = null;
      if (method === "workspace.list") result = [workspace];
      else if (method === "workspace.enrich") result = { items: [] };
      else if (method === "workspace.touchLastOpened") result = null;
      else if (method === "thread.list") result = [thread];
      else if (method === "settings.get") result = defaultSettings;
      else if (method === "providers.listAvailability") result = [];
      else if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      ws.send(JSON.stringify({ id: msg.id, result }));

      // After confirming the thread exists in the store, push the permission
      // request so `pendingPermissionThreadIds` resolves for that thread.
      // PermissionRequest fields: requestId, threadId, toolName, input (no `settled` — store adds it).
      if (method === "thread.list" && opts.pendingPermission) {
        ws.send(
          JSON.stringify({
            type: "push",
            channel: "permission.request",
            data: {
              requestId: "perm-1",
              threadId: "thread-1",
              toolName: "bash",
              input: { command: "ls" },
            },
          }),
        );
      }
    });
  });
}

test.describe("sidebar action-required indicator", () => {
  test("shows a ring indicator with aria-label when a permission is pending", async ({
    page,
  }) => {
    await mockWebSocketServer(page, { pendingPermission: true });
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-list']");

    // The workspace row is the only button with aria-expanded. Filtering by that
    // avoids the nested "Delete Test Workspace" button, whose text bleeds into
    // the parent row's accessible name.
    await page
      .locator('[role="button"][aria-expanded]')
      .filter({ hasText: "Test Workspace" })
      .click();

    const indicator = page.getByLabel("Action required");
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveClass(/ring-amber-500/);
    await expect(indicator).toHaveClass(/bg-transparent/);
    await expect(indicator).toHaveClass(/status-pulse/);
  });

  test("does not show the ring indicator when no permission is pending", async ({
    page,
  }) => {
    await mockWebSocketServer(page, { pendingPermission: false });
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-list']");

    // The workspace row is the only button with aria-expanded. Filtering by that
    // avoids the nested "Delete Test Workspace" button, whose text bleeds into
    // the parent row's accessible name.
    await page
      .locator('[role="button"][aria-expanded]')
      .filter({ hasText: "Test Workspace" })
      .click();

    await expect(page.getByLabel("Action required")).toHaveCount(0);
  });
});
