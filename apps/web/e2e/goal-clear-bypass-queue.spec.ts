import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Regression spec for the `/goal clear` queue-deadlock fix.
 *
 * Background: when a goal is active, the Claude provider's Stop hook keeps
 * the agent's turn open until the goal is met. The composer was enqueueing
 * every message while `isAgentRunning` was true, so `/goal clear` sat in
 * the queue forever because `session.turnComplete` (which drains the queue)
 * could never fire while the goal was blocking the turn. The fix routes
 * `/goal` control forms directly to `sendMessage` even mid-turn so the
 * server intercept can clear the goal synchronously.
 *
 * This spec asserts both halves of the new routing rule:
 *   1. `/goal clear` typed while the agent is running dispatches via
 *      `agent.send` (bypass) and does NOT appear in the queue.
 *   2. A non-control message typed under the same conditions still
 *      enqueues (so we don't regress the original queue behavior).
 */

const MOCK_SETTINGS = getDefaultSettings();

const WORKSPACE = {
  id: "ws-goal-clear-bypass",
  name: "Goal Clear Bypass",
  path: "/tmp/goal-clear-bypass",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-goal-clear-bypass",
  workspace_id: WORKSPACE.id,
  title: "Goal-blocked thread",
  status: "active" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: "claude-sonnet-4-6",
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

async function setupChat(page: Page, running: boolean): Promise<void> {
  await page.evaluate(
    ({ ws, th, run }) => {
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threadStore = stores.find((s: any) => {
        const st = s.getState();
        return "runningThreadIds" in st && "contextByThread" in st;
      });
      if (threadStore && run) {
        threadStore.setState({
          runningThreadIds: new Set([th.id]),
        });
      }
    },
    { ws: WORKSPACE, th: THREAD, run: running },
  );
}

async function readQueueLength(page: Page, threadId: string): Promise<number> {
  return page.evaluate((tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores: any[] = (window as any).__mcodeStores ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queueStore = stores.find((s: any) => {
      const st = s.getState();
      return "queues" in st && "enqueue" in st;
    });
    if (!queueStore) return -1;
    const queues = queueStore.getState().queues as Record<string, unknown[]>;
    return (queues[tid] ?? []).length;
  }, threadId);
}

test.describe("/goal control commands bypass the composer queue", () => {
  test("`/goal clear` mid-turn dispatches via agent.send and never enters the queue", async ({
    page,
  }) => {
    const sentMessages: string[] = [];
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "provider.listModels": () => [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
      ],
      "agent.send": (params?: unknown) => {
        const p = params as { content?: string } | undefined;
        if (typeof p?.content === "string") sentMessages.push(p.content);
        return { ok: true };
      },
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
    );
    await setupChat(page, true);
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    // Typing the bare `/` would open the slash-command popup and route the
    // subsequent Enter to its key handler (selecting an item, not submitting).
    // Type the full string in one go via fill() so the popup never opens with
    // a partial trigger - by the time the editor sees the value, the text
    // does not match the trailing-`/\S*` regex anymore (it ends in `clear`).
    await editor.fill("/goal clear");
    await page.keyboard.press("Enter");

    await expect.poll(() => sentMessages, { timeout: 5_000 }).toContain(
      "/goal clear",
    );
    expect(await readQueueLength(page, THREAD.id)).toBe(0);
  });

  test("a normal message still enqueues after a `/goal clear` is sent mid-turn", async ({
    page,
  }) => {
    // AC2 (#583): issuing a control command mid-turn must not disturb queue
    // coordination. After `/goal clear` bypasses the queue, the thread is still
    // running, so the next normal message must enqueue (not slip out directly
    // and collide with the live turn).
    const sentMessages: string[] = [];
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "provider.listModels": () => [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
      ],
      "agent.send": (params?: unknown) => {
        const p = params as { content?: string } | undefined;
        if (typeof p?.content === "string") sentMessages.push(p.content);
        return { ok: true };
      },
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
    );
    await setupChat(page, true);
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await editor.fill("/goal clear");
    await page.keyboard.press("Enter");

    await expect.poll(() => sentMessages, { timeout: 5_000 }).toContain(
      "/goal clear",
    );

    await editor.click();
    await page.keyboard.type("now ship the feature");
    await page.keyboard.press("Enter");

    await expect.poll(() => readQueueLength(page, THREAD.id), { timeout: 5_000 })
      .toBe(1);
    expect(sentMessages).not.toContain("now ship the feature");
  });

  test("non-control messages still enqueue while the agent is running", async ({
    page,
  }) => {
    const sentMessages: string[] = [];
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "provider.listModels": () => [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
      ],
      "agent.send": (params?: unknown) => {
        const p = params as { content?: string } | undefined;
        if (typeof p?.content === "string") sentMessages.push(p.content);
        return { ok: true };
      },
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
    );
    await setupChat(page, true);
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.type("ship the feature");
    await page.keyboard.press("Enter");

    await expect.poll(() => readQueueLength(page, THREAD.id), { timeout: 5_000 })
      .toBe(1);
    expect(sentMessages).not.toContain("ship the feature");
  });
});
