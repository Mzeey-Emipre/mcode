import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();

const workspace = {
  id: "ws-streaming-text",
  name: "Streaming Text Workspace",
  path: "/tmp/streaming-text",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const thread = {
  id: "thread-streaming-text",
  workspace_id: workspace.id,
  title: "Streaming Text",
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

const userMessage = {
  id: "user-streaming-text",
  thread_id: thread.id,
  role: "user" as const,
  content: "Show markdown while streaming",
  tool_calls: null,
  files_changed: null,
  cost_usd: null,
  tokens_used: null,
  timestamp: now,
  sequence: 1,
  attachments: null,
  tool_call_count: 0,
};

function transcriptMessage(index: number) {
  return {
    id: `history-message-${index}`,
    thread_id: thread.id,
    role: index % 2 === 0 ? "assistant" as const : "user" as const,
    content: `Historical transcript row ${index}. This row gives the scrollport enough height to stay scrollable during live follow.`,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: now,
    sequence: index,
    attachments: null,
    tool_call_count: 0,
  };
}

test("streaming assistant text uses plain text, then settled text uses markdown", async ({ page }) => {
  const ws = await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [thread],
    "conversation.page": {
      messages: [userMessage],
      hasMore: false,
      answeredPlanMessageIds: [],
      narrativeByMessage: {},
    },
    "narrative.list": { tools: [], thoughts: [], hooks: [] },
  });

  await page.goto("/");
  await page.getByRole("group", { name: "Streaming Text Workspace project" }).click();
  await page.waitForSelector("[data-testid='thread-item']");
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector("[data-testid=message-list]");

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "turnStarted",
  });
  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "textDelta",
    delta: "Hello **stream**",
    isFinalResponse: true,
  });

  const assistantText = page.locator("[data-testid='assistant-response-text']");
  await expect(assistantText).toHaveCount(1);
  await expect(assistantText).toContainText("Hello **stream**");

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "message",
    content: "Hello **stream**",
    messageId: "assistant-streaming-text",
    tokens: null,
  });

  await expect(assistantText).toHaveCount(1);
  await expect(assistantText).toContainText("Hello stream");
  await expect(assistantText).not.toContainText("Hello **stream**");
});

test("first streaming delta keeps the visible transcript pinned without flashing scroll affordances", async ({ page }) => {
  const ws = await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [thread],
    "conversation.page": {
      messages: Array.from({ length: 24 }, (_, index) => transcriptMessage(index + 1)),
      hasMore: false,
      answeredPlanMessageIds: [],
      narrativeByMessage: {},
    },
    "narrative.list": { tools: [], thoughts: [], hooks: [] },
  });

  await page.goto("/");
  await page.getByRole("group", { name: "Streaming Text Workspace project" }).click();
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector("[data-testid=message-list]");

  await page.evaluate(async () => {
    const scrollport = document.querySelector("[data-testid='message-list'] .overflow-y-auto") as HTMLElement | null;
    if (!scrollport) throw new Error("message list scrollport not found");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scrollport.scrollTop = scrollport.scrollHeight;
  });

  await page.evaluate(() => {
    const samples: Array<{ distanceFromBottom: number; hasScrollAffordance: boolean }> = [];
    (window as unknown as { __streamingScrollSamples?: typeof samples }).__streamingScrollSamples = samples;
    const startedAt = performance.now();
    const sample = () => {
      const scrollport = document.querySelector("[data-testid='message-list'] .overflow-y-auto") as HTMLElement | null;
      const liveResponse = document.querySelector("[data-testid='assistant-response-text']");
      if (scrollport && liveResponse) {
        samples.push({
          distanceFromBottom: scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight,
          hasScrollAffordance: document.querySelector(
            "button[aria-label='Scroll to bottom'],button[aria-label='New messages below']",
          ) != null,
        });
      }
      if (performance.now() - startedAt < 250) {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  });

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "turnStarted",
  });
  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "textDelta",
    delta: "The first streamed assistant response should follow the tail immediately.",
    isFinalResponse: true,
  });

  await expect(page.locator("[data-testid='assistant-response-text']").last()).toContainText(
    "The first streamed assistant response",
  );
  await page.waitForTimeout(300);

  const samples = await page.evaluate(() =>
    (window as unknown as {
      __streamingScrollSamples?: Array<{ distanceFromBottom: number; hasScrollAffordance: boolean }>;
    }).__streamingScrollSamples ?? [],
  );
  expect(samples.length).toBeGreaterThan(0);
  expect(Math.max(...samples.map((sample) => sample.distanceFromBottom))).toBeLessThanOrEqual(4);
  expect(samples.some((sample) => sample.hasScrollAffordance)).toBe(false);
});
