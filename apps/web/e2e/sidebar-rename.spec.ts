import { test, expect, type Page } from "@playwright/test";

/**
 * Mock the WebSocket server so the WS transport connects and RPC calls
 * resolve instead of hanging. Required since App.tsx gates rendering on
 * transport readiness (shows "Connecting..." until WS opens).
 */
async function mockWebSocketServer(page: Page): Promise<void> {
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
    title: "Test Thread",
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

  await page.routeWebSocket(/ws:\/\/localhost:3100/, (ws) => {
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
      else if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
}

test.describe("Sidebar Thread Rename", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-list']");
  });

  test("double-click on thread in sidebar enters edit mode", async ({ page }) => {
    const threadItem = page.locator("[data-testid='thread-item']").first();
    await threadItem.dblclick();
    const input = threadItem.locator("input[type='text']");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("double-click updates thread title", async ({ page }) => {
    const threadItem = page.locator("[data-testid='thread-item']").first();
    await threadItem.dblclick();
    const input = threadItem.locator("input[type='text']");
    await input.clear();
    await input.fill("Renamed Thread");
    await input.press("Enter");
    const newTitle = await threadItem.locator("[data-testid='thread-title']").textContent();
    expect(newTitle).toBe("Renamed Thread");
  });

  test("Escape cancels edit without saving", async ({ page }) => {
    const threadItem = page.locator("[data-testid='thread-item']").first();
    const originalTitle = await threadItem.locator("[data-testid='thread-title']").textContent();
    await threadItem.dblclick();
    const input = threadItem.locator("input[type='text']");
    await input.press("Escape");
    const currentTitle = await threadItem.locator("[data-testid='thread-title']").textContent();
    expect(currentTitle).toBe(originalTitle);
  });
});
