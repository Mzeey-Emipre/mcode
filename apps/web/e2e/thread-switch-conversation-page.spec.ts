import { test, expect, type Page } from "@playwright/test";
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

async function readThreadRecord(page: Page, threadId: string) {
  return page.evaluate((targetThreadId) => {
    type StoreHandle = { getState: () => Record<string, unknown> };
    type RecordProbe = {
      loading?: boolean;
      messages?: Array<{ id: string; sequence: number }>;
      toolCalls?: Array<{ id: string }>;
      goal?: { objective?: string } | null;
    };
    const stores = (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const store = stores.find((candidate) => {
      const state = candidate.getState();
      return "handleAgentEvent" in state && "records" in state;
    });
    const state = store?.getState();
    const record = (state?.records as Map<string, RecordProbe> | undefined)?.get(targetThreadId);
    return {
      currentThreadId: state?.currentThreadId ?? null,
      loading: record?.loading ?? null,
      messageIds: record?.messages?.map((entry) => entry.id) ?? [],
      messageSequences: record?.messages?.map((entry) => entry.sequence) ?? [],
      toolCallIds: record?.toolCalls?.map((entry) => entry.id) ?? [],
      goalObjective: record?.goal?.objective ?? null,
    };
  }, threadId);
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
  await page.getByRole("group", { name: "Conversation Page Workspace project" }).click();
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

test("rapid reselection paints the tail before auxiliary thread data resolves", async ({ page }) => {
  test.setTimeout(90_000);
  let resolveThreadA!: () => void;
  let resolveThreadB!: () => void;
  let resolveSnapshots!: () => void;
  let resolveGoal!: () => void;
  const threads = [
    thread("thread-a", "Thread A"),
    thread("thread-b", "Thread B"),
  ];

  await interceptZustandStores(page);
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": threads,
    "conversation.page": (params) => {
      const input = params as { threadId: string };
      const result = {
        messages: input.threadId === "thread-a"
          ? [message("thread-a", "thread-a-tail", "assistant", "Alpha tail after reselection", 12)]
          : [message("thread-b", "thread-b-tail", "assistant", "Beta tail", 12)],
        hasMore: false,
        answeredPlanMessageIds: [],
        narrativeByMessage: {},
      };
      return new Promise((resolve) => {
        const release = () => resolve(result);
        if (input.threadId === "thread-a") resolveThreadA = release;
        else resolveThreadB = release;
      });
    },
    "snapshot.listByThread": (params) => {
      const input = params as { threadId: string };
      if (input.threadId !== "thread-a") return [];
      return new Promise((resolve) => {
        resolveSnapshots = () => resolve([]);
      });
    },
    "thread.goal.get": (params) => {
      const input = params as { threadId: string };
      const result = {
        goal: input.threadId === "thread-a"
          ? {
              threadId: "thread-a",
              objective: "Alpha reselection settled",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
              providerId: "codex",
              source: "codex",
              controls: { canInspect: true, canClear: true },
            }
          : null,
        authoritative: false,
        source: "codex-cache",
        reason: "not-materialized",
      };
      if (input.threadId !== "thread-a") return result;
      return new Promise((resolve) => {
        resolveGoal = () => resolve(result);
      });
    },
  });

  await page.goto("/");
  await page.getByRole("group", { name: "Conversation Page Workspace project" }).click();
  await page.waitForSelector("[data-testid='thread-item']");
  const threadItems = page.locator("[data-testid='thread-item']");

  await threadItems.nth(0).click();
  await expect.poll(() => typeof resolveThreadA).toBe("function");
  await threadItems.nth(1).click();
  await expect.poll(() => typeof resolveThreadB).toBe("function");
  await threadItems.nth(0).click();

  await expect(page.locator("[data-testid=chat-header-title]")).toContainText("Thread A");
  await expect(page.locator("[data-testid=conversation-loading]")).toBeVisible();
  resolveThreadA();
  await expect(page.getByText("Alpha tail after reselection", { exact: true })).toBeVisible();
  expect(typeof resolveSnapshots).toBe("function");
  expect(typeof resolveGoal).toBe("function");

  resolveThreadB();
  resolveSnapshots();
  resolveGoal();
  await expect.poll(() => readThreadRecord(page, "thread-a")).toEqual({
    currentThreadId: "thread-a",
    loading: false,
    messageIds: ["thread-a-tail"],
    messageSequences: [12],
    toolCallIds: [],
    goalObjective: "Alpha reselection settled",
  });
  await expect(page.locator("[data-testid=chat-header-title]")).toContainText("Thread A");
  await expect(page.getByText("Alpha tail after reselection", { exact: true })).toBeVisible();
  await expect(page.getByText("Beta tail", { exact: true })).not.toBeVisible();
});

test("thread switch paints the latest turn before older history finishes", async ({ page }) => {
  test.setTimeout(90_000);
  const calls: RpcCall[] = [];
  let resolveTail: (() => void) | undefined;
  let resolveOlderHistory: (() => void) | undefined;
  const threads = [
    thread("thread-a", "Thread A"),
    thread("thread-b", "Thread B"),
  ];
  const threadAMessages = [
    message("thread-a", "thread-a-user", "user", "Alpha request", 1),
    message("thread-a", "thread-a-assistant", "assistant", "Alpha response", 2),
  ];
  const threadBMessages = Array.from({ length: 120 }, (_, index) => {
    const sequence = index + 1;
    return message(
      "thread-b",
      `thread-b-${sequence}`,
      sequence % 2 === 0 ? "assistant" : "user",
      sequence === 120 ? "Latest beta response" : `Beta message ${sequence}`,
      sequence,
    );
  });

  await interceptZustandStores(page);
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": threads,
    "conversation.page": (params) => {
      const input = params as { threadId: string; limit: number; before?: number };
      calls.push({ method: "conversation.page", params: input });
      const source = input.threadId === "thread-b" ? threadBMessages : threadAMessages;
      const eligible = input.before == null
        ? source
        : source.filter((entry) => entry.sequence < input.before!);
      const messages = eligible.slice(-input.limit);
      const result = {
        messages,
        hasMore: eligible.length > messages.length,
        answeredPlanMessageIds: [],
        narrativeByMessage: {},
      };
      if (input.threadId !== "thread-b") return result;
      return new Promise((resolve) => {
        const release = () => resolve(result);
        if (input.before == null) resolveTail = release;
        else resolveOlderHistory = release;
      });
    },
  });

  await page.goto("/");
  await page.getByRole("group", { name: "Conversation Page Workspace project" }).click();
  await page.waitForSelector("[data-testid='thread-item']");
  const threadItems = page.locator("[data-testid='thread-item']");
  await threadItems.nth(0).click();
  await expect(page.locator("[data-testid=message-list]")).toContainText("Alpha response");

  const loadingObserved = page.evaluate(() => new Promise<boolean>((resolve) => {
    if (document.querySelector("[data-testid='conversation-loading']")) {
      resolve(true);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!document.querySelector("[data-testid='conversation-loading']")) return;
      observer.disconnect();
      resolve(true);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, 1000);
  }));
  await threadItems.nth(1).click();
  expect(await loadingObserved).toBe(true);
  await expect(page.locator("[data-testid=chat-header-title]")).toContainText("Thread B");
  await expect.poll(() => typeof resolveTail).toBe("function");
  resolveTail?.();
  await expect(page.getByText("Latest beta response", { exact: true })).toBeVisible();

  await expect.poll(() => calls.filter((call) =>
    call.method === "conversation.page"
    && (call.params as { threadId?: string }).threadId === "thread-b").length,
  { timeout: 3000 }).toBe(2);
  expect(typeof resolveOlderHistory).toBe("function");
  await expect(page.getByText("Latest beta response", { exact: true })).toBeVisible();
  const scrollContainer = page.locator("[data-testid=message-list] > div").first();
  const tailScrollHeight = await scrollContainer.evaluate((element) => element.scrollHeight);
  resolveOlderHistory?.();
  await expect.poll(() => readThreadRecord(page, "thread-b")).toEqual({
    currentThreadId: "thread-b",
    loading: false,
    messageIds: threadBMessages.slice(20).map((entry) => entry.id),
    messageSequences: Array.from({ length: 100 }, (_, index) => index + 21),
    toolCallIds: [],
    goalObjective: null,
  });
  await expect.poll(() => scrollContainer.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(tailScrollHeight);

  const threadBCalls = calls.filter((call) =>
    call.method === "conversation.page"
    && (call.params as { threadId?: string }).threadId === "thread-b");
  expect(threadBCalls).toHaveLength(2);
  expect(threadBCalls.map((call) => call.params)).toEqual([
    { threadId: "thread-b", limit: 12 },
    { threadId: "thread-b", limit: 88, before: 109 },
  ]);
});

test("thread switch shows a running agent before persisted history refreshes", async ({ page }) => {
  test.setTimeout(90_000);
  const calls: RpcCall[] = [];
  let resolveThreadBHistory: (() => void) | undefined;
  const threads = [
    thread("thread-a", "Thread A"),
    { ...thread("thread-b", "Thread B"), status: "active" as const },
  ];
  const threadAMessages = [
    message("thread-a", "thread-a-user", "user", "Alpha request", 1),
    message("thread-a", "thread-a-assistant", "assistant", "Alpha response", 2),
  ];

  await interceptZustandStores(page);
  const controller = await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": threads,
    "agent.listRunning": ["thread-b"],
    "push.subscribeThread": (params) => {
      calls.push({ method: "push.subscribeThread", params });
      return undefined;
    },
    "conversation.page": (params) => {
      const input = params as { threadId: string; limit: number; before?: number };
      calls.push({ method: "conversation.page", params: input });
      if (input.threadId === "thread-a") {
        return {
          messages: threadAMessages,
          hasMore: false,
          answeredPlanMessageIds: [],
          narrativeByMessage: {},
        };
      }
      return new Promise((resolve) => {
        resolveThreadBHistory = () => resolve({
          messages: [],
          hasMore: false,
          answeredPlanMessageIds: [],
          narrativeByMessage: {},
        });
      });
    },
  });

  await page.goto("/");
  await page.getByRole("group", { name: "Conversation Page Workspace project" }).click();
  await page.waitForSelector("[data-testid='thread-item']");
  const threadItems = page.locator("[data-testid='thread-item']");
  await threadItems.nth(0).click();
  await expect(page.locator("[data-testid=message-list]")).toContainText("Alpha response");

  await expect.poll(() => calls.some((call) =>
    call.method === "push.subscribeThread"
    && (call.params as { threadId?: string }).threadId === "thread-b"),
  ).toBe(true);
  await controller.sendPush("agent.event", {
    type: "toolUse",
    threadId: "thread-b",
    toolCallId: "thread-b-live-tool",
    toolName: "Bash",
    toolInput: { command: "echo live-switch" },
  });

  await threadItems.nth(1).click();
  await expect(page.locator("[data-testid=chat-header-title]")).toContainText("Thread B");
  await expect(page.getByRole("button", { name: "Running command echo live-switch" })).toBeVisible();
  expect(typeof resolveThreadBHistory).toBe("function");

  resolveThreadBHistory?.();
  await expect.poll(() => readThreadRecord(page, "thread-b")).toEqual({
    currentThreadId: "thread-b",
    loading: false,
    messageIds: [],
    messageSequences: [],
    toolCallIds: ["thread-b-live-tool"],
    goalObjective: null,
  });
  await expect(page.getByRole("button", { name: "Running command echo live-switch" })).toBeVisible();
});
