import { test, expect } from "@playwright/test";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function interceptZustandStores(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.route("**/zustand.js*", async (route) => {
    const response = await route.fetch();
    const originalBody = await response.text();

    const patchedBody = originalBody.replace(
      'const api = {\n\t\tsetState,\n\t\tgetState,\n\t\tgetInitialState,\n\t\tsubscribe\n\t};',
      `const api = {
		setState,
		getState,
		getInitialState,
		subscribe
	};
	if (typeof window !== "undefined") {
		window.__mcodeStores = window.__mcodeStores || [];
		window.__mcodeStores.push(api);
	}`
    );

    await route.fulfill({
      status: response.status(),
      headers: Object.fromEntries(
        response.headersArray().map((h) => [h.name, h.value])
      ),
      body: patchedBody,
    });
  });
}

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

const FAKE_THREAD = {
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
  session_name: "test",
  pid: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: null,
  deleted_at: null,
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
 * Activate a thread and wait for the mock loadMessages() to complete (sets
 * loading: false), then inject the desired messages into the thread store.
 * This prevents the loadMessages useEffect from overwriting our injected state.
 */
async function activateThreadAndInjectMessages(
  page: import("@playwright/test").Page,
  messages: ReturnType<typeof makeMessage>[]
): Promise<void> {
  // Step 1: inject workspace/thread into workspace store to trigger ChatView mount
  await page.evaluate(
    ({ workspace, thread, threadId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) {
        console.error("[E2E] workspace store not found");
        return;
      }
      wsStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: threadId,
      });
    },
    { workspace: FAKE_WORKSPACE, thread: FAKE_THREAD, threadId: THREAD_ID }
  );

  // Step 2: wait for ChatView to mount and loadMessages to complete
  // loadMessages sets loading: false after the mock transport returns []
  await page.waitForFunction(
    () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const threadStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => "messages" in s.getState() && "loadMessages" in s.getState()
      );
      if (!threadStore) return false;
      const state = threadStore.getState();
      // Wait for the thread to be active and loading to be done
      return state.currentThreadId !== null && state.loading === false;
    },
    { timeout: 5000 }
  );

  // Step 3: now inject our messages - loadMessages is done so it won't overwrite
  await page.evaluate(
    ({ threadId, messages }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const threadStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => "messages" in s.getState() && "loadMessages" in s.getState()
      );
      if (!threadStore) {
        console.error("[E2E] thread store not found for message injection");
        return;
      }
      threadStore.setState({ messages, loading: false, error: null });
      console.log("[E2E] injected", messages.length, "messages");
    },
    { threadId: THREAD_ID, messages }
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Session Restart Divider", () => {
  test.beforeEach(async ({ page }) => {
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
    // Activate thread first (no messages)
    await page.evaluate(
      ({ workspace, thread, threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const wsStore = stores.find((s: any) => "activeThreadId" in s.getState() && "threads" in s.getState());
        if (!wsStore) return;
        wsStore.setState({
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          threads: [thread],
          activeThreadId: threadId,
        });
      },
      { workspace: FAKE_WORKSPACE, thread: FAKE_THREAD, threadId: THREAD_ID }
    );

    // Wait for loadMessages to complete
    await page.waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = stores.find((s: any) => "messages" in s.getState() && "loadMessages" in s.getState());
        return ts && ts.getState().loading === false && ts.getState().currentThreadId !== null;
      },
      { timeout: 5000 }
    );

    // Now trigger the event via the production handleAgentEvent code path
    await page.evaluate(({ threadId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threadStore = stores.find((s: any) => "messages" in s.getState() && "loadMessages" in s.getState());
      if (!threadStore) {
        console.error("[E2E] thread store not found");
        return;
      }
      const handleAgentEvent = threadStore.getState().handleAgentEvent;
      handleAgentEvent(threadId, {
        method: "session.system",
        params: { subtype: "session_restarted" },
      });
      console.log("[E2E] handleAgentEvent called, messages:", threadStore.getState().messages.length);
    }, { threadId: THREAD_ID });

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
    // Activate thread first
    await page.evaluate(
      ({ workspace, thread, threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const wsStore = stores.find((s: any) => "activeThreadId" in s.getState() && "threads" in s.getState());
        if (!wsStore) return;
        wsStore.setState({
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          threads: [thread],
          activeThreadId: threadId,
        });
      },
      { workspace: FAKE_WORKSPACE, thread: FAKE_THREAD, threadId: THREAD_ID }
    );

    await page.waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = stores.find((s: any) => "messages" in s.getState() && "loadMessages" in s.getState());
        return ts && ts.getState().loading === false && ts.getState().currentThreadId !== null;
      },
      { timeout: 5000 }
    );

    // Fire two session.system events
    await page.evaluate(({ threadId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threadStore = stores.find((s: any) => "messages" in s.getState() && "loadMessages" in s.getState());
      if (!threadStore) return;
      const handleAgentEvent = threadStore.getState().handleAgentEvent;
      handleAgentEvent(threadId, { method: "session.system", params: { subtype: "session_restarted" } });
      handleAgentEvent(threadId, { method: "session.system", params: { subtype: "session_restarted" } });
    }, { threadId: THREAD_ID });

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
