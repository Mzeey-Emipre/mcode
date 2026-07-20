import { expect, test, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { interceptZustandStores, mockWebSocketServer } from "./helpers/e2e-helpers";

const now = new Date().toISOString();
const completedAt = new Date(Date.parse(now) + 15_000).toISOString();
const WORKSPACE_ID = "ws-tool-output-truncation";
const THREAD_ID = "thread-tool-output-truncation";
const ASSISTANT_ID = "assistant-tool-output-truncation";
const ARTIFACT_PATH = "C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt";

const workspace = {
  id: WORKSPACE_ID,
  name: "Tool Output Truncation",
  path: "/tmp/tool-output-truncation",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

const thread = {
  id: THREAD_ID,
  workspace_id: WORKSPACE_ID,
  title: "Tool output truncation",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: now,
  updated_at: now,
  model: "gpt-5.5",
  deleted_at: null,
  worktree_managed: false,
  sdk_session_id: null,
  provider: "codex",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

function userMessage() {
  return {
    id: "user-tool-output-truncation",
    thread_id: THREAD_ID,
    role: "user" as const,
    content: "Run a large-output command",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: now,
    sequence: 1,
    attachments: null,
  };
}

function assistantMessage() {
  return {
    id: ASSISTANT_ID,
    thread_id: THREAD_ID,
    role: "assistant" as const,
    content: "Done.",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: 12,
    timestamp: now,
    sequence: 2,
    attachments: null,
  };
}

function truncatedToolRecord() {
  return {
    id: "tool-large-output",
    message_id: ASSISTANT_ID,
    parent_tool_call_id: null,
    tool_name: "Bash",
    input_summary: "node -e large output",
    output_summary: "HEAD\nTAIL",
    output_truncated: 1,
    output_total_bytes: 350 * 1024,
    output_artifact_path: ARTIFACT_PATH,
    status: "completed" as const,
    started_at: now,
    completed_at: completedAt,
    sort_order: 0,
  };
}

function failedToolRecord() {
  return {
    ...truncatedToolRecord(),
    id: "tool-failed",
    input_summary: "git pull --ff-only origin main",
    output_summary: "fatal: Not possible to fast-forward, aborting.",
    output_truncated: 0,
    output_total_bytes: null,
    output_artifact_path: null,
    exit_code: 1,
    status: "failed" as const,
  };
}

async function setupApp(
  page: Page,
  messages: Array<ReturnType<typeof userMessage> | ReturnType<typeof assistantMessage>>,
  toolRecords = [truncatedToolRecord()],
) {
  await page.addInitScript((workspaceId: string) => {
    localStorage.setItem("mcode-expanded-projects", JSON.stringify({ [workspaceId]: true }));
  }, WORKSPACE_ID);

  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "workspace.enrich": { items: [] },
    "workspace.touchLastOpened": null,
    "thread.list": [thread],
    "message.list": { messages, hasMore: false, answeredPlanMessageIds: [] },
    "narrative.list": (params?: unknown) => {
      const messageId = (params as { messageId?: string } | undefined)?.messageId;
      return messageId === ASSISTANT_ID
        ? { tools: toolRecords, thoughts: [], hooks: [] }
        : { tools: [], thoughts: [], hooks: [] };
    },
    "settings.get": getDefaultSettings(),
  });
  await interceptZustandStores(page);
  await page.goto("/");
  await page.waitForSelector("[data-testid='thread-item']");
  await page.getByTestId("thread-item").first().click();
  await page.waitForSelector("[data-testid='message-list']");
}

async function dispatchAgentEvent(page: Page, event: unknown) {
  await page.evaluate(({ threadId, agentEvent }) => {
    type Store = { getState: () => Record<string, unknown> };
    const stores = (window as unknown as { __mcodeStores?: Store[] }).__mcodeStores ?? [];
    const threadStore = stores.find((store) => {
      const state = store.getState();
      return "handleAgentEvent" in state && "records" in state;
    });
    const state = threadStore?.getState() as
      | { handleAgentEvent: (targetThreadId: string, incoming: unknown) => void }
      | undefined;
    if (!state) throw new Error("thread store not found");
    state.handleAgentEvent(threadId, agentEvent);
  }, { threadId: THREAD_ID, agentEvent: event });
}

async function expectTruncationNotice(page: Page, total: string, duration?: string) {
  const summary = page.getByRole("button", { name: /Ran 1 command/ });
  if (await summary.getAttribute("aria-expanded") !== "true") {
    await summary.click();
  }

  const command = page.getByRole("button", { name: /Ran command/ });
  if (duration) {
    await expect(command).toContainText(`in ${duration}`);
  }
  if (await command.getAttribute("aria-expanded") !== "true") {
    await command.click();
  }

  const notice = page.getByText(/Output truncated/).first();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(total);
  await expect(notice).toContainText("full output saved");
  await expect(notice).toHaveAttribute("title", ARTIFACT_PATH);
}

test.describe("tool output truncation", () => {
  test("shows live truncation notice from streamed tool result metadata", async ({ page }) => {
    await setupApp(page, [userMessage()]);

    await dispatchAgentEvent(page, { method: "session.turnStarted", params: {} });
    await dispatchAgentEvent(page, {
      method: "session.toolUse",
      params: {
        toolCallId: "tool-large-output",
        toolName: "Bash",
        toolInput: { command: "node -e large output" },
      },
    });
    await dispatchAgentEvent(page, {
      method: "session.toolResult",
      params: {
        toolCallId: "tool-large-output",
        output: "HEAD\nTAIL",
        isError: false,
        outputTruncated: true,
        outputTotalBytes: 350 * 1024,
        outputArtifactPath: ARTIFACT_PATH,
      },
    });

    await expectTruncationNotice(page, "350 KB total");
  });

  test("keeps truncation notice after persisted narrative reload", async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await setupApp(page, [userMessage(), assistantMessage()]);

    await expectTruncationNotice(page, "350 KB total", "15s");

    await page.reload();
    await page.waitForSelector("[data-testid='thread-item']");
    await page.getByTestId("thread-item").first().click();

    await expectTruncationNotice(page, "350 KB total", "15s");
    expect(browserErrors).toEqual([]);
  });

  test("shows a persisted shell exit code in the panel footer", async ({ page }) => {
    await setupApp(page, [userMessage(), assistantMessage()], [failedToolRecord()]);

    await page.getByRole("button", { name: /Ran 1 command/ }).click();
    await page.getByRole("button", { name: /Ran command/ }).click();

    const panel = page.getByRole("region", { name: "Shell output" });
    await expect(panel.getByText("exit code 1")).toBeVisible();
    await expect(page.getByRole("button", { name: /Ran command/ })).not.toContainText("errored");
    await expect(panel.getByText("errored")).toHaveCount(0);
  });
});
