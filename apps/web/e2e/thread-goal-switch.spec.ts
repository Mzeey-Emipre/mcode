import { test, expect } from "@playwright/test";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();

const workspace = {
  id: "ws-goal-switch",
  name: "Goal Switch Workspace",
  path: "/tmp/goal-switch",
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
    model: "gpt-5.2-codex",
    provider: "codex",
    deleted_at: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    permission_mode: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    checkout_state: "named",
    base_branch: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    default_open_in_app: null,
    last_compact_summary: null,
    has_file_changes: false,
  };
}

function message(threadId: string, id: string, content: string) {
  return {
    id,
    thread_id: threadId,
    role: "user" as const,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: now,
    sequence: 1,
    attachments: null,
  };
}

test("thread switch A/B/A renders active goal for only the matching thread", async ({ page }) => {
  await interceptZustandStores(page);
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [
      thread("thread-a", "Goal Thread A"),
      thread("thread-b", "No Goal Thread B"),
    ],
    "conversation.page": (params) => {
      const threadId = (params as { threadId: string }).threadId;
      return {
        messages: [
          message(threadId, `${threadId}-user`, threadId === "thread-a" ? "Alpha request" : "Beta request"),
        ],
        hasMore: false,
        answeredPlanMessageIds: [],
        narrativeByMessage: {},
      };
    },
    "thread.goal.get": (params) => {
      const threadId = (params as { threadId: string }).threadId;
      if (threadId === "thread-a") {
        return {
          goal: {
            threadId,
            objective: "Keep Alpha active",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
            providerId: "codex",
            source: "codex",
            controls: { canInspect: true, canClear: true },
          },
          authoritative: false,
          source: "codex-cache",
          reason: "not-materialized",
        };
      }
      return {
        goal: null,
        authoritative: false,
        source: "codex-cache",
        reason: "not-materialized",
      };
    },
  });

  await page.goto("/");
  await page.getByRole("option", { name: /Goal Switch Workspace/ }).click();
  await page.getByRole("button", { name: /Goal Switch Workspace 2/ }).click();
  await page.waitForSelector("[data-testid='thread-item']");

  const threadItems = page.locator("[data-testid='thread-item']");
  await threadItems.nth(0).click();
  await expect(page.getByTestId("active-goal-bar")).toContainText("Keep Alpha active");

  await threadItems.nth(1).click();
  await expect(page.getByTestId("active-goal-bar")).toHaveCount(0);

  await threadItems.nth(0).click();
  await expect(page.getByTestId("active-goal-bar")).toContainText("Keep Alpha active");
});
