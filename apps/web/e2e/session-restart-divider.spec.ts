import { test, expect } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
  seedActiveThread,
  activateThread,
  waitForActiveThreadLoaded,
  dispatchAgentEvent,
} from "./helpers/e2e-helpers";

/**
 * Visual verification tests for the "session restarted" divider in the chat UI.
 *
 * Strategy: Intercept the Vite pre-bundled zustand.js to inject a store
 * registry on window.__mcodeStores before the app boots. This allows the test
 * to call setState() on the workspace and thread stores to set up the desired
 * UI state without modifying any production code.
 *
 * Timing: After activating a thread via workspaceStore, ChatView's useEffect
 * calls loadMessages() which uses the mock transport to return []. We inject
 * messages AFTER loadMessages completes (loading becomes false).
 */

// ─── Test data ────────────────────────────────────────────────────────────────

const THREAD_ID = "test-thread-e2e-session";

const FAKE_WORKSPACE = {
  id: "ws-test-1",
  name: "Test Workspace",
  path: "/tmp/test",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const FAKE_THREAD: Thread = {
  id: THREAD_ID,
  workspace_id: "ws-test-1",
  title: "Session Restart Test",
  status: "active" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: null,
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

function makeMessage(
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
  sequence: number,
  offsetMs = 0
) {
  return {
    id,
    thread_id: THREAD_ID,
    role,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: role === "assistant" ? 42 : null,
    timestamp: new Date(Date.now() - offsetMs).toISOString(),
    sequence,
    attachments: null,
  };
}

/**
 * Activate a thread, wait for the app's `loadMessages` to settle, then inject
 * the desired messages via the shared {@link seedActiveThread} helper. Waiting
 * for the load to complete first prevents it from overwriting the injection.
 */
async function activateThreadAndInjectMessages(
  page: import("@playwright/test").Page,
  messages: ReturnType<typeof makeMessage>[]
): Promise<void> {
  await seedActiveThread(page, FAKE_WORKSPACE, FAKE_THREAD, messages);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Session Restart Divider", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("renders system divider between user and assistant messages", async ({
    page,
  }) => {
    await activateThreadAndInjectMessages(page, [
      makeMessage("m1", "user", "Hello, can you help me debug this code?", 1, 120000),
      makeMessage("m2", "assistant", "Sure! I can help you with that. Let me take a look.", 2, 60000),
      makeMessage(
        "m-sys",
        "system",
        "Session restarted. The agent no longer has context from earlier messages.",
        3,
        30000
      ),
      makeMessage("m3", "user", "What was I asking about?", 4, 0),
    ]);

    await page.waitForFunction(
      () => document.body.innerText.includes("Session restarted"),
      { timeout: 8000 }
    );

    // Assert the divider text is visible
    const dividerText = page.locator(
      "text=Session restarted. The agent no longer has context from earlier messages."
    );
    await expect(dividerText).toBeVisible();

    // Assert the divider structure: flex row with two horizontal lines flanking the text
    // The outer divider container has py-2 gap-3 (distinguishes from inner text flex row)
    const dividerContainer = page
      .locator("div.flex.items-center.gap-3.py-2")
      .filter({
        hasText: "Session restarted. The agent no longer has context from earlier messages.",
      })
      .first();
    await expect(dividerContainer).toBeVisible();

    // Verify the two horizontal lines (bg-border dividers)
    const hrLines = dividerContainer.locator("div.h-px.flex-1.bg-border");
    await expect(hrLines).toHaveCount(2);

    // Verify surrounding messages are rendered
    await expect(page.locator("text=Hello, can you help me debug this code?")).toBeVisible();
    await expect(page.locator("text=What was I asking about?")).toBeVisible();
    await expect(page.locator("text=Sure! I can help you with that.")).toBeVisible();

    // Capture screenshot
    await page.screenshot({
      path: "e2e/screenshots/session-restart-divider.png",
      fullPage: true,
    });
  });

  test("divider is vertically between surrounding messages", async ({ page }) => {
    await activateThreadAndInjectMessages(page, [
      makeMessage("m1", "assistant", "I was helping you debug your code.", 1, 90000),
      makeMessage(
        "m-sys",
        "system",
        "Session restarted. The agent no longer has context from earlier messages.",
        2,
        45000
      ),
      makeMessage("m2", "user", "Can you continue helping me?", 3, 0),
    ]);

    await page.waitForFunction(
      () => document.body.innerText.includes("Session restarted"),
      { timeout: 8000 }
    );

    const divider = page
      .locator("div.flex.items-center.gap-3.py-2")
      .filter({
        hasText: "Session restarted. The agent no longer has context from earlier messages.",
      })
      .first();
    const assistantMsg = page.locator("text=I was helping you debug your code.").first();
    const userMsg = page.locator("text=Can you continue helping me?").first();

    await expect(divider).toBeVisible();
    await expect(assistantMsg).toBeVisible();
    await expect(userMsg).toBeVisible();

    const dividerBox = await divider.boundingBox();
    const assistantBox = await assistantMsg.boundingBox();
    const userBox = await userMsg.boundingBox();

    expect(dividerBox).not.toBeNull();
    expect(assistantBox).not.toBeNull();
    expect(userBox).not.toBeNull();

    if (dividerBox && assistantBox && userBox) {
      // Divider should appear below the assistant message
      expect(dividerBox.y).toBeGreaterThan(assistantBox.y);
      // Divider should appear above the user message (with some tolerance)
      expect(dividerBox.y + dividerBox.height).toBeLessThan(userBox.y + 20);
    }

    await page.screenshot({
      path: "e2e/screenshots/session-restart-divider-between-messages.png",
      fullPage: true,
    });
  });

  test("handleAgentEvent session_restarted creates exactly one divider", async ({
    page,
  }) => {
    await activateThread(page, FAKE_WORKSPACE, FAKE_THREAD);
    await waitForActiveThreadLoaded(page);

    // Trigger the event via the production handleAgentEvent code path
    await dispatchAgentEvent(page, THREAD_ID, {
      method: "session.system",
      params: { subtype: "session_restarted" },
    });

    await page.waitForFunction(
      () => document.body.innerText.includes("Session restarted"),
      { timeout: 8000 }
    );

    const dividers = page
      .locator("div.flex.items-center.gap-3.py-2")
      .filter({
        hasText: "Session restarted. The agent no longer has context from earlier messages.",
      });
    await expect(dividers).toHaveCount(1);

    await page.screenshot({
      path: "e2e/screenshots/session-restart-single-divider.png",
      fullPage: true,
    });
  });

  test("multiple session restarts each render a separate divider", async ({
    page,
  }) => {
    await activateThread(page, FAKE_WORKSPACE, FAKE_THREAD);
    await waitForActiveThreadLoaded(page);

    // Fire two session.system events through the production reducer
    await dispatchAgentEvent(page, THREAD_ID, {
      method: "session.system",
      params: { subtype: "session_restarted" },
    });
    await dispatchAgentEvent(page, THREAD_ID, {
      method: "session.system",
      params: { subtype: "session_restarted" },
    });

    await page.waitForFunction(
      () => document.body.innerText.includes("Session restarted"),
      { timeout: 8000 }
    );

    const dividers = page
      .locator("div.flex.items-center.gap-3.py-2")
      .filter({
        hasText: "Session restarted. The agent no longer has context from earlier messages.",
      });
    await expect(dividers).toHaveCount(2); // two restarts = two dividers

    await page.screenshot({
      path: "e2e/screenshots/session-restart-multiple-dividers.png",
      fullPage: true,
    });
  });
});
