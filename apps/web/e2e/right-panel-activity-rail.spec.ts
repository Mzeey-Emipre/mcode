import { test, expect, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-activity-rail",
  name: "Activity Rail",
  path: "/tmp/activity-rail",
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

const THREAD = makeThread("thread-activity-rail", "Rail Thread");

/** Supplies the preview bridge methods used while Browser chrome is mounted. */
async function injectPreviewBridge(page: Page): Promise<void> {
  await page.evaluate(() => {
    const noop = (): Promise<void> => Promise.resolve();
    const captureFail = (): Promise<{ ok: false; error: string }> =>
      Promise.resolve({ ok: false, error: "no-preview" });
    const unsub = (): (() => void) => () => undefined;
    const emptyTabSet = (threadId: string): unknown => ({
      threadId,
      activeTabId: null,
      tabs: [],
    });
    const tabOk = (threadId: string): Promise<unknown> =>
      Promise.resolve({ ok: true, data: emptyTabSet(threadId) });
    const preview = {
      sync: noop,
      navigate: () => Promise.resolve({ ok: true } as const),
      goBack: () => Promise.resolve(false),
      goForward: () => Promise.resolve(false),
      reload: noop,
      forceReload: noop,
      openExternal: noop,
      openGuestDevTools: noop,
      onShortcutFired: unsub,
      getNavigationState: () =>
        Promise.resolve({ canGoBack: false, canGoForward: false }),
      capturePictureReference: captureFail,
      capturePictureReferenceRegion: captureFail,
      capturePictureReferenceElementPick: captureFail,
      capturePageContext: captureFail,
      releaseBrowserCaptureSpills: noop,
      onPageStatus: (
        callback: (status: {
          url: string | null;
          title: string | null;
          favicon: string | null;
          phase: "loaded";
        }) => void,
      ) => {
        callback({ url: null, title: null, favicon: null, phase: "loaded" });
        return () => undefined;
      },
      cancelCapture: noop,
      tabs: {
        list: (threadId: string) => tabOk(threadId),
        create: (threadId: string) =>
          Promise.resolve({
            ok: true,
            data: { tabSet: emptyTabSet(threadId), createdTabId: "mock-tab" },
          }),
        activate: (threadId: string) => tabOk(threadId),
        close: (threadId: string) => tabOk(threadId),
        onUpdated: unsub,
      },
      getPerfCounters: () =>
        Promise.resolve({
          ramKb: 0,
          frameRateHz: 60,
          gpuProcessActive: false,
          allocationsPerSec: 0,
        }),
      adoptWebview: () => Promise.resolve({ ok: true } as const),
      releaseWebview: () => Promise.resolve({ ok: true } as const),
      design: {
        setViewport: () =>
          Promise.resolve({ ok: true, data: { width: 0, height: 0 } } as const),
        resetViewport: noop,
        setInspect: () => Promise.resolve({ ok: true } as const),
        setAnnotationGuard: () => Promise.resolve({ ok: true } as const),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = { preview };
  });
}

/**
 * Seeds the stores and opens the right panel, optionally with an active thread
 * and a list of tabs pre-opened (in order; the last becomes active). With no
 * tabs the panel renders its empty-state card grid.
 */
async function seed(
  page: Page,
  opts: { thread?: boolean; tabs?: readonly string[] } = {},
): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, wid, tid, withThread, tabs }) => {
      const stores: unknown[] =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const getState = (s: unknown) =>
        (s as { getState: () => Record<string, unknown> }).getState();

      const wsStore = stores.find(
        (s) => "activeThreadId" in getState(s) && "threads" in getState(s),
      );
      (wsStore as { setState: (p: unknown) => void } | undefined)?.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: withThread ? [thread] : [],
        activeThreadId: withThread ? tid : null,
        pendingNewThread: !withThread,
      });

      const diffStore = stores.find((s) => "showRightPanel" in getState(s));
      if (diffStore) {
        const api = (
          diffStore as {
            getState: () => {
              showRightPanel: (id: string, threadId?: string) => void;
              setRightPanelTab: (id: string, threadId: string | null, t: string) => void;
            };
          }
        ).getState();
        api.showRightPanel(wid, withThread ? tid : undefined);
        for (const t of tabs) api.setRightPanelTab(wid, withThread ? tid : null, t);
      }
    },
    {
      workspace: WORKSPACE,
      thread: THREAD,
      wid: WORKSPACE.id,
      tid: THREAD.id,
      withThread: opts.thread ?? false,
      tabs: opts.tabs ?? [],
    },
  );
}

test.describe("Right panel activity rail", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD],
      "thread.getTasks": [],
      "snapshot.listByThread": [],
      "terminal.create": { ptyId: "pty-rail", shell: "bash" },
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

  test("switches the active tab when a rail icon is clicked", async ({ page }) => {
    // Browser then Terminal open; Terminal is active (opened last).
    await seed(page, { tabs: ["preview", "terminal"] });

    const browserIcon = page.locator('[data-rail-tab="preview"]');
    const terminalIcon = page.locator('[data-rail-tab="terminal"]');
    await expect(browserIcon).toBeVisible();
    await expect(terminalIcon).toHaveClass(/text-primary/);

    // Clicking the Browser icon moves the active lamp to it.
    await browserIcon.click();
    await expect(browserIcon).toHaveClass(/text-primary/);
    await expect(terminalIcon).not.toHaveClass(/text-primary/);
  });

  test("closes a tab via its hover-× and refocuses a survivor", async ({ page }) => {
    await seed(page, { tabs: ["preview", "terminal"] });

    const terminalIcon = page.locator('[data-rail-tab="terminal"]');
    await terminalIcon.hover();
    // The × is a sibling control revealed on hover; its name carries the tab label.
    await page.getByRole("button", { name: "Close Terminal" }).click();

    // Terminal is gone and Browser takes the active lamp.
    await expect(page.locator('[data-rail-tab="terminal"]')).toHaveCount(0);
    await expect(page.locator('[data-rail-tab="preview"]')).toHaveClass(/text-primary/);

    // Closing the last tab returns to the empty-state tool list; the panel toggle stays on the rail.
    await page.locator('[data-rail-tab="preview"]').hover();
    await page.getByRole("button", { name: "Close Browser" }).click();
    await expect(page.getByTestId("panel-empty-state")).toBeVisible();
    await expect(page.getByTestId("rail-panel-toggle")).toBeVisible();
  });

  test("panel toggle is visible in the empty state", async ({ page }) => {
    await seed(page);

    await expect(page.getByTestId("panel-empty-state")).toBeVisible();
    await expect(page.getByTestId("rail-panel-toggle")).toBeVisible();
    await expect(page.getByTestId("rail-panel-toggle")).toHaveAttribute(
      "aria-label",
      "Close panel",
    );
    await expect(page.getByTestId("rail-maximize-toggle")).toHaveAttribute(
      "aria-label",
      "Maximize panel",
    );
  });

  test("maximizes and restores the panel from the expanded rail", async ({ page }) => {
    await seed(page, { tabs: ["preview"] });

    const panel = page.getByTestId("right-panel");
    const rail = page.getByTestId("activity-rail");
    const maximizeToggle = page.getByTestId("rail-maximize-toggle");
    const inlineWidth = await panel.evaluate((element) => element.getBoundingClientRect().width);

    await rail.hover({ position: { x: 24, y: 16 } });
    await expect(rail).toHaveAttribute("data-expanded", "true");
    await expect(maximizeToggle).toBeVisible();
    await maximizeToggle.click();

    await expect(maximizeToggle).toHaveAttribute("aria-label", "Restore panel");
    await expect
      .poll(() => panel.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(inlineWidth);

    await maximizeToggle.click();

    await expect(maximizeToggle).toHaveAttribute("aria-label", "Maximize panel");
    await expect
      .poll(() => panel.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
      .toBe(Math.round(inlineWidth));
  });

  test("overlays Browser chrome without shifting content and aligns trailing controls", async ({
    page,
  }) => {
    await injectPreviewBridge(page);
    await seed(page, { tabs: ["preview", "terminal"] });

    const rail = page.getByTestId("activity-rail");
    const contentPane = rail.locator("xpath=following-sibling::*[1]");
    const terminalClose = page.getByRole("button", { name: "Close Terminal" });
    const maximizeToggle = page.getByTestId("rail-maximize-toggle");
    const contentBefore = await contentPane.boundingBox();

    await rail.hover({ position: { x: 24, y: 16 } });
    await expect(rail).toHaveAttribute("data-expanded", "true");

    const contentAfter = await contentPane.boundingBox();
    expect(contentBefore).not.toBeNull();
    expect(contentAfter).not.toBeNull();
    expect(contentAfter!.x).toBeCloseTo(contentBefore!.x, 5);
    expect(contentAfter!.width).toBeCloseTo(contentBefore!.width, 5);

    const [closeBox, maximizeBox] = await Promise.all([
      terminalClose.boundingBox(),
      maximizeToggle.boundingBox(),
    ]);
    expect(closeBox).not.toBeNull();
    expect(maximizeBox).not.toBeNull();
    expect(Math.abs(closeBox!.x + closeBox!.width - (maximizeBox!.x + maximizeBox!.width))).toBeLessThanOrEqual(1);

    await page.locator('[data-rail-tab="preview"]').click();
    const browserHeader = page.getByTestId("browser-header");
    await expect(browserHeader).toBeVisible();

    const overlayCoverage = await page.evaluate(() => {
      const railElement = document.querySelector<HTMLElement>('[data-testid="activity-rail"]');
      const overlay = railElement?.firstElementChild as HTMLElement | null;
      const header = document.querySelector<HTMLElement>('[data-testid="browser-header"]');
      if (!railElement || !overlay || !header) return null;
      const overlayRect = overlay.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const overlapLeft = Math.max(overlayRect.left, headerRect.left);
      const overlapRight = Math.min(overlayRect.right, headerRect.right);
      const y = headerRect.top + headerRect.height / 2;
      const sampleXs = [overlapLeft + 4, (overlapLeft + overlapRight) / 2, overlapRight - 4];
      return {
        overlayWidth: overlayRect.width,
        covered: sampleXs.every((x) => railElement.contains(document.elementFromPoint(x, y))),
      };
    });

    expect(overlayCoverage).toEqual({ overlayWidth: 160, covered: true });
  });

  test("add control: hidden when nothing is creatable", async ({ page }) => {
    // Threadless with every creatable tab open (Browser, Terminal, Review).
    await seed(page, { tabs: ["preview", "terminal", "changes"] });

    const rail = page.getByTestId("activity-rail");
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("button", { name: /^New / })).toHaveCount(0);
  });

  test("add control: one creatable type opens directly", async ({ page }) => {
    // Threadless with Browser and Terminal open → Review is the sole creatable type.
    await seed(page, { tabs: ["preview", "terminal"] });

    const addDirect = page.getByRole("button", { name: "New Review" });
    await expect(addDirect).toBeVisible();
    // No menu trigger when a single type opens directly.
    await expect(page.getByRole("button", { name: "New tab" })).toHaveCount(0);

    await addDirect.click();
    await expect(page.locator('[data-rail-tab="review"]')).toHaveClass(/text-primary/);
  });

  test("add control: several creatable types show a menu", async ({ page }) => {
    // Thread scope with only Scope open → Browser, Terminal, Review remain.
    await seed(page, { thread: true, tabs: ["tasks"] });

    const addMenu = page.getByRole("button", { name: "New tab" });
    await expect(addMenu).toBeVisible();
    await addMenu.click();

    // The menu presents the creatable set plus the Files coming-soon teaser.
    await expect(page.getByRole("menuitem", { name: /Browser/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Review/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Files/ })).toBeDisabled();

    // Choosing Terminal opens and activates it.
    await page.getByRole("menuitem", { name: /Terminal/ }).click();
    await expect(page.locator('[data-rail-tab="terminal"]')).toHaveClass(/text-primary/);
  });

  test("rail panel toggle hides the panel and mod+alt+b reopens it", async ({ page }) => {
    await seed(page, { tabs: ["terminal"] });

    const chatMain = page.locator("main").filter({ has: page.getByTestId("new-thread-welcome") });
    const projectTree = page.getByRole("button", { name: "Open project Activity Rail" });
    const railToggle = page.getByTestId("rail-panel-toggle");

    await expect(chatMain).toBeVisible();
    await expect(projectTree).toBeVisible();
    await expect(railToggle).toBeVisible();

    await railToggle.click();
    await expect(page.getByTestId("right-panel")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByTestId("right-panel")).toHaveCSS("width", "0px");
    await expect(chatMain).toBeVisible();
    await expect(projectTree).toBeVisible();

    await page.keyboard.press("Control+Alt+b");
    await expect(page.getByTestId("right-panel")).toHaveAttribute("aria-hidden", "false");
    await expect(page.getByTestId("activity-rail")).toBeVisible();
    await expect(page.getByTestId("rail-panel-toggle")).toHaveAttribute(
      "aria-label",
      "Close panel",
    );
  });
});
