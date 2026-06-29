import { expect, test, type Page } from "@playwright/test";
import { getDefaultSettings, type GitBranch, type Thread, type Workspace } from "@mcode/contracts";
import {
  interceptZustandStores,
  mockWebSocketServer,
  type RpcOverrides,
} from "./helpers/e2e-helpers";

const WORKSPACE: Workspace = {
  id: "ws-checkout-dialog",
  name: "Checkout Dialog",
  path: "/tmp/checkout-dialog",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const BRANCHES: GitBranch[] = [
  { name: "main", type: "local", isCurrent: true, shortSha: "1111111" },
  { name: "feature/base", type: "local", isCurrent: false, shortSha: "2222222" },
];

function createdThread(mode: "direct" | "worktree", branch: string): Thread {
  return {
    id: `created-${mode}`,
    workspace_id: WORKSPACE.id,
    title: "Created thread",
    status: "active",
    mode: mode === "worktree" ? "worktree" : "direct",
    worktree_path: mode === "worktree" ? "/tmp/checkout-dialog/.worktrees/feature-base" : null,
    branch,
    checkout_state: mode === "worktree" ? "branchless" : "named",
    base_branch: mode === "worktree" ? branch : null,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    deleted_at: null,
    worktree_managed: mode === "worktree",
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
}

async function seedNewThreadComposer(page: Page, mode: "direct" | "worktree"): Promise<void> {
  await page.evaluate(
    ({ workspace, branches, selectedMode }) => {
      const stores =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown>; setState: (patch: Record<string, unknown>) => void }> }).__mcodeStores ?? [];
      const workspaceStore = stores.find((store) => {
        const state = store.getState();
        return "activeThreadId" in state && "threads" in state && "workspaces" in state;
      });
      if (!workspaceStore) throw new Error("[E2E] workspace store not found");
      workspaceStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [],
        activeThreadId: null,
        pendingNewThread: true,
        branches,
        branchesLoading: false,
        newThreadMode: selectedMode,
        newThreadBranch: "feature/base",
        selectedWorktree: null,
        worktrees: [],
      });
    },
    { workspace: WORKSPACE, branches: BRANCHES, selectedMode: mode },
  );
  await expect(page.locator('[contenteditable="true"]')).toBeVisible({ timeout: 10_000 });
}

async function typeDraftAndSend(page: Page, text: string): Promise<void> {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test.describe("Composer checkout dialog", () => {
  test("uses an app dialog for Direct checkout cancel and skips checkout for New worktree", async ({ page }) => {
    const rpcCalls: Array<{ method: string; params: unknown }> = [];
    const overrides: RpcOverrides = {
      "settings.get": getDefaultSettings(),
      "git.listBranches": BRANCHES,
      "git.currentBranch": (params) => {
        rpcCalls.push({ method: "git.currentBranch", params });
        return "main";
      },
      "git.checkout": (params) => {
        rpcCalls.push({ method: "git.checkout", params });
        return null;
      },
      "agent.createAndSend": (params) => {
        rpcCalls.push({ method: "agent.createAndSend", params });
        const mode =
          params && typeof params === "object" && "mode" in params && params.mode === "worktree"
            ? "worktree"
            : "direct";
        const branch =
          params && typeof params === "object" && "branch" in params && typeof params.branch === "string"
            ? params.branch
            : "main";
        return createdThread(mode, branch);
      },
    };

    await mockWebSocketServer(page, overrides);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await seedNewThreadComposer(page, "direct");
    await typeDraftAndSend(page, "direct draft");

    await expect(page.getByRole("dialog", { name: "Switch branch?" })).toBeVisible();
    await expect(page.locator('[contenteditable="true"]').first()).toContainText("direct draft");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog", { name: "Switch branch?" })).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]').first()).toContainText("direct draft");
    expect(rpcCalls.map((call) => call.method)).toContain("git.currentBranch");
    expect(rpcCalls.some((call) => call.method === "git.checkout")).toBe(false);
    expect(rpcCalls.some((call) => call.method === "agent.createAndSend")).toBe(false);

    rpcCalls.length = 0;
    await seedNewThreadComposer(page, "worktree");
    await typeDraftAndSend(page, "worktree draft");

    await expect(page.getByRole("dialog", { name: "Switch branch?" })).toHaveCount(0);
    expect(rpcCalls.some((call) => call.method === "git.currentBranch")).toBe(false);
    expect(rpcCalls.some((call) => call.method === "git.checkout")).toBe(false);
    const createCall = rpcCalls.find((call) => call.method === "agent.createAndSend");
    expect(createCall?.params).toMatchObject({
      mode: "worktree",
      branch: "feature/base",
    });
  });
});
