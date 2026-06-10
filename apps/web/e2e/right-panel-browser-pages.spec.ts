import { test, expect, type Page } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-1",
  name: "Test Workspace",
  path: "/test/path",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: now,
  updated_at: now,
};

const THREAD = {
  id: "thread-1",
  workspace_id: "ws-1",
  title: "Test Thread",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: now,
  updated_at: now,
  model: "claude-sonnet-4-6",
  provider: "claude",
  deleted_at: null,
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  copilot_agent: null,
  parent_thread_id: null,
  forked_from_message_id: null,
  last_compact_summary: null,
};

/**
 * Inject a stateful `window.desktopBridge.preview` whose tab surface maintains a
 * per-call tab set and pushes `onUpdated` on every mutation, so the activity
 * rail's page switcher (seeded from `list` and reconciled from pushes) can be
 * driven end-to-end. Two pages start out: Alpha (active) and Beta.
 */
async function injectMultiPageBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const noop = (): Promise<void> => Promise.resolve();
    const unsub = (): (() => void) => () => undefined;

    interface MockTab {
      id: string;
      threadId: string;
      title: string | null;
      url: string | null;
      faviconUrl: string | null;
      warm: boolean;
      active: boolean;
    }
    const state: { tabs: MockTab[]; activeTabId: string | null; seq: number } = {
      seq: 2,
      activeTabId: "alpha",
      tabs: [
        { id: "alpha", threadId: "thread-1", title: "Alpha", url: "https://alpha.test", faviconUrl: null, warm: true, active: true },
        { id: "beta", threadId: "thread-1", title: "Beta", url: "https://beta.test", faviconUrl: null, warm: false, active: false },
      ],
    };
    const listeners: ((s: unknown) => void)[] = [];
    const snapshot = (threadId: string) => ({
      threadId,
      activeTabId: state.activeTabId,
      tabs: state.tabs.map((t) => ({ ...t, active: t.id === state.activeTabId })),
    });
    const emit = (threadId: string) => {
      for (const l of listeners) l(snapshot(threadId));
    };

    const preview = {
      sync: noop,
      navigate: () => Promise.resolve({ ok: true } as const),
      detectLocalPorts: () => Promise.resolve([]),
      goBack: () => Promise.resolve(false),
      goForward: () => Promise.resolve(false),
      reload: noop,
      openExternal: noop,
      openGuestDevTools: noop,
      onShortcutFired: unsub,
      getNavigationState: () => Promise.resolve({ canGoBack: false, canGoForward: false }),
      capturePictureReference: () => Promise.resolve({ ok: false, error: "no-preview" } as const),
      capturePictureReferenceRegion: () => Promise.resolve({ ok: false, error: "no-preview" } as const),
      capturePictureReferenceElementPick: () => new Promise(() => undefined),
      capturePageContext: () => Promise.resolve({ ok: false, error: "no-preview" } as const),
      releaseBrowserCaptureSpills: noop,
      // Emit a blank page-status so the active page keeps its own tab title in
      // the rail (the overlay falls back to the tab's chrome on null fields).
      onPageStatus: (cb: (s: unknown) => void) => {
        cb({ url: null, title: null, favicon: null, phase: "loaded" });
        return () => undefined;
      },
      cancelCapture: noop,
      tabs: {
        list: (threadId: string) => Promise.resolve({ ok: true as const, data: snapshot(threadId) }),
        create: (threadId: string) => {
          const id = `tab-${++state.seq}`;
          state.tabs.push({ id, threadId, title: null, url: null, faviconUrl: null, warm: true, active: true });
          state.activeTabId = id;
          emit(threadId);
          return Promise.resolve({ ok: true as const, data: { tabId: id, tabs: snapshot(threadId) } });
        },
        activate: (threadId: string, tabId: string) => {
          state.activeTabId = tabId;
          emit(threadId);
          return Promise.resolve({ ok: true as const, data: snapshot(threadId) });
        },
        close: (threadId: string, tabId: string) => {
          const idx = state.tabs.findIndex((t) => t.id === tabId);
          if (idx !== -1) state.tabs.splice(idx, 1);
          if (state.tabs.length === 0) {
            const id = `tab-${++state.seq}`;
            state.tabs.push({ id, threadId, title: null, url: null, faviconUrl: null, warm: true, active: true });
            state.activeTabId = id;
          } else if (state.activeTabId === tabId) {
            state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)].id;
          }
          emit(threadId);
          return Promise.resolve({ ok: true as const, data: snapshot(threadId) });
        },
        onUpdated: (cb: (s: unknown) => void) => {
          listeners.push(cb);
          return () => {
            const i = listeners.indexOf(cb);
            if (i !== -1) listeners.splice(i, 1);
          };
        },
      },
      getPerfCounters: () =>
        Promise.resolve({ ramKb: 0, frameRateHz: 60, gpuProcessActive: false, allocationsPerSec: 0 }),
      adoptWebview: () => Promise.resolve({ ok: true } as const),
      releaseWebview: () => Promise.resolve({ ok: true } as const),
      design: {
        setViewport: () => Promise.resolve({ ok: true, data: { width: 0, height: 0 } } as const),
        resetViewport: noop,
        setInspect: () => Promise.resolve({ ok: true } as const),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = { preview };
  });
}

async function openAppAtThread(page: Page): Promise<void> {
  await mockWebSocketServer(page, {
    "workspace.list": [WORKSPACE],
    "thread.list": [THREAD],
    "message.list": { messages: [], hasMore: false, answeredPlanMessageIds: [] },
  });
  await page.goto("/");
  await page.waitForSelector("text=Test Workspace", { timeout: 15000 });
  await page.locator("text=Test Workspace").click();
  await page.waitForSelector("[data-testid='thread-item']", { timeout: 10000 });
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector('[contenteditable="true"]', { timeout: 10000 });
}

async function openPreviewTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("Control+Shift+B");
  await page.waitForSelector("[data-testid='preview-panel']", { timeout: 5000 });
}

test.describe("Right panel browser pages (rail page switcher)", () => {
  test.beforeEach(async ({ page }) => {
    await injectMultiPageBridge(page);
    await page.setViewportSize({ width: 1920, height: 900 });
    await openAppAtThread(page);
    await openPreviewTab(page);
  });

  test("renders open pages as a favicon group in the rail, active highlighted", async ({ page }) => {
    const group = page.getByTestId("rail-browser-pages");
    await expect(group).toBeVisible();
    const pages = page.locator("[data-rail-browser-page]");
    await expect(pages).toHaveCount(2);

    const alpha = page.locator('[data-rail-browser-page="alpha"]');
    await expect(alpha).toHaveAttribute("data-active", "true");
    await expect(alpha).toHaveClass(/text-primary/);
  });

  test("clicking a page entry switches the active page", async ({ page }) => {
    const beta = page.locator('[data-rail-browser-page="beta"]');
    await beta.click();
    await expect(beta).toHaveAttribute("data-active", "true");
    await expect(page.locator('[data-rail-browser-page="alpha"]')).not.toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("closing a page via its hover-× removes that entry", async ({ page }) => {
    const beta = page.locator('[data-rail-browser-page="beta"]');
    await beta.hover();
    await page.getByRole("button", { name: "Close page Beta" }).click();
    await expect(page.locator("[data-rail-browser-page]")).toHaveCount(1);
    await expect(page.locator('[data-rail-browser-page="alpha"]')).toBeVisible();
  });

  test("closing the last page closes the Browser tab", async ({ page }) => {
    // Close Beta, then Alpha (the last page) — the Browser tab collapses to the
    // empty-state card grid.
    const beta = page.locator('[data-rail-browser-page="beta"]');
    await beta.hover();
    await page.getByRole("button", { name: "Close page Beta" }).click();
    await expect(page.locator("[data-rail-browser-page]")).toHaveCount(1);

    const alpha = page.locator('[data-rail-browser-page="alpha"]');
    await alpha.hover();
    await page.getByRole("button", { name: "Close page Alpha" }).click();

    await expect(page.getByTestId("panel-empty-state")).toBeVisible();
    await expect(page.locator("[data-rail-browser-page]")).toHaveCount(0);
  });

  test("New page in the header kebab adds a rail entry", async ({ page }) => {
    await page.getByLabel("More browser tools").click();
    await page.getByRole("menuitem", { name: "New page" }).click();
    await expect(page.locator("[data-rail-browser-page]")).toHaveCount(3);
  });
});
