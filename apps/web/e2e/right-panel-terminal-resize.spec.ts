import { test, expect, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-panel-resize",
  name: "Panel Resize",
  path: "/tmp/panel-resize",
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

const THREAD = makeThread("thread-resize", "Resize Thread");

/** Reads the stored right-panel width for a workspace from diffStore. */
async function getRightPanelWidth(page: Page, workspaceId: string): Promise<number> {
  return page.evaluate((wid) => {
    const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const diffStore = stores.find((s: unknown) => {
      const st = (s as { getState: () => Record<string, unknown> }).getState();
      return "getRightPanel" in st;
    });
    if (!diffStore) return 0;
    const panel = (
      diffStore as { getState: () => { getRightPanel: (id: string) => { width: number } } }
    )
      .getState()
      .getRightPanel(wid);
    return panel.width;
  }, workspaceId);
}

/** Opens the right-panel terminal tab and mounts a PTY for the thread. */
async function openTerminalWithPty(page: Page, threadId: string): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, tid, wid }) => {
      const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const wsStore = stores.find((s: unknown) => {
        const st = (s as { getState: () => Record<string, unknown> }).getState();
        return "activeThreadId" in st && "threads" in st;
      });
      if (wsStore) {
        (wsStore as { setState: (p: unknown) => void }).setState({
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          threads: [thread],
          activeThreadId: tid,
        });
      }

      const diffStore = stores.find((s: unknown) => {
        const st = (s as { getState: () => Record<string, unknown> }).getState();
        return "showRightPanel" in st && "setRightPanelTab" in st;
      });
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              showRightPanel: (id: string, threadId?: string) => void;
              setRightPanelTab: (id: string, tab: string) => void;
            };
          }
        ).getState();
        api.showRightPanel(wid, tid);
        api.setRightPanelTab(wid, "terminal");
      }

      const termStore = stores.find((s: unknown) => {
        const st = (s as { getState: () => Record<string, unknown> }).getState();
        return "addTerminal" in st;
      });
      if (termStore) {
        (
          termStore as {
            getState: () => { addTerminal: (a: string, b: string, c?: string) => void };
          }
        )
          .getState()
          .addTerminal(tid, `pty-${tid}`, "bash");
      }
    },
    { workspace: WORKSPACE, thread: THREAD, tid: threadId, wid: WORKSPACE.id },
  );
}

test.describe("Right panel resize with terminal tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "terminal.create": { ptyId: "pty-thread-resize", shell: "bash" },
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

  test("drag handle resizes panel while terminal tab is active", async ({ page }) => {
    await openTerminalWithPty(page, THREAD.id);

    await expect(page.locator(".xterm")).toBeVisible({ timeout: 15_000 });

    const handle = page.locator('[role="separator"][aria-orientation="vertical"].cursor-col-resize');
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box, "vertical resize handle must be visible").not.toBeNull();

    const widthBefore = await getRightPanelWidth(page, WORKSPACE.id);
    expect(widthBefore).toBeGreaterThan(0);

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x - 80, box!.y + box!.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(() => getRightPanelWidth(page, WORKSPACE.id), { timeout: 3_000 })
      .not.toBe(widthBefore);
  });
});
