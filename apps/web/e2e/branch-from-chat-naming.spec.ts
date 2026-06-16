import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
  seedActiveThread,
} from "./helpers/e2e-helpers";

/**
 * E2E verification for the branch-from-chat naming fix (issue #339).
 *
 * Tests four behaviors that were broken before the fix:
 * 1. branchNamingMode initializes from settings.worktree.naming.mode
 * 2. branchNamingMode defaults to "auto" when settings mode is "auto"
 * 3. branchAutoPreview is independent from autoPreviewBranch
 * 4. initBranchMode defaults to "existing-worktree" for worktree parent threads
 *
 * Strategy: Use interceptZustandStores to read store state directly, bypassing
 * the need to submit real forms or hit a live server. The store state reflects
 * what initBranchMode sets, which is the target of this regression suite.
 * Note: resolveBranchName submit-time behavior is covered by unit tests.
 */

// ─── Test data ────────────────────────────────────────────────────────────────

const THREAD_ID = "test-thread-branch-naming";

const FAKE_WORKSPACE = {
  id: "ws-branch-test",
  name: "Branch Test Workspace",
  path: "/tmp/branch-test",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const FAKE_THREAD: Thread = {
  id: THREAD_ID,
  workspace_id: "ws-branch-test",
  title: "Branch Naming Test",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
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
  mode: "worktree" as const,
  branch: "feat/parent-branch",
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

/**
 * Inject a workspace-store finder onto the page so evaluate/waitForFunction
 * calls share one predicate definition instead of duplicating it.
 *
 * Must be called before page.goto() so addInitScript registers before load.
 */
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

/** Activate a thread, wait for messages to load, then inject messages. */
async function activateThreadAndInjectMessages(
  page: Page,
  thread: Thread,
  messages: typeof FAKE_MESSAGE[]
): Promise<void> {
  await seedActiveThread(page, FAKE_WORKSPACE, thread, messages);
}

/** Read the workspaceStore state from the injected registry. */
async function getWorkspaceStoreState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsStore = (window as any).__findWorkspaceStore?.();
    if (!wsStore) return {};
    const st = wsStore.getState();
    return {
      branchNamingMode: st.branchNamingMode,
      branchAutoPreview: st.branchAutoPreview,
      branchExecMode: st.branchExecMode,
      branchTargetBranch: st.branchTargetBranch,
      branchWorktreePath: st.branchWorktreePath,
      autoPreviewBranch: st.autoPreviewBranch,
    };
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Branch-from-chat naming fix (#339)", () => {
  test.setTimeout(30000);

  test("branchNamingMode initializes from settings when mode is 'custom'", async ({ page }) => {
    // Override settings so worktree.naming.mode is "custom"
    const customSettings = {
      ...getDefaultSettings(),
      worktree: { naming: { mode: "custom" as const, aiConfirmation: true } },
    };

    await mockWebSocketServer(page, { "settings.get": customSettings });
    await interceptZustandStores(page);
    await injectStoreHelpers(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The settingsStore.fetch() is async (WS RPC). Rather than racing against it,
    // inject the custom settings directly so initBranchMode reads "custom" reliably.
    await page.evaluate(
      ({ settings }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settingsStore = stores.find((s: any) => {
          const st = s.getState();
          return "loaded" in st && "settings" in st && !("threads" in st);
        });
        if (!settingsStore) { console.error("[E2E] settings store not found"); return; }
        settingsStore.setState({ settings, loaded: true });
      },
      { settings: customSettings }
    );

    await activateThreadAndInjectMessages(page, FAKE_THREAD, [FAKE_MESSAGE]);

    // Wait for message to be visible
    await page.waitForFunction(
      () => document.body.innerText.includes("I can help you with that feature."),
      { timeout: 5000 }
    );

    // Trigger branch mode via the branch button on the message
    const branchBtn = page.getByRole("button", { name: "Fork from this message" });
    await expect(branchBtn).toBeVisible({ timeout: 5000 });
    await branchBtn.click();

    // Switch exec mode to "New worktree" via ModeSelector
    const modeSelector = page.getByRole("button", { name: /Local|New worktree|Existing worktree/i }).first();
    await expect(modeSelector).toBeVisible({ timeout: 3000 });
    await modeSelector.click();
    const newWorktreeOption = page.getByRole("menuitem", { name: "New worktree" });
    await expect(newWorktreeOption).toBeVisible({ timeout: 3000 });
    await newWorktreeOption.click();

    // Verify the NamingModeSelector shows "Custom" (not "Auto")
    const namingSelector = page.getByRole("button", { name: "Branch naming mode" });
    await expect(namingSelector).toBeVisible({ timeout: 3000 });
    await expect(namingSelector).toContainText("Custom");

    // Also verify via store state
    const storeState = await getWorkspaceStoreState(page);
    expect(storeState.branchNamingMode).toBe("custom");

    await page.screenshot({ path: "e2e/screenshots/branch-from-chat-naming-custom.png" });
  });

  test("branchNamingMode initializes to 'auto' when settings mode is 'auto'", async ({ page }) => {
    // Default settings have mode: "auto"
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await injectStoreHelpers(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await activateThreadAndInjectMessages(page, FAKE_THREAD, [FAKE_MESSAGE]);

    await page.waitForFunction(
      () => document.body.innerText.includes("I can help you with that feature."),
      { timeout: 5000 }
    );

    const branchBtn = page.getByRole("button", { name: "Fork from this message" });
    await expect(branchBtn).toBeVisible({ timeout: 5000 });
    await branchBtn.click();

    // Switch to new worktree mode
    const modeSelector = page.getByRole("button", { name: /Local|New worktree|Existing worktree/i }).first();
    await expect(modeSelector).toBeVisible({ timeout: 3000 });
    await modeSelector.click();
    const newWorktreeOption = page.getByRole("menuitem", { name: "New worktree" });
    await expect(newWorktreeOption).toBeVisible({ timeout: 3000 });
    await newWorktreeOption.click();

    // Verify the NamingModeSelector shows "Auto"
    const namingSelector = page.getByRole("button", { name: "Branch naming mode" });
    await expect(namingSelector).toBeVisible({ timeout: 3000 });
    await expect(namingSelector).toContainText("Auto");

    const storeState = await getWorkspaceStoreState(page);
    expect(storeState.branchNamingMode).toBe("auto");

    await page.screenshot({ path: "e2e/screenshots/branch-from-chat-naming-auto.png" });
  });

  test("branchAutoPreview is independent from autoPreviewBranch", async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await injectStoreHelpers(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Read the initial autoPreviewBranch (new-thread flow) from store
    const initialState = await getWorkspaceStoreState(page);
    const initialAutoPreview = initialState.autoPreviewBranch as string;
    expect(initialAutoPreview).toMatch(/^mcode-/);

    await activateThreadAndInjectMessages(page, FAKE_THREAD, [FAKE_MESSAGE]);

    await page.waitForFunction(
      () => document.body.innerText.includes("I can help you with that feature."),
      { timeout: 5000 }
    );

    // Enter branch mode
    const branchBtn = page.getByRole("button", { name: "Fork from this message" });
    await expect(branchBtn).toBeVisible({ timeout: 5000 });
    await branchBtn.click();

    // Switch to worktree mode to trigger initBranchMode auto preview generation
    const modeSelector = page.getByRole("button", { name: /Local|New worktree|Existing worktree/i }).first();
    await modeSelector.click();
    const newWorktreeOption = page.getByRole("menuitem", { name: "New worktree" });
    await newWorktreeOption.click();

    // Read store state after branch mode activated
    const afterState = await getWorkspaceStoreState(page);
    const branchAutoPreview = afterState.branchAutoPreview as string;
    const autoPreviewBranch = afterState.autoPreviewBranch as string;

    // Both should be valid mcode-* names
    expect(branchAutoPreview).toMatch(/^mcode-/);
    expect(autoPreviewBranch).toMatch(/^mcode-/);

    // They must be different — isolated auto previews
    expect(branchAutoPreview).not.toBe(autoPreviewBranch);

    // The new-thread auto preview should be unchanged (initBranchMode doesn't touch it)
    expect(autoPreviewBranch).toBe(initialAutoPreview);

    await page.screenshot({ path: "e2e/screenshots/branch-from-chat-auto-preview-isolated.png" });
  });

  test("initBranchMode defaults to existing-worktree when parent thread is in worktree mode", async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await injectStoreHelpers(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Use the worktree thread
    const worktreeMessage = { ...FAKE_MESSAGE, thread_id: FAKE_THREAD_WORKTREE.id };
    await activateThreadAndInjectMessages(page, FAKE_THREAD_WORKTREE, [worktreeMessage]);

    await page.waitForFunction(
      () => document.body.innerText.includes("I can help you with that feature."),
      { timeout: 5000 }
    );

    const branchBtn = page.getByRole("button", { name: "Fork from this message" });
    await expect(branchBtn).toBeVisible({ timeout: 5000 });
    await branchBtn.click();

    // Wait for the useEffect([branchFromMessageId]) to fire and initBranchMode to complete.
    // The effect runs after the React render cycle, so poll until the store reflects it.
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__findWorkspaceStore?.()?.getState().branchExecMode === "existing-worktree",
      { timeout: 3000 }
    );

    // After entering branch mode from a worktree thread, exec mode should be "existing-worktree"
    const storeState = await getWorkspaceStoreState(page);
    expect(storeState.branchExecMode).toBe("existing-worktree");
    // Target branch should reflect parent branch
    expect(storeState.branchTargetBranch).toBe("feat/parent-branch");

    await page.screenshot({ path: "e2e/screenshots/branch-from-chat-worktree-parent.png" });
  });
});
