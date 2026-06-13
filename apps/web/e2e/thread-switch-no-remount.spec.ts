import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Regression: thread switching must not unmount/remount MessageList.
 * Verifies cached row heights survive (instant render, no opacity flash)
 * and scroll position is restored on cached thread return.
 *
 * Requires two seeded threads with messages — relies on mocking the
 * WebSocket server to respond with thread and message lists.
 */

/**
 * Mock the WebSocket server with workspace, threads, and messages.
 */
async function mockWebSocketServer(page: Page): Promise<void> {
  const now = new Date().toISOString();
  const workspace = {
    id: "ws-switch-test",
    name: "Test Workspace",
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
    workspace_id: "ws-switch-test",
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
  const threadB = {
    id: "thread-b",
    workspace_id: "ws-switch-test",
    title: "Thread B",
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

  // Generate 20 messages for scrollable content
  const messages = Array.from({ length: 20 }, (_, i) => ({
    id: `msg-a-${i}`,
    thread_id: "thread-a",
    type: "text" as const,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. `,
    sequence: i,
    attachment_ids: [],
    tool_calls: [],
    tool_results: [],
    reasoning: null,
    created_at: new Date(Date.now() + i * 1000).toISOString(),
    updated_at: new Date(Date.now() + i * 1000).toISOString(),
  }));

  const messageB = Array.from({ length: 20 }, (_, i) => ({
    id: `msg-b-${i}`,
    thread_id: "thread-b",
    type: "text" as const,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Thread B Message ${i + 1}: Sed do eiusmod tempor incididunt. `,
    sequence: i,
    attachment_ids: [],
    tool_calls: [],
    tool_results: [],
    reasoning: null,
    created_at: new Date(Date.now() + i * 1000).toISOString(),
    updated_at: new Date(Date.now() + i * 1000).toISOString(),
  }));

  await page.routeWebSocket(/ws:\/\/localhost/, (ws) => {
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
      else if (method === "thread.list") result = [threadA, threadB];
      else if (method === "message.list" || method === "conversation.page") {
        // Derive the response from the request payload so reordered or
        // concurrent requests can't cross-contaminate replies.
        const params = msg.params as Record<string, unknown> | undefined;
        const threadId = params?.threadId ?? params?.thread_id;
        let selected: typeof messages;
        if (threadId === "thread-b") {
          selected = messageB;
        } else if (threadId === "thread-a") {
          selected = messages;
        } else {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32602, message: `Unknown thread_id: ${String(threadId)}` },
            }),
          );
          return;
        }
        result = method === "conversation.page"
          ? {
              messages: selected,
              hasMore: false,
              answeredPlanMessageIds: [],
              narrativeByMessage: {},
            }
          : { messages: selected, hasMore: false, answeredPlanMessageIds: [] };
      } else if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "agent.listRunning") result = [];
      else if (method === "push.subscribeThread" || method === "push.unsubscribeThread") result = undefined;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      else if (method === "settings.get") result = getDefaultSettings();
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
}

test.describe("Thread switch — no MessageList remount", () => {
  test.beforeEach(async ({ page }) => {
    // Set up WebSocket mock with workspace and threads
    await mockWebSocketServer(page);

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Wait for thread items to appear in sidebar
    await page.waitForSelector("[data-testid='thread-item']");

    // Click on the first thread to select it
    await page.locator("[data-testid='thread-item']").first().click();

    // Wait for the message list to be visible
    await page.waitForSelector("[data-testid=message-list]");
  });

  test("scroll position restores on return to a cached thread", async ({
    page,
  }) => {
    // Find the scrollable container in the message list
    const scrollEl = page
      .locator("[data-testid=message-list] >> css=.overflow-y-auto")
      .first();
    await expect(scrollEl).toBeVisible();

    // Scroll to a non-bottom position (200px from top)
    await scrollEl.evaluate((el) => {
      (el as HTMLDivElement).scrollTop = 200;
    });
    const savedScrollTop = await scrollEl.evaluate(
      (el) => (el as HTMLDivElement).scrollTop,
    );
    expect(savedScrollTop).toBeGreaterThan(100);

    // Switch to thread B by clicking the second thread in sidebar
    const threadItems = page.locator("[data-testid='thread-item']");
    await threadItems.nth(1).click();

    // Wait for thread B's content to load
    await page.waitForFunction(() => {
      const text = document.querySelector("[data-testid=message-list]")?.textContent || "";
      return text.includes("Thread B Message") && text.length > 0;
    }, { timeout: 5000 });

    // Switch back to thread A
    await threadItems.nth(0).click();

    // Wait for thread A's content to load back
    await page.waitForFunction(() => {
      const text = document.querySelector("[data-testid=message-list]")?.textContent || "";
      return text.includes("Message") && !text.includes("Thread B");
    }, { timeout: 5000 });

    // Check that scroll position was restored
    const restored = await scrollEl.evaluate(
      (el) => (el as HTMLDivElement).scrollTop,
    );
    expect(Math.abs(restored - savedScrollTop)).toBeLessThan(20);
  });

  test("no opacity-0 flash when returning to a cached thread", async ({
    page,
  }) => {
    // Find the scrollable container
    const scrollEl = page
      .locator("[data-testid=message-list] >> css=.overflow-y-auto")
      .first();
    await expect(scrollEl).toBeVisible();

    // Switch to thread B by clicking the second thread in sidebar
    const threadItems = page.locator("[data-testid='thread-item']");
    await threadItems.nth(1).click();

    // Wait for thread B's content to load
    await page.waitForFunction(() => {
      const text = document.querySelector("[data-testid=message-list]")?.textContent || "";
      return text.includes("Thread B Message") && text.length > 0;
    }, { timeout: 5000 });

    // Switch back to thread A — cached return must skip the opacity flash
    await threadItems.nth(0).click();

    // Sample opacity multiple times over 100ms to ensure no flash occurs
    let hasFlash = false;
    for (let i = 0; i < 5; i++) {
      const opacity = await scrollEl.evaluate((el) =>
        Number(getComputedStyle(el as Element).opacity),
      );
      if (opacity < 1) {
        hasFlash = true;
        break;
      }
      await page.waitForTimeout(20);
    }
    expect(hasFlash).toBe(false);
  });
});
