import { test, expect, type Page } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject a no-op `window.desktopBridge.preview` before the page loads so the
 * PreviewPanel branches into the chrome-rendering path instead of the
 * "open Mcode from Electron" empty state. Methods resolve with safe defaults
 * so the bridge contract is satisfied without driving any real IPC.
 */
async function injectPreviewBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
    const tabCreateOk = (threadId: string): Promise<unknown> =>
      Promise.resolve({
        ok: true,
        data: { tabSet: emptyTabSet(threadId), createdTabId: "mock-tab" },
      });

    // The pick promise stays pending until something explicitly cancels it,
    // so toggling design mode in tests is observable (the loop awaits this
    // promise and only exits on resolution; returning {ok:false} synchronously
    // would flip the mode back off before assertions can see aria-pressed=true).
    // cancelCapture resolves it with the cancelled sentinel so the Exit pill
    // path also matches real behaviour (real main process aborts the IPC).
    let pickResolver: ((v: { ok: false; error: string }) => void) | null = null;
    const preview = {
      sync: noop,
      navigate: () => Promise.resolve({ ok: true } as const),
      goBack: () => Promise.resolve(false),
      goForward: () => Promise.resolve(false),
      reload: noop,
      openExternal: noop,
      openGuestDevTools: noop,
      onShortcutFired: unsub,
      getNavigationState: () =>
        Promise.resolve({ canGoBack: false, canGoForward: false }),
      capturePictureReference: captureFail,
      capturePictureReferenceRegion: captureFail,
      capturePictureReferenceElementPick: () =>
        new Promise<{ ok: false; error: string }>((resolve) => {
          pickResolver = resolve;
        }),
      capturePageContext: () =>
        Promise.resolve({ ok: false, error: "no-preview" } as const),
      releaseBrowserCaptureSpills: noop,
      // Fire onPageStatus synchronously on subscribe with a fake URL so the
      // panel's hasLoadedPage state flips to true. The capture / design
      // buttons are now gated on hasLoadedPage to avoid no-op clicks on an
      // empty preview, which would otherwise leave the click-based tests
      // (Design aria-pressed, Exit pill, dock rows) firing against disabled
      // buttons.
      onPageStatus: (
        cb: (s: {
          url: string | null;
          title: string | null;
          favicon: string | null;
          phase: "loading" | "loaded" | "error" | "discarded";
        }) => void,
      ) => {
        cb({ url: "https://example.com", title: "Example", favicon: null, phase: "loaded" });
        return () => undefined;
      },
      cancelCapture: () => {
        if (pickResolver) {
          const resolver = pickResolver;
          pickResolver = null;
          resolver({ ok: false, error: "cancelled" });
        }
        return Promise.resolve();
      },
      tabs: {
        list: (threadId: string) => tabOk(threadId),
        create: (threadId: string) => tabCreateOk(threadId),
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
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = { preview };
  });
}

/**
 * Open the app at a thread so the right panel can be revealed for preview tests.
 * Returns once the thread view is rendered and ready for shortcut input.
 */
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

/**
 * Open the preview tab in the right panel via the mod+shift+b shortcut.
 * After clicking a thread, focus lives in the composer's contenteditable
 * and the `!inputFocused` when-clause on mod+shift+b would otherwise
 * swallow the keystroke; blur the active element first so the binding
 * fires reliably.
 */
async function openPreviewTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("Control+Shift+B");
  await page.waitForSelector(
    "[data-testid='preview-panel'], [data-testid='preview-panel-unavailable']",
    { timeout: 5000 },
  );
}

// ---------------------------------------------------------------------------
// Tests — preview unavailable (no desktopBridge)
// ---------------------------------------------------------------------------

test.describe("PreviewPanel — desktopBridge absent", () => {
  test("renders the empty state when no bridge is injected", async ({ page }) => {
    await openAppAtThread(page);
    await openPreviewTab(page);
    // Without the bridge, PreviewPanel short-circuits to the unavailable view.
    await expect(page.getByTestId("preview-panel-unavailable")).toBeVisible();
    await expect(page.getByText(/Embedded preview runs in the desktop app/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests — preview chrome (bridge mocked)
// ---------------------------------------------------------------------------

test.describe("PreviewPanel — chrome with mocked bridge", () => {
  test.beforeEach(async ({ page }) => {
    await injectPreviewBridge(page);
    await openAppAtThread(page);
    await openPreviewTab(page);
  });

  test("toolbar renders the three primary action buttons", async ({ page }) => {
    await expect(page.getByLabel("Back")).toBeVisible();
    await expect(page.getByLabel("Forward")).toBeVisible();
    await expect(page.getByLabel("Reload")).toBeVisible();
    await expect(page.getByLabel("Design")).toBeVisible();
    await expect(page.getByLabel("Screenshot")).toBeVisible();
    await expect(page.getByLabel("Toggle capture tools")).toBeVisible();
    await expect(page.getByLabel("Open in system browser")).toBeVisible();
  });

  test("legacy capture buttons are gone from the primary toolbar", async ({ page }) => {
    await expect(page.getByLabel("Crop region")).toHaveCount(0);
    await expect(page.getByLabel("Pick element")).toHaveCount(0);
    await expect(page.getByLabel("Capture viewport")).toHaveCount(0);
    await expect(page.getByLabel("Attach page context")).toHaveCount(0);
  });

  test("capture dock toggles open via the toolbar button", async ({ page }) => {
    await expect(page.getByTestId("preview-dev-dock")).toHaveCount(0);
    await page.getByLabel("Toggle capture tools").click();
    await expect(page.getByTestId("preview-dev-dock")).toBeVisible();
  });

  test("capture dock toggles open via mod+shift+d", async ({ page }) => {
    await expect(page.getByTestId("preview-dev-dock")).toHaveCount(0);
    // Opening the preview via Ctrl+Shift+B in beforeEach auto-focuses the
    // omnibox (preview.toggle requests omnibox focus on its showing branch).
    // The omnibox is an input, so the inputFocused context flips true and
    // would swallow Ctrl+Shift+D (gated on !inputFocused). Blur first so the
    // shortcut reaches the keybinding manager.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press("Control+Shift+D");
    await expect(page.getByTestId("preview-dev-dock")).toBeVisible();
  });

  test("dock surfaces Region and Page context rows", async ({ page }) => {
    await page.getByLabel("Toggle capture tools").click();
    // Scope text matches inside each row's testid because the dock surface
    // repeats the row title in the helper sub-line ("Page context" appears
    // in both the title span and "Attach structured page context..." span).
    const regionRow = page.getByTestId("preview-dev-dock-region");
    const contextRow = page.getByTestId("preview-dev-dock-context");
    await expect(regionRow).toBeVisible();
    await expect(contextRow).toBeVisible();
    await expect(regionRow.getByText("Region capture", { exact: true })).toBeVisible();
    await expect(contextRow.getByText("Page context", { exact: true })).toBeVisible();
  });

  test("dock edge can flip from bottom to right via the dock header", async ({ page }) => {
    await page.getByLabel("Toggle capture tools").click();
    const dock = page.getByTestId("preview-dev-dock");
    await expect(dock).toHaveAttribute("data-edge", "bottom");
    await page.getByLabel("Dock to right").click();
    await expect(dock).toHaveAttribute("data-edge", "right");
  });

  test("dock closes via the header X", async ({ page }) => {
    await page.getByLabel("Toggle capture tools").click();
    await expect(page.getByTestId("preview-dev-dock")).toBeVisible();
    await page.getByLabel("Close capture tools").click();
    await expect(page.getByTestId("preview-dev-dock")).toHaveCount(0);
  });

  test("design mode aria-pressed flips when toggled", async ({ page }) => {
    // Use exact: true on getByRole to scope to the toolbar Design button
    // and exclude the "Exit design mode" pill (whose accessible name also
    // starts with "Design") which appears once the mode is active.
    const designBtn = page.getByRole("button", { name: "Design", exact: true });
    await expect(designBtn).toHaveAttribute("aria-pressed", "false");
    await designBtn.click();
    await expect(designBtn).toHaveAttribute("aria-pressed", "true");
  });

  test("design mode exit pill is the affordance off and click exits the mode", async ({ page }) => {
    const designBtn = page.getByRole("button", { name: "Design", exact: true });
    // No pill until mode is active.
    await expect(page.getByLabel("Exit design mode")).toHaveCount(0);
    await designBtn.click();
    await expect(page.getByLabel("Exit design mode")).toBeVisible();
    await page.getByLabel("Exit design mode").click();
    await expect(page.getByLabel("Exit design mode")).toHaveCount(0);
    await expect(designBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("dock splitter is rendered with the correct orientation when open", async ({ page }) => {
    await page.getByLabel("Toggle capture tools").click();
    const splitter = page.getByTestId("preview-dock-splitter");
    await expect(splitter).toBeVisible();
    await expect(splitter).toHaveAttribute("aria-orientation", "horizontal");
    // Flip the dock to the right; splitter should re-orient.
    await page.getByLabel("Dock to right").click();
    await expect(splitter).toHaveAttribute("aria-orientation", "vertical");
  });
});
