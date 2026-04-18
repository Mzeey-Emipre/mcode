import { test, expect, type Page } from "@playwright/test";

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

  // Minimal valid settings object matching the server's SettingsSchema defaults.
  // Required because App.tsx reads settings.appearance.theme on first render;
  // returning null from settings.get causes an immediate crash.
  const defaultSettings = {
    appearance: { theme: "system" },
    agent: { maxConcurrent: 5, defaults: { mode: "chat", permission: "full" }, guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
    model: { defaults: { provider: "claude", id: "claude-opus-4-7", reasoning: "high", fallbackId: "claude-sonnet-4-6" } },
    terminal: { scrollback: 250 },
    notifications: { enabled: true },
    worktree: { naming: { mode: "auto", aiConfirmation: true } },
    server: { memory: { heapMb: 96 } },
    provider: { cli: { codex: "", claude: "", copilot: "" } },
    prDraft: { provider: "", model: "" },
  };

  await page.routeWebSocket(/ws:\/\/localhost:19400/, (ws) => {
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
      else if (method === "thread.list") result = [thread];
      else if (method === "settings.get") result = defaultSettings;
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
    await expect(indicator).toHaveClass(/animate-pulse/);
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
