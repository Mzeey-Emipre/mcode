import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

interface CiMockController {
  /** RPC method name -> invocation count, accumulated across reconnects. */
  methodCalls: Map<string, number>;
  /** Close the latest connection to force the client's reconnect loop. */
  forceReconnect: () => Promise<void>;
  /** Emit a thread.checksUpdated push on the latest connection. */
  pushChecks: (threadId: string, checks: unknown) => Promise<void>;
}

async function mockCiServer(page: Page): Promise<CiMockController> {
  const now = new Date().toISOString();
  const workspace = {
    id: "ws-1",
    name: "Test Workspace",
    path: "/test/path",
    provider_config: {},
    is_git_repo: true,
    pinned: false,
    last_opened_at: null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  const thread = {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "PR Thread",
    status: "active" as const,
    mode: "direct" as const,
    worktree_path: null,
    branch: "main",
    worktree_managed: false,
    issue_number: null,
    pr_number: 42,
    pr_status: "open",
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

  const methodCalls = new Map<string, number>();
  let activeWs: WebSocketRoute | null = null;

  await page.routeWebSocket(/ws:\/\/localhost:\d{5}/, (ws) => {
    activeWs = ws;
    ws.onMessage((data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const method = msg.method as string;
      methodCalls.set(method, (methodCalls.get(method) ?? 0) + 1);

      let result: unknown = null;
      if (method === "workspace.list") result = [workspace];
      else if (method === "thread.list") result = [thread];
      else if (method === "settings.get") result = getDefaultSettings();
      else if (method === "providers.listAvailability") {
        // Empty availability list keeps the sidebar from crashing on a null result.
        result = [];
      }
      else if (method?.endsWith(".list") || method === "provider.listModels") result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "agent.listRunning") result = [];
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      else if (method === "github.checkStatus") {
        // Surface any unexpected fan-out as a populated reply rather than an
        // error, so the assertion on methodCalls is the failure signal.
        result = { aggregate: "no_checks", runs: [], fetchedAt: Date.now() };
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  return {
    methodCalls,
    forceReconnect: async () => {
      // Closing from the route side terminates the client's WebSocket and
      // triggers the exponential backoff reconnect loop in ws-transport.
      activeWs?.close();
    },
    pushChecks: async (threadId, checks) => {
      if (!activeWs) throw new Error("No active WS connection");
      activeWs.send(
        JSON.stringify({
          type: "push",
          channel: "thread.checksUpdated",
          data: { threadId, checks },
        }),
      );
    },
  };
}

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete === true,
  );
}

test.describe("ci reconnect no fan-out", () => {
  test("reconnect does not fire github.checkStatus", async ({ page }) => {
    const ctrl = await mockCiServer(page);
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-list']");
    await waitForHydration(page);

    // Let any deferred async chains settle (dynamic imports, store subscriptions).
    await page.waitForTimeout(1000);

    const beforeReconnect = ctrl.methodCalls.get("github.checkStatus") ?? 0;

    // Verify push path works before reconnect
    await ctrl.pushChecks("thread-1", {
      aggregate: "failing",
      runs: [
        { name: "test-job", status: "completed", conclusion: "failure", durationMs: 5000, startedAt: new Date().toISOString() },
      ],
      fetchedAt: Date.now(),
    });
    await page.waitForTimeout(500); // Let store update

    // Reset the hydration sentinel so we can wait for the next reconnect cycle.
    await page.evaluate(() => {
      (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete = false;
    });

    await ctrl.forceReconnect();
    await waitForHydration(page);
    await page.waitForTimeout(1000);

    // Verify push path still works after reconnect
    await ctrl.pushChecks("thread-1", {
      aggregate: "passing",
      runs: [
        { name: "test-job", status: "completed", conclusion: "success", durationMs: 3000, startedAt: new Date().toISOString() },
      ],
      fetchedAt: Date.now(),
    });
    await page.waitForTimeout(500); // Let store update

    const afterReconnect = ctrl.methodCalls.get("github.checkStatus") ?? 0;

    // After removing the client-side CI fan-out, no reconnect should trigger
    // github.checkStatus. This is a regression guard.
    expect(afterReconnect).toBe(beforeReconnect);
  });
});
