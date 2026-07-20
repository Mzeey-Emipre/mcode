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

/** Clears the scope's local terminal list without retriggering auto-start. */
async function clearTerminals(page: Page, threadId: string): Promise<void> {
  await page.evaluate((tid) => {
    const stores: unknown[] =
      (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const termStore = stores.find(
      (s) => "removeAllTerminals" in (s as { getState: () => Record<string, unknown> }).getState(),
    );
    (
      termStore as
        | { getState: () => { removeAllTerminals: (scopeId: string) => void } }
        | undefined
    )?.getState().removeAllTerminals(tid);
  }, threadId);
}

async function openPanelOnScope(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, tid, wid }) => {
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
              showRightPanel: (id: string, threadId?: string) => void;
              setRightPanelTab: (id: string, t: string) => void;
            };
          }
        ).getState();
        api.showRightPanel(wid, tid);
        // Leave the panel on its empty-state card grid so the Terminal can be
        // opened through the real create surface.
      }
    },
    { workspace: WORKSPACE, thread: THREAD, tid: THREAD.id, wid: WORKSPACE.id },
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

    await page.getByTestId("panel-card-terminal").click();

    // Opening the tab spawns one without the user clicking "New terminal".
    await expect.poll(() => terminalCount(page, THREAD.id), { timeout: 5_000 }).toBe(1);
    await expect(page.getByText("No terminals")).toHaveCount(0);
  });

  test("expanded rail stays opaque above terminal content", async ({ page }) => {
    await openPanelOnScope(page);
    await page.getByTestId("panel-card-terminal").click();
    await expect.poll(() => terminalCount(page, THREAD.id), { timeout: 5_000 }).toBe(1);

    const rail = page.getByTestId("activity-rail");
    const railSurface = rail.locator(":scope > div");
    const resizeHandle = page.getByRole("separator", { name: "Resize panel" });
    const terminalSlot = page.getByTestId("terminal-pool-slot");
    const slotWidthBefore = await terminalSlot.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await rail.hover({ position: { x: 24, y: 16 } });
    await expect(rail).toHaveAttribute("data-expanded", "true");

    await expect
      .poll(() =>
        railSurface.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(160);
    const railBox = await rail.boundingBox();
    const resizeHandleBox = await resizeHandle.boundingBox();
    expect(railBox).not.toBeNull();
    expect(resizeHandleBox).not.toBeNull();
    await expect
      .poll(() => terminalSlot.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(slotWidthBefore);
    const railAlpha = await railSurface.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable");
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    });
    expect(railAlpha).toBe(255);

    expect(
      await resizeHandle.evaluate(
        (element, { x, y }) => element.contains(document.elementFromPoint(x, y)),
        { x: resizeHandleBox!.x + 1, y: railBox!.y + 92 },
      ),
    ).toBe(true);

    const hitExpandedRail = () => page.evaluate(
      ({ x, y }) => {
        const railElement = document.querySelector('[data-testid="activity-rail"]');
        const hit = document.elementFromPoint(x, y);
        const ancestry: string[] = [];
        let current: Element | null = hit;
        while (current && ancestry.length < 6) {
          const style = getComputedStyle(current);
          ancestry.push(
            `${current.tagName.toLowerCase()}.${current.className} z=${style.zIndex} position=${style.position}`,
          );
          current = current.parentElement;
        }
        return {
          insideRail: Boolean(railElement && hit && railElement.contains(hit)),
          ancestry,
        };
      },
      { x: railBox!.x + 100, y: railBox!.y + 92 },
    );

    const activeTerminalHit = await hitExpandedRail();
    expect(activeTerminalHit.insideRail, activeTerminalHit.ancestry.join("\n")).toBe(true);

    await clearTerminals(page, THREAD.id);
    await expect(page.getByText("No terminals")).toBeVisible();

    const emptyTerminalHit = await hitExpandedRail();
    expect(emptyTerminalHit.insideRail, emptyTerminalHit.ancestry.join("\n")).toBe(true);
  });
});
