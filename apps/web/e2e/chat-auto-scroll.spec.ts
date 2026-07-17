import { expect, test, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();

const workspace = {
  id: "ws-chat-auto-scroll",
  name: "Chat Auto Scroll",
  path: "/tmp/chat-auto-scroll",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

const thread = {
  id: "thread-chat-auto-scroll",
  workspace_id: workspace.id,
  title: "Chat auto scroll",
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

function message(sequence: number, role: "user" | "assistant") {
  return {
    id: `${role}-${sequence}`,
    thread_id: thread.id,
    role,
    content: `${role} message ${sequence}\n${"A full line of transcript content. ".repeat(12)}`,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: now,
    sequence,
    attachments: null,
    tool_call_count: 0,
  };
}

const history = Array.from({ length: 24 }, (_, index) =>
  message(index + 1, index % 2 === 0 ? "user" : "assistant"),
);

async function distanceFromBottom(page: Page): Promise<number> {
  return page.locator("[data-testid='message-list'] .overflow-y-auto").evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

test("follows a sent message and streaming response until the user scrolls away", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const ws = await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [thread],
    "conversation.page": {
      messages: history,
      hasMore: false,
      answeredPlanMessageIds: [],
      narrativeByMessage: {},
    },
    "narrative.list": { tools: [], thoughts: [], hooks: [] },
    "settings.get": getDefaultSettings(),
    "provider.listModels": () => [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
    ],
    "agent.send": { ok: true },
  });
  await page.goto("/");
  await page.getByRole("group", { name: "Chat Auto Scroll project" }).click();
  await page.locator("[data-testid='thread-item']").first().click();

  const scroller = page.locator("[data-testid='message-list'] .overflow-y-auto");
  await expect(scroller).toHaveCSS("opacity", "1");
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill(`Follow this message\n${"New user content. ".repeat(80)}`);
  await editor.press("Enter");
  await expect(page.locator("[data-message-role='user']").filter({ hasText: "Follow this message" }))
    .toBeVisible();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "textDelta",
    delta: `Streaming response\n${"Growing agent output. ".repeat(120)}`,
    isFinalResponse: true,
  });
  await expect(page.getByTestId("assistant-response-text").filter({ hasText: "Streaming response" }))
    .toBeVisible();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);

  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
    element.scrollTop = Math.max(0, element.scrollTop - 500);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
  await page.waitForTimeout(100);

  await ws.sendPush("agent.event", {
    threadId: thread.id,
    type: "textDelta",
    delta: `\n${"More agent output. ".repeat(80)}`,
    isFinalResponse: true,
  });
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(64);

  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("button", { name: "New messages below" }).click();
  await scroller.dispatchEvent("wheel", { deltaY: -100 });
  await page.waitForTimeout(250);
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
  await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(64);

  await page.getByRole("button", { name: "Scroll to bottom" }).click();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(2);
});
