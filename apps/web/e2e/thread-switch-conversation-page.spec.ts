import { test, expect } from "@playwright/test";
import {
  interceptZustandStores,
  mockWebSocketServer,
} from "./helpers/e2e-helpers";

type RpcCall = { method: string; params: unknown };

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();

const workspace = {
  id: "ws-conversation-page",
  name: "Conversation Page Workspace",
  path: "/tmp/conversation-page",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

function thread(id: string, title: string) {
  return {
    id,
    workspace_id: workspace.id,
    title,
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
}

function message(threadId: string, id: string, role: "user" | "assistant", content: string, sequence: number) {
  return {
    id,
    thread_id: threadId,
    role,
    content,
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

test("thread switch cache miss hydrates messages and narrative through conversation.page", async ({ page }) => {
  const calls: RpcCall[] = [];
  const threads = [
    thread("thread-a", "Thread A"),
    thread("thread-b", "Thread B"),
  ];
  const messagesByThread = {
    "thread-a": [
      message("thread-a", "thread-a-user", "user", "Alpha request", 1),
      message("thread-a", "thread-a-assistant", "assistant", "Alpha response", 2),
    ],
    "thread-b": [
      message("thread-b", "thread-b-user", "user", "Beta request", 1),
      message("thread-b", "thread-b-assistant", "assistant", "Beta response", 2),
    ],
  };

  await interceptZustandStores(page);
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": threads,
    "conversation.page": (params) => {
      calls.push({ method: "conversation.page", params });
      const threadId = (params as { threadId?: keyof typeof messagesByThread } | undefined)?.threadId;
      const messages = threadId ? messagesByThread[threadId] : [];
      return {
        messages,
        hasMore: false,
        answeredPlanMessageIds: [],
        narrativeByMessage: threadId
          ? {
              [`${threadId}-assistant`]: {
                tools: [],
                thoughts: [],
                hooks: [],
              },
            }
          : {},
      };
    },
    "message.list": (params) => {
      calls.push({ method: "message.list", params });
      return { messages: [], hasMore: false, answeredPlanMessageIds: [] };
    },
    "turn.load": (params) => {
      calls.push({ method: "turn.load", params });
      return [];
    },
    "narrative.list": (params) => {
      calls.push({ method: "narrative.list", params });
      return [];
    },
  });

  await page.goto("/");
  await page.getByRole("option", { name: /Conversation Page Workspace/ }).click();
  await page.getByRole("button", { name: /Conversation Page Workspace 2/ }).click();
  await page.waitForSelector("[data-testid='thread-item']");

  const threadItems = page.locator("[data-testid='thread-item']");
  await threadItems.nth(0).click();
  await expect.poll(
    () => calls.filter((call) => call.method === "conversation.page" && (call.params as { threadId?: string }).threadId === "thread-a").length,
  ).toBe(1);
  await expect(page.locator("[data-testid=message-list]")).toContainText("Alpha response");

  await page.evaluate(() => {
    const stores: Array<{ getState: () => Record<string, unknown>; subscribe: (fn: (state: Record<string, unknown>) => void) => () => void }> =
      (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown>; subscribe: (fn: (state: Record<string, unknown>) => void) => () => void }> }).__mcodeStores ?? [];
    const store = stores.find((candidate) => {
      const state = candidate.getState();
      return "handleAgentEvent" in state && "records" in state;
    });
    if (!store) throw new Error("Thread store not found");

    (window as unknown as { __conversationPageSnapshots?: Array<{ messages: number; hasNarrative: boolean }> }).__conversationPageSnapshots = [];
    store.subscribe((state) => {
      if (state.currentThreadId !== "thread-b") return;
      const record = (state.records as Map<string, { messages?: unknown[]; narrativeByMessage?: Record<string, unknown> }>).get("thread-b");
      (window as unknown as { __conversationPageSnapshots: Array<{ messages: number; hasNarrative: boolean }> }).__conversationPageSnapshots.push({
        messages: record?.messages?.length ?? 0,
        hasNarrative: Boolean(record?.narrativeByMessage?.["thread-b-assistant"]),
      });
    });
  });

  await threadItems.nth(1).click();
  await expect(page.locator("[data-testid=message-list]")).toContainText("Beta response");

  const state = await page.evaluate(() => {
    const stores: Array<{ getState: () => Record<string, unknown> }> =
      (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> }).__mcodeStores ?? [];
    const store = stores.find((candidate) => {
      const current = candidate.getState();
      return "handleAgentEvent" in current && "records" in current;
    });
    const current = store?.getState();
    const record = (current?.records as Map<string, { messages?: unknown[]; narrativeByMessage?: Record<string, unknown> }> | undefined)?.get("thread-b");
    const snapshots = (window as unknown as { __conversationPageSnapshots?: Array<{ messages: number; hasNarrative: boolean }> }).__conversationPageSnapshots ?? [];
    return {
      messages: record?.messages?.length ?? 0,
      hasNarrative: Boolean(record?.narrativeByMessage?.["thread-b-assistant"]),
      partialPaints: snapshots.filter((snapshot) => snapshot.messages > 0 && !snapshot.hasNarrative).length,
    };
  });

  expect(state).toEqual({ messages: 2, hasNarrative: true, partialPaints: 0 });
  expect(calls.filter((call) => call.method === "conversation.page" && (call.params as { threadId?: string }).threadId === "thread-b")).toHaveLength(1);
  expect(calls.filter((call) => call.method === "message.list" || call.method === "turn.load" || call.method === "narrative.list")).toHaveLength(0);
});
