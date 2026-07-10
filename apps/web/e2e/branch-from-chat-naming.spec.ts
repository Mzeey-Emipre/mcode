import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
  seedActiveThread,
} from "./helpers/e2e-helpers";

const THREAD_ID = "test-thread-branchless";

const FAKE_WORKSPACE = {
  id: "ws-branch-test",
  name: "Branch Test Workspace",
  path: "/tmp/branch-test",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  is_git_repo: true,
};

const FAKE_THREAD: Thread = {
  id: THREAD_ID,
  workspace_id: "ws-branch-test",
  title: "Branchless Test",
  status: "paused",
  mode: "direct",
  worktree_path: null,
  branch: "main",
  checkout_state: "named",
  base_branch: null,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: null,
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
  copilot_agent: null,
};

const FAKE_THREAD_WORKTREE: Thread = {
  ...FAKE_THREAD,
  id: "test-thread-worktree",
  title: "Worktree Thread",
  mode: "worktree",
  branch: "feat/parent-branch",
  checkout_state: "branchless",
  base_branch: "main",
  worktree_path: "/tmp/branch-test/.worktrees/feat-parent-branch",
  worktree_managed: true,
};

const FAKE_MESSAGE = {
  id: "msg-1",
  thread_id: THREAD_ID,
  role: "assistant" as const,
  content: "I can help you with that feature.",
  tool_calls: null,
  files_changed: null,
  cost_usd: null,
  tokens_used: 42,
  timestamp: new Date().toISOString(),
  sequence: 1,
  attachments: null,
};

async function injectStoreHelpers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__findWorkspaceStore = () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).__mcodeStores ?? []).find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
  });
}

async function activateThreadAndInjectMessages(
  page: Page,
  thread: Thread,
  messages: typeof FAKE_MESSAGE[]
): Promise<void> {
  await seedActiveThread(page, FAKE_WORKSPACE, thread, messages);
}

async function getWorkspaceStoreState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsStore = (window as any).__findWorkspaceStore?.();
    if (!wsStore) return {};
    const st = wsStore.getState();
    return {
      branchNamingMode: st.branchNamingMode,
      branchExecMode: st.branchExecMode,
      branchTargetBranch: st.branchTargetBranch,
      branchWorktreePath: st.branchWorktreePath,
    };
  });
}

async function openBranchMode(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.body.innerText.includes("I can help you with that feature."),
    { timeout: 5000 }
  );

  const branchBtn = page.getByRole("button", { name: "Fork from this message" });
  await expect(branchBtn).toBeVisible({ timeout: 5000 });
  await branchBtn.click();
}

async function selectNewWorktree(page: Page): Promise<void> {
  const modeSelector = page.getByRole("button", { name: /Local|New worktree|Existing worktree/i }).first();
  await expect(modeSelector).toBeVisible({ timeout: 3000 });
  await modeSelector.click();

  const newWorktreeOption = page.getByRole("menuitem", { name: "New worktree" });
  await expect(newWorktreeOption).toBeVisible({ timeout: 3000 });
  await newWorktreeOption.click();
}

test.describe("Branch-from-chat branchless worktrees", () => {
  test.setTimeout(30000);

  test("new worktree mode ignores legacy custom naming settings", async ({ page }) => {
    const customSettings = {
      ...getDefaultSettings(),
      worktree: { naming: { mode: "custom" as const, aiConfirmation: true } },
    };

    await mockWebSocketServer(page, { "settings.get": customSettings });
    await interceptZustandStores(page);
    await injectStoreHelpers(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await activateThreadAndInjectMessages(page, FAKE_THREAD, [FAKE_MESSAGE]);
    await openBranchMode(page);
    await selectNewWorktree(page);

    await expect(page.getByRole("button", { name: "Branch naming mode" })).toHaveCount(0);

    const storeState = await getWorkspaceStoreState(page);
    expect(storeState.branchNamingMode).toBe("auto");
    expect(storeState.branchExecMode).toBe("worktree");
    expect(storeState.branchTargetBranch).toBe("main");
  });

  test("worktree parent threads still default to existing worktree", async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await injectStoreHelpers(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const worktreeMessage = { ...FAKE_MESSAGE, thread_id: FAKE_THREAD_WORKTREE.id };
    await activateThreadAndInjectMessages(page, FAKE_THREAD_WORKTREE, [worktreeMessage]);
    await openBranchMode(page);

    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__findWorkspaceStore?.()?.getState().branchExecMode === "existing-worktree",
      { timeout: 3000 }
    );

    const storeState = await getWorkspaceStoreState(page);
    expect(storeState.branchExecMode).toBe("existing-worktree");
    expect(storeState.branchTargetBranch).toBe("feat/parent-branch");
  });
});
