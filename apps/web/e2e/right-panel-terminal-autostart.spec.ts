import { test, expect, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-term-autostart",
  name: "Autostart WS",
  path: "/tmp/term-autostart",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

function makeThread(id: string, title: string): Thread {
  return {
    id,
    workspace_id: WORKSPACE.id,
    title,
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
}

const THREAD = makeThread("thread-term-autostart", "Autostart Thread");

/** Reads the number of terminals the store holds for a thread. */
async function terminalCount(page: Page, threadId: string): Promise<number> {
  return page.evaluate((tid) => {
    const stores: unknown[] =
      (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const termStore = stores.find(
      (s) => "addTerminal" in (s as { getState: () => Record<string, unknown> }).getState(),
    );
    if (!termStore) return -1;
    const terminals = (
      termStore as { getState: () => { terminals: Record<string, unknown[]> } }
    ).getState().terminals[tid];
    return terminals ? terminals.length : 0;
  }, threadId);
}

async function openPanelOnScope(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, tid }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
      const wsStore = stores.find((s) => "activeThreadId" in getState(s) && "threads" in getState(s));
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: tid,
      });
      const diffStore = stores.find((s) => "showRightPanel" in getState(s));
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              showRightPanel: (id: string) => void;
              setRightPanelTab: (id: string, t: string) => void;
            };
          }
        ).getState();
        api.showRightPanel(tid);
        api.setRightPanelTab(tid, "tasks");
      }
    },
    { workspace: WORKSPACE, thread: THREAD, tid: THREAD.id },
  );
}

test.describe("Right panel terminal auto-start", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "terminal.create": { ptyId: "pty-term-autostart", shell: "bash" },
      "terminal.resize": true,
      "terminal.kill": true,
      "terminal.killByThread": true,
      "settings.get": getDefaultSettings(),
    });
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete ===
        true,
      { timeout: 30_000 },
    );
  });

  test("clicking the Terminal tab auto-starts a shell", async ({ page }) => {
    await openPanelOnScope(page);

    // No terminals before the tab is opened.
    expect(await terminalCount(page, THREAD.id)).toBe(0);

    await page.getByRole("button", { name: "Terminal", exact: true }).click();

    // Opening the tab spawns one without the user clicking "New terminal".
    await expect.poll(() => terminalCount(page, THREAD.id), { timeout: 5_000 }).toBe(1);
    await expect(page.getByText("No terminals")).toHaveCount(0);
  });
});
