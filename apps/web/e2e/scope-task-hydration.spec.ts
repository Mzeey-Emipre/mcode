import { test, expect, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-scope-task-hydration",
  name: "Task Bubble Hydration",
  path: "/tmp/scope-task-hydration",
  provider_config: {},
  is_git_repo: false,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const THREAD: Thread = {
  id: "thread-scope-task-hydration",
  workspace_id: WORKSPACE.id,
  title: "Task Bubble Hydration Thread",
  status: "paused",
  mode: "direct",
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

type StoredTask = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  group?: string;
};

async function seedTaskBubbleThread(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) =>
        (s as { getState: () => Record<string, unknown> }).getState();

      const workspaceStore = stores.find(
        (s) => "activeThreadId" in getState(s) && "threads" in getState(s),
      );
      if (workspaceStore) {
        (workspaceStore as { setState: (patch: unknown) => void }).setState({
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          threads: [thread],
          activeThreadId: thread.id,
        });
      }

      const diffStore = stores.find(
        (s) => "showRightPanel" in getState(s) && "setRightPanelTab" in getState(s),
      );
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              showRightPanel: (workspaceId: string, threadId?: string) => void;
              setRightPanelTab: (workspaceId: string, threadId: string | null, tab: string) => void;
            };
          }
        ).getState();
        api.showRightPanel(workspace.id, thread.id);
        api.setRightPanelTab(workspace.id, thread.id, "tasks");
      }
    },
    { workspace: WORKSPACE, thread: THREAD },
  );
}

async function setRunningAndResetHydration(page: Page, running: boolean): Promise<void> {
  await page.evaluate(
    ({ threadId, running }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const threadStore = stores.find((s) => {
        const state = (s as { getState: () => Record<string, unknown> }).getState();
        return "loadMessages" in state && "runningThreadIds" in state;
      });
      if (!threadStore) throw new Error("thread store missing");

      (
        threadStore as {
          setState: (
            patch: (state: {
              records: Map<string, Record<string, unknown>>;
            }) => {
              records: Map<string, Record<string, unknown>>;
              runningThreadIds: Set<string>;
            },
          ) => void;
        }
      ).setState((state) => {
        const records = new Map(state.records);
        const current = records.get(threadId);
        if (current) records.set(threadId, { ...current, lastHydratedAt: 0 });
        return {
          records,
          runningThreadIds: running ? new Set([threadId]) : new Set(),
        };
      });
    },
    { threadId: THREAD.id, running },
  );
}

async function loadMessages(page: Page): Promise<void> {
  await page.evaluate(async (threadId) => {
    const stores: unknown[] =
      (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const threadStore = stores.find((s) => {
      const state = (s as { getState: () => Record<string, unknown> }).getState();
      return "loadMessages" in state && "runningThreadIds" in state;
    });
    if (!threadStore) throw new Error("thread store missing");
    await (
      threadStore as {
        getState: () => { loadMessages: (threadId: string) => Promise<void> };
      }
    ).getState().loadMessages(threadId);
  }, THREAD.id);
}

async function emitUpdatePlan(page: Page, task: string): Promise<void> {
  await page.evaluate(
    ({ threadId, task }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const threadStore = stores.find((s) => {
        const state = (s as { getState: () => Record<string, unknown> }).getState();
        return "handleAgentEvent" in state;
      });
      if (!threadStore) throw new Error("thread store missing");
      (
        threadStore as {
          getState: () => {
            handleAgentEvent: (threadId: string, event: unknown) => void;
          };
        }
      ).getState().handleAgentEvent(threadId, {
        method: "session.toolUse",
        params: {
          toolCallId: `live-plan-${Date.now()}`,
          toolName: "update_plan",
          toolInput: {
            plan: [{ status: "pending", step: task }],
          },
        },
      });
    },
    { threadId: THREAD.id, task },
  );
}

async function expandTaskBubble(page: Page, label: RegExp): Promise<void> {
  await expect(page.getByText(label)).toBeVisible();
  const bubble = page.getByText(label).locator("xpath=ancestor::button[1]");
  if ((await bubble.getAttribute("aria-expanded")) !== "true") {
    await bubble.click();
  }
}

test.describe("Task bubble hydration", () => {
  test("replaces idle parent tasks from persistence but preserves running live parent tasks", async ({
    page,
  }, testInfo) => {
    let persistedTasks: StoredTask[] = [
      {
        content: "Old stale task",
        status: "pending",
        group: "Tasks",
      },
    ];

    await interceptZustandStores(page);
    await mockWebSocketServer(page, {
      "thread.getTasks": () => persistedTasks,
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
      { timeout: 30_000 },
    );
    await seedTaskBubbleThread(page);
    await loadMessages(page);
    await expandTaskBubble(page, /0\/1 steps/i);
    await expect(page.getByText("Old stale task")).toBeVisible();

    persistedTasks = [
      {
        content: "New persisted task from hydration",
        status: "completed",
        group: "Tasks",
      },
    ];
    await setRunningAndResetHydration(page, false);
    await loadMessages(page);

    await expandTaskBubble(page, /1\/1 steps/i);
    await expect(page.getByText("New persisted task from hydration")).toBeVisible();
    await expect(page.getByText("Old stale task")).toHaveCount(0);

    await emitUpdatePlan(page, "Live running task stays visible");
    await expandTaskBubble(page, /0\/1 steps/i);
    await expect(page.getByText("Live running task stays visible")).toBeVisible();

    persistedTasks = [
      {
        content: "Persisted stale while running",
        status: "completed",
        group: "Tasks",
      },
    ];
    await setRunningAndResetHydration(page, true);
    await loadMessages(page);

    await expect(page.getByText("Live running task stays visible")).toBeVisible();
    await expect(page.getByText("Persisted stale while running")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("task-bubble-hydration.png") });
  });
});
