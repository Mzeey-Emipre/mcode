import { expect, test, type Page } from "@playwright/test";
import { interceptZustandStores, mockWebSocketServer } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-final-response",
  name: "Final Response",
  path: "/tmp/final-response",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

const THREAD = {
  id: "thread-final-response",
  workspace_id: WORKSPACE.id,
  title: "Final response continuity",
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

let serverMessages: Array<Record<string, unknown>>;

function userMessage() {
  return {
    id: "user-final-response",
    thread_id: THREAD.id,
    role: "user" as const,
    content: "Stream a final response",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: now,
    sequence: 1,
    attachments: null,
  };
}

function assistantMessage(content: string) {
  return {
    id: "assistant-persisted",
    thread_id: THREAD.id,
    role: "assistant" as const,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: 12,
    timestamp: now,
    sequence: 2,
    attachments: null,
  };
}

async function findStore(page: Page, keys: string[]) {
  return page.evaluate((expectedKeys) => {
    const stores: Array<{ getState: () => Record<string, unknown>; setState: (patch: unknown) => void }> =
      (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown>; setState: (patch: unknown) => void }> })
        .__mcodeStores ?? [];
    return stores.find((store) => {
      const state = store.getState();
      return expectedKeys.every((key) => key in state);
    }) != null;
  }, keys);
}

async function setupThread(page: Page, messages: Array<Record<string, unknown>> = [userMessage()]) {
  await page.evaluate(({ workspace, thread, seededMessages }) => {
    const stores: Array<{ getState: () => Record<string, unknown>; setState: (patch: unknown) => void }> =
      (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown>; setState: (patch: unknown) => void }> })
        .__mcodeStores ?? [];
    const workspaceStore = stores.find((store) => {
      const state = store.getState();
      return "workspaces" in state && "threads" in state;
    });
    const threadStore = stores.find((store) => {
      const state = store.getState();
      return "handleAgentEvent" in state && "records" in state;
    });
    if (!workspaceStore || !threadStore) throw new Error("stores not found");

    workspaceStore.setState({
      workspaces: [workspace],
      threads: [thread],
      activeWorkspaceId: workspace.id,
      activeThreadId: thread.id,
    });

    const records = new Map();
    records.set(thread.id, {
      messages: seededMessages,
      loading: false,
      oldestLoadedSequence: 1,
      hasMoreMessages: false,
      isLoadingMore: false,
      loadEpoch: 0,
      persistedToolCallCounts: {},
      persistedFilesChanged: {},
      latestTurnWithChanges: null,
      serverMessageIds: {},
      narrativeByMessage: {},
      answeredPlanMessageIds: new Set(),
      error: null,
      streaming: "",
      streamingPreview: "",
      toolCalls: [],
      currentTurnMessageId: "",
      currentTurnResponseKey: "",
      assistantResponseKeys: {},
      thoughtSegments: [],
      hooks: [],
      isCompacting: false,
      settings: { permissionMode: "full", interactionMode: "build" },
      usageByProvider: {},
      planQuestions: null,
      planAnswers: new Map(),
      activeQuestionIndex: 0,
      planQuestionsStatus: "idle",
      permissions: [],
      forkMode: null,
    });
    threadStore.setState({
      currentThreadId: thread.id,
      records,
      runningThreadIds: new Set(),
    });
  }, { workspace: WORKSPACE, thread: THREAD, seededMessages: messages });
}

test.describe("final response continuity", () => {
  test.beforeEach(async ({ page }) => {
    serverMessages = [userMessage()];
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "message.list": () => ({ messages: serverMessages, hasMore: false, answeredPlanMessageIds: [] }),
      "turn.load": [],
      "narrative.list": { tools: [], thoughts: [], hooks: [] },
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect.poll(() => findStore(page, ["handleAgentEvent", "records"])).toBe(true);
    await setupThread(page);
    await page.waitForSelector("[data-testid='message-list']");
  });

  test("keeps the response node and scroll position when streaming persists", async ({ page }) => {
    const finalText = [
      "Final answer that should keep the same DOM node.",
      "",
      "This paragraph is intentionally long enough to wrap across several visual lines in the transcript. It makes the streaming bubble reserve the height of the final markdown before the typewriter has caught up.",
      "",
      "- First visible item",
      "- Second visible item",
      "- Third visible item",
    ].join("\n");

    await page.evaluate(({ threadId }) => {
      const stores: Array<{ getState: () => Record<string, unknown> }> =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
          .__mcodeStores ?? [];
      const threadStore = stores.find((store) => {
        const state = store.getState();
        return "handleAgentEvent" in state && "records" in state;
      });
      const state = threadStore?.getState() as
        | { handleAgentEvent: (threadId: string, event: unknown) => void }
        | undefined;
      if (!state) throw new Error("thread store not found");
      state.handleAgentEvent(threadId, { method: "session.turnStarted", params: {} });
    }, { threadId: THREAD.id });

    await page.evaluate(({ threadId }) => {
      const stores: Array<{ getState: () => Record<string, unknown> }> =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
          .__mcodeStores ?? [];
      const threadStore = stores.find((store) => {
        const state = store.getState();
        return "handleAgentEvent" in state && "records" in state;
      });
      const state = threadStore?.getState() as
        | { handleAgentEvent: (threadId: string, event: unknown) => void }
        | undefined;
      if (!state) throw new Error("thread store not found");
      state.handleAgentEvent(threadId, {
        method: "session.textDelta",
        params: { delta: "Final answer", isFinalResponse: true },
      });
    }, { threadId: THREAD.id });

    const response = page.getByTestId("assistant-response-text").last();
    await expect(response).toContainText("Final answer");

    await page.evaluate(({ threadId, text }) => {
      const stores: Array<{ getState: () => Record<string, unknown> }> =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
          .__mcodeStores ?? [];
      const threadStore = stores.find((store) => {
        const state = store.getState();
        return "handleAgentEvent" in state && "records" in state;
      });
      const state = threadStore?.getState() as
        | { handleAgentEvent: (threadId: string, event: unknown) => void }
        | undefined;
      if (!state) throw new Error("thread store not found");
      state.handleAgentEvent(threadId, {
        method: "session.textDelta",
        params: { delta: text.slice("Final answer".length), isFinalResponse: true },
      });
    }, { threadId: THREAD.id, text: finalText });

    await expect(page.getByTestId("assistant-message-actions").last()).toHaveAttribute("aria-hidden", "true");

    const continuity = await response.evaluate((node) => {
      (window as unknown as { __finalResponseNode?: Element }).__finalResponseNode = node;
      const scroller = document.querySelector("[data-testid='message-list'] .overflow-y-auto") as HTMLElement | null;
      const nestedScrollableCount = Array.from(node.querySelectorAll<HTMLElement>("*")).filter((el) => {
        const style = getComputedStyle(el);
        const scrollsY = el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(style.overflowY);
        const scrollsX = el.scrollWidth > el.clientWidth && /(auto|scroll)/.test(style.overflowX);
        return scrollsY || scrollsX;
      }).length;
      return {
        height: node.getBoundingClientRect().height,
        nestedScrollableCount,
        scrollTop: scroller?.scrollTop ?? 0,
      };
    });

    await page.evaluate(({ threadId, text }) => {
      const stores: Array<{ getState: () => Record<string, unknown> }> =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
          .__mcodeStores ?? [];
      const threadStore = stores.find((store) => {
        const state = store.getState();
        return "handleAgentEvent" in state && "records" in state;
      });
      const state = threadStore?.getState() as
        | {
            handleAgentEvent: (threadId: string, event: unknown) => void;
            handleTurnPersisted: (payload: unknown) => void;
          }
        | undefined;
      if (!state) throw new Error("thread store not found");
      state.handleAgentEvent(threadId, {
        method: "session.message",
        params: { content: text, messageId: "assistant-persisted", tokens: 12 },
      });
      state.handleTurnPersisted({
        threadId,
        messageId: "assistant-persisted",
        toolCallCount: 0,
        filesChanged: [],
      });
    }, { threadId: THREAD.id, text: finalText });

    await expect(page.getByTestId("assistant-message-actions").last()).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("[data-message-id='assistant-persisted']")).toBeVisible();

    const result = await response.evaluate((node, beforeScrollTop) => {
      const win = window as unknown as { __finalResponseNode?: Element };
      const scroller = document.querySelector("[data-testid='message-list'] .overflow-y-auto") as HTMLElement | null;
      return {
        height: node.getBoundingClientRect().height,
        sameNode: win.__finalResponseNode === node,
        scrollDelta: Math.abs((scroller?.scrollTop ?? 0) - beforeScrollTop),
      };
    }, continuity.scrollTop);
    expect(continuity.nestedScrollableCount).toBe(0);
    expect(Math.abs(result.height - continuity.height)).toBeLessThan(36);
    expect(result.sameNode).toBe(true);
    expect(result.scrollDelta).toBeLessThan(2);

    serverMessages = [userMessage(), assistantMessage(finalText)];
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect.poll(() => findStore(page, ["handleAgentEvent", "records"])).toBe(true);
    await setupThread(page, serverMessages);
    await expect(page.locator("[data-message-id='assistant-persisted']")).toBeVisible();
    await expect(page.getByText("Final answer that should keep the same DOM node.")).toBeVisible();
    await expect(page.getByText("Third visible item")).toBeVisible();
  });
});
