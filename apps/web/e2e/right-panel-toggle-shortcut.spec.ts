import { test, expect, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

/**
 * The `rightPanel.toggle` command (bound to mod+alt+b — Ctrl+Alt+B on
 * Windows/Linux, Cmd+Alt+B on macOS) shows and hides the whole right panel.
 * Unlike the per-tab summon shortcuts, it has no `!inputFocused` guard, so it
 * works while the composer is focused — the common case when a developer is
 * typing a prompt and wants to flip the panel open.
 */

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-panel-shortcut",
  name: "Panel Shortcut",
  path: "/tmp/panel-shortcut",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const THREAD: Thread = {
  id: "thread-panel-shortcut",
  workspace_id: WORKSPACE.id,
  title: "Panel Shortcut",
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

/** Reads the panel's effective open/closed state for the active thread. */
async function panelVisible(page: Page): Promise<boolean> {
  return page.evaluate(({ wid, tid }) => {
    const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
    const diff = stores.find((s) => "getRightPanelVisible" in getState(s));
    return (
      diff as { getState: () => { getRightPanelVisible: (w: string, t?: string) => boolean } }
    ).getState().getRightPanelVisible(wid, tid);
  }, { wid: WORKSPACE.id, tid: THREAD.id });
}

test.describe("Right panel toggle shortcut", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "settings.get": getDefaultSettings(),
      "thread.getTasks": [],
      "snapshot.listByThread": [],
    });
    await interceptZustandStores(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete ===
        true,
      { timeout: 30_000 },
    );
    await page.evaluate(({ ws, thread }) => {
      const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) => (s as { getState: () => Record<string, unknown> }).getState();
      const wsStore = stores.find((s) => "activeThreadId" in getState(s) && "threads" in getState(s));
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        threads: [thread],
        activeThreadId: thread.id,
      });
    }, { ws: WORKSPACE, thread: THREAD });
  });

  test("mod+alt+b shows then hides the panel while the composer is focused", async ({ page }) => {
    // Focus the composer to mimic typing a prompt — the guard-free shortcut must
    // still fire here (the per-tab summons are gated on !inputFocused; this isn't).
    await page.locator('[contenteditable="true"]').first().click().catch(() => {});

    expect(await panelVisible(page)).toBe(false);

    await page.keyboard.press("Control+Alt+b");
    await expect.poll(() => panelVisible(page), { timeout: 4_000 }).toBe(true);
    await expect(page.getByTestId("activity-rail")).toBeVisible();

    await page.keyboard.press("Control+Alt+b");
    await expect.poll(() => panelVisible(page), { timeout: 4_000 }).toBe(false);
  });
});
