import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-term-threadless",
  name: "Threadless WS",
  path: "/tmp/term-threadless",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

/** Reads how many terminals the store holds for a scope (thread or workspace). */
async function terminalCount(page: Page, scopeId: string): Promise<number> {
  return page.evaluate((sid) => {
    const stores: unknown[] =
      (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const termStore = stores.find(
      (s) => "addTerminal" in (s as { getState: () => Record<string, unknown> }).getState(),
    );
    if (!termStore) return -1;
    const terminals = (
      termStore as { getState: () => { terminals: Record<string, unknown[]> } }
    ).getState().terminals[sid];
    return terminals ? terminals.length : 0;
  }, scopeId);
}

/**
 * Enters the new-thread composer view (a workspace is active but no thread is)
 * and opens the right panel threadless on the Scope tab. This is the state the
 * user sees before sending the first message, where the Terminal must still run
 * against the workspace's local checkout.
 */
async function openThreadlessPanel(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, wid }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) =>
        (s as { getState: () => Record<string, unknown> }).getState();
      const wsStore = stores.find(
        (s) => "activeThreadId" in getState(s) && "pendingNewThread" in getState(s),
      );
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [],
        activeThreadId: null,
        // New-thread composer view: panel renders without a thread.
        pendingNewThread: true,
      });
      const diffStore = stores.find((s) => "showRightPanel" in getState(s));
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              showRightPanel: (id: string, threadId?: string) => void;
              setRightPanelTab: (id: string, t: string) => void;
            };
          }
        ).getState();
        // No thread id → threadless workspace visibility. Leave the panel on
        // its empty-state card grid so the Terminal opens via the create surface.
        api.showRightPanel(wid);
      }
    },
    { workspace: WORKSPACE, wid: WORKSPACE.id },
  );
}

test.describe("Right panel threadless terminal", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [],
      "terminal.create": { ptyId: "pty-term-threadless", shell: "bash" },
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

  test("opening the Terminal tab with no active thread spawns a workspace-scoped shell", async ({
    page,
  }) => {
    await openThreadlessPanel(page);

    // No terminals exist for the workspace scope before the tab is opened.
    expect(await terminalCount(page, WORKSPACE.id)).toBe(0);

    await page.getByTestId("panel-card-terminal").click();

    // The shell is keyed by the workspace id (the threadless scope), not a thread.
    await expect.poll(() => terminalCount(page, WORKSPACE.id), { timeout: 5_000 }).toBe(1);
    await expect(page.getByText("No terminals")).toHaveCount(0);
  });
});
