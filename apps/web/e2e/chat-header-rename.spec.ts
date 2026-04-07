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
  const thread1 = {
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
  };
  const thread2 = {
    id: "thread-2",
    workspace_id: "ws-1",
    title: "Another Thread",
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
      else if (method === "thread.list") result = [thread1, thread2];
      else if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
}

test.describe("Chat Header Thread Rename", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-item']");
    // Navigate to a thread (wait for 250ms delay)
    await page.locator("[data-testid='thread-item']").first().click();
    await page.waitForSelector("[data-testid='chat-header-title']");
  });

  test("double-click on thread title in chat header enters edit mode", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    await titleDiv.dblclick();
    const input = page.locator("[data-testid='chat-header-title-input']");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test("double-click updates thread title", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    await titleDiv.dblclick();
    const input = page.locator("[data-testid='chat-header-title-input']");
    await input.clear();
    await input.fill("Updated Title");
    await input.press("Enter");
    // Wait for re-render
    await page.waitForSelector("[data-testid='chat-header-title']");
    await expect(page.locator("[data-testid='chat-header-title']")).toContainText("Updated Title");
  });

  test("Escape cancels edit without saving", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    const originalTitle = await titleDiv.locator("span").textContent();
    await titleDiv.dblclick();
    const input = page.locator("[data-testid='chat-header-title-input']");
    await input.press("Escape");
    await expect(input).not.toBeVisible();
    const currentTitle = await titleDiv.locator("span").textContent();
    expect(currentTitle).toBe(originalTitle);
  });

  test("edit mode closes when switching to a different thread", async ({ page }) => {
    const titleDiv = page.locator("[data-testid='chat-header-title']");
    await titleDiv.dblclick();
    await expect(page.locator("[data-testid='chat-header-title-input']")).toBeVisible();
    // Click on another thread
    const secondThread = page.locator("[data-testid='thread-item']").nth(1);
    await secondThread.click();
    await page.waitForSelector("[data-testid='chat-header-title']");
    // Edit input should be gone
    await expect(page.locator("[data-testid='chat-header-title-input']")).not.toBeVisible();
  });
});
