import { expect, test, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import {
  interceptZustandStores,
  mockWebSocketServer,
} from "./helpers/e2e-helpers";

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  test.use({
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  });
}

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();

const workspace = {
  id: "ws-crash-reconnect",
  name: "Crash Reconnect",
  path: "/tmp/crash-reconnect",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

const thread = {
  id: "thread-crash-reconnect",
  workspace_id: workspace.id,
  title: "Crash recovery thread",
  status: "active" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: now,
  updated_at: now,
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

const firstUserMessage = {
  id: "user-first-turn",
  thread_id: thread.id,
  role: "user" as const,
  content: "first turn",
  tool_calls: null,
  files_changed: null,
  cost_usd: null,
  tokens_used: null,
  timestamp: now,
  sequence: 1,
  attachments: null,
  tool_call_count: 0,
};

async function openThread(page: Page, sentMessages: string[] = []) {
  const ws = await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [thread],
    "conversation.page": {
      messages: [firstUserMessage],
      hasMore: false,
      answeredPlanMessageIds: [],
      narrativeByMessage: {},
    },
    "narrative.list": { tools: [], thoughts: [], hooks: [] },
    "settings.get": getDefaultSettings(),
    "provider.listModels": () => [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
    ],
    "agent.send": (params?: unknown) => {
      const payload = params as { content?: string } | undefined;
      if (typeof payload?.content === "string") sentMessages.push(payload.content);
      return { ok: true };
    },
  });
  await interceptZustandStores(page);

  await page.goto("/");
  await page.getByRole("group", { name: "Crash Reconnect project" }).click();
  await page.waitForSelector("[data-testid='thread-item']", { timeout: 30_000 });
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector("[data-testid='message-list']", { timeout: 30_000 });
  await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
  return ws;
}

async function hydrateRunningThreads(page: Page, ids: string[]) {
  await page.evaluate((runningIds) => {
    const stores: Array<{ getState: () => Record<string, unknown> }> =
      (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
        .__mcodeStores ?? [];
    const threadStore = stores.find((store) => {
      const state = store.getState();
      return "hydrateRunningThreads" in state && "records" in state;
    });
    const state = threadStore?.getState() as
      | { hydrateRunningThreads: (threadIds: string[]) => void }
      | undefined;
    if (!state) throw new Error("thread store not found");
    state.hydrateRunningThreads(runningIds);
  }, ids);
}

async function readQueueLength(page: Page) {
  return page.evaluate((threadId) => {
    const stores: Array<{ getState: () => Record<string, unknown> }> =
      (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
        .__mcodeStores ?? [];
    const queueStore = stores.find((store) => {
      const state = store.getState();
      return "queues" in state && "enqueue" in state;
    });
    const queues = queueStore?.getState().queues as Record<string, unknown[]> | undefined;
    return queues?.[threadId]?.length ?? 0;
  }, thread.id);
}

test("rendered app clears stale text, queues follow-up, and avoids duplicate user bubbles", async ({
  page,
}) => {
  const sentMessages: string[] = [];
  const ws = await openThread(page, sentMessages);

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "turnStarted",
  });
  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "textDelta",
    delta: "old crash narrative",
    isFinalResponse: false,
  });

  await expect(page.getByText("old crash narrative")).toBeVisible();
  await hydrateRunningThreads(page, []);
  await page.waitForTimeout(100);
  await expect(page.getByText("old crash narrative")).toHaveCount(0);

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "turnStarted",
  });
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type("what happened?");
  await page.keyboard.press("Enter");

  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toBeVisible();
  await expect(queue.getByText("what happened?")).toBeVisible();
  await expect(page.locator("[data-message-role='user']").filter({ hasText: "what happened?" }))
    .toHaveCount(0);
  expect(sentMessages).not.toContain("what happened?");

  await page.screenshot({
    path: "e2e/screenshots/crash-reconnect-ui-queue.png",
    fullPage: false,
  });
});

test("rendered composer sends goal control commands while active without queueing", async ({
  page,
}) => {
  const sentMessages: string[] = [];
  const ws = await openThread(page, sentMessages);

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "turnStarted",
  });

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.fill("/goal clear");
  await page.keyboard.press("Enter");

  await expect.poll(() => sentMessages, { timeout: 5_000 }).toContain("/goal clear");
  expect(await readQueueLength(page)).toBe(0);
});
