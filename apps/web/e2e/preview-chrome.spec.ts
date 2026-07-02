import { test, expect, type Page } from "@playwright/test";
import {
  interceptZustandStores,
  mockWebSocketServer,
} from "./helpers/e2e-helpers";

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

/** A detected localhost port the mocked bridge advertises to the empty state. */
interface MockPort {
  readonly port: number;
  readonly name: string;
  readonly online: boolean;
}

/** Options controlling the mocked preview bridge's initial state. */
interface InjectOptions {
  /** When false, the bridge reports no loaded page so the empty state shows. */
  readonly loaded?: boolean;
  /** Ports the empty-state list should render via detectLocalPorts. */
  readonly ports?: readonly MockPort[];
}

/**
 * Inject a no-op `window.desktopBridge.preview` before the page loads so the
 * PreviewPanel branches into the chrome-rendering path instead of the
 * "open Mcode from Electron" empty state. Methods resolve with safe defaults
 * so the bridge contract is satisfied without driving any real IPC.
 *
 * `loaded` (default true) drives whether onPageStatus reports a real page, so a
 * test can exercise either the loaded header or the empty localhost-ports body.
 * Navigations are recorded on `window.__mcodeNav` so port-card clicks are
 * observable.
 */
async function injectPreviewBridge(
  page: Page,
  options: InjectOptions = {},
): Promise<void> {
  const loaded = options.loaded ?? true;
  const ports = options.ports ?? [];
  await page.addInitScript(
    ({ loaded, ports }) => {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mcodeNav = [] as string[];
    const preview = {
      sync: noop,
      navigate: (url: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__mcodeNav.push(url);
        return Promise.resolve({ ok: true } as const);
      },
      detectLocalPorts: () => Promise.resolve(ports),
      goBack: () => Promise.resolve(false),
      goForward: () => Promise.resolve(false),
      reload: noop,
      forceReload: noop,
      clearCookies: noop,
      clearCache: noop,
      getZoom: () => Promise.resolve(1),
      setZoom: (factor: number) => Promise.resolve(factor),
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
      // Fire onPageStatus synchronously on subscribe. When `loaded`, report a
      // real URL so hasLoadedPage flips true and the loaded header (Design /
      // Screenshot, hover reload) renders; the capture / design buttons are
      // gated on hasLoadedPage to avoid no-op clicks on an empty preview. When
      // not loaded, report a blank surface so the empty localhost-ports body
      // owns the panel.
      onPageStatus: (
        cb: (s: {
          url: string | null;
          title: string | null;
          favicon: string | null;
          phase: "loading" | "loaded" | "error" | "discarded";
        }) => void,
      ) => {
        const status = loaded
          ? { url: "https://example.com", title: "Example", favicon: null, phase: "loaded" as const }
          : { url: null, title: null, favicon: null, phase: "loaded" as const };
        cb(status);
        // The first emit moves storedUrl off "", which re-runs the bridge's
        // per-thread reset and blanks the title. A real guest re-emits
        // page-title-updated after navigation settles; mirror that so the
        // loaded title survives (storedUrl is now stable, so no further reset).
        if (loaded) setTimeout(() => cb(status), 0);
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
        setAnnotationGuard: () => Promise.resolve({ ok: true } as const),
      },
    };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).desktopBridge = { preview };
    },
    { loaded, ports },
  );
}

/**
 * Layer an error page-status over the base bridge: after {@link injectPreviewBridge}
 * sets `window.desktopBridge.preview`, override the methods the error panel
 * touches so onPageStatus emits `phase: "error"`, navigation history is
 * configurable, and Retry / Open in browser are observable via window counters.
 */
async function injectErrorBridge(
  page: Page,
  opts: { url: string | null; canGoBack: boolean },
): Promise<void> {
  await page.addInitScript((o) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const preview = w.desktopBridge.preview;
    w.__mcodePreview = { reload: 0, openExternal: 0 };
    preview.onPageStatus = (
      cb: (s: {
        url: string | null;
        title: string | null;
        favicon: string | null;
        phase: "loading" | "loaded" | "error" | "discarded";
        error?: { kind: string; status?: number; code?: string; message: string };
      }) => void,
    ) => {
      cb({
        url: o.url,
        title: null,
        favicon: null,
        phase: "error",
        error: {
          kind: "network",
          code: "ERR_NAME_NOT_RESOLVED",
          message: "Can't reach this site",
        },
      });
      return () => undefined;
    };
    preview.getNavigationState = () =>
      Promise.resolve({ canGoBack: o.canGoBack, canGoForward: false });
    preview.reload = () => {
      w.__mcodePreview.reload += 1;
      return Promise.resolve();
    };
    preview.openExternal = () => {
      w.__mcodePreview.openExternal += 1;
      return Promise.resolve();
    };
  }, opts);
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

async function seedUnsavedAnnotationDraft(page: Page): Promise<void> {
  await page.evaluate((threadId) => {
    type StoreHandle = {
      getState: () => Record<string, unknown>;
      setState: (patch: Record<string, unknown>) => void;
    };
    const stores =
      (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const annotationStore = stores.find((store) => {
      const state = store.getState();
      return "byThread" in state && "drafts" in state && "buildBundle" in state;
    });
    const designStore = stores.find((store) => {
      const state = store.getState();
      return "modes" in state && "toggle" in state && "isActive" in state;
    });
    if (!annotationStore) throw new Error("[E2E] annotation store not found");
    if (!designStore) throw new Error("[E2E] design mode store not found");
    annotationStore.setState({
      drafts: {
        [threadId]: {
          threadId,
          pageIdentity: "https://example.com/",
          bounds: { x: 20, y: 24, width: 220, height: 48 },
          selectorHint: "input[name='q']",
          label: "Search input",
          pageContext: {
            schemaVersion: 2,
            pageUrl: "https://example.com/",
            pageTitle: "Example",
            capturedAt: "2026-07-01T00:00:00.000Z",
            captureKind: "element",
            bounds: { x: 20, y: 24, width: 220, height: 48 },
            layoutViewport: { width: 800, height: 600 },
          },
          note: "",
        },
      },
    });
    designStore.setState({ modes: { [threadId]: true } });
  }, THREAD.id);
}

async function hasUnsavedAnnotationDraft(page: Page): Promise<boolean> {
  return page.evaluate((threadId) => {
    type StoreHandle = {
      getState: () => Record<string, unknown>;
    };
    const stores =
      (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const annotationStore = stores.find((store) => {
      const state = store.getState();
      return "byThread" in state && "drafts" in state && "buildBundle" in state;
    });
    const drafts = annotationStore?.getState().drafts as
      | Record<string, unknown>
      | undefined;
    return Boolean(drafts?.[threadId]);
  }, THREAD.id);
}

async function seedSavedAnnotation(page: Page): Promise<void> {
  await page.evaluate((threadId) => {
    type StoreHandle = {
      getState: () => Record<string, unknown>;
      setState: (patch: Record<string, unknown>) => void;
    };
    const stores =
      (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const annotationStore = stores.find((store) => {
      const state = store.getState();
      return "byThread" in state && "drafts" in state && "buildBundle" in state;
    });
    const designStore = stores.find((store) => {
      const state = store.getState();
      return "modes" in state && "toggle" in state && "isActive" in state;
    });
    if (!annotationStore) throw new Error("[E2E] annotation store not found");
    if (!designStore) throw new Error("[E2E] design mode store not found");
    annotationStore.setState({
      byThread: {
        [threadId]: [
          {
            id: "annotation-1",
            createdAt: Date.now(),
            displayNumber: 1,
            pageIdentity: "https://example.com/",
            pageContext: {
              schemaVersion: 2,
              pageUrl: "https://example.com/",
              pageTitle: "Example",
              capturedAt: "2026-07-01T00:00:00.000Z",
              captureKind: "element",
              bounds: { x: 20, y: 24, width: 220, height: 48 },
              layoutViewport: { width: 800, height: 600 },
            },
            targetContext: {
              label: "Search input",
              selectorHint: "input[name='q']",
              bounds: { x: 20, y: 24, width: 220, height: 48 },
            },
            note: "Move this field",
            snapshot: {
              id: "snapshot-1",
              name: "Preview annotation 1",
              mimeType: "image/png",
              sizeBytes: 12,
              sourcePath: "preview/snapshot-1.png",
              capture: {
                schemaVersion: 2,
                pageUrl: "https://example.com/",
                pageTitle: "Example",
                capturedAt: "2026-07-01T00:00:00.000Z",
                captureKind: "element",
                bounds: { x: 20, y: 24, width: 220, height: 48 },
                layoutViewport: { width: 800, height: 600 },
              },
            },
          },
        ],
      },
    });
    designStore.setState({ modes: { [threadId]: true } });
  }, THREAD.id);
}

async function savedAnnotationCount(page: Page): Promise<number> {
  return page.evaluate((threadId) => {
    type StoreHandle = {
      getState: () => Record<string, unknown>;
    };
    const stores =
      (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const annotationStore = stores.find((store) => {
      const state = store.getState();
      return "byThread" in state && "drafts" in state && "buildBundle" in state;
    });
    const byThread = annotationStore?.getState().byThread as
      | Record<string, unknown[]>
      | undefined;
    return byThread?.[threadId]?.length ?? 0;
  }, THREAD.id);
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

test.describe("PreviewPanel — loaded header", () => {
  test.beforeEach(async ({ page }) => {
    await interceptZustandStores(page);
    await injectPreviewBridge(page, { loaded: true });
    await openAppAtThread(page);
    await openPreviewTab(page);
    // Opening via mod+shift+b drops focus into the URL field (the focused
    // state) via a deferred rAF. Blur, let any queued re-focus rAF fire, then
    // assert the bar has settled into the loaded-title state (input shows the
    // page title). The rAF focus fires once, so a retried blur eventually wins.
    const url = page.getByLabel("Preview URL");
    await expect(async () => {
      await url.blur();
      await page.waitForTimeout(60);
      await expect(url).toHaveValue("Example");
    }).toPass({ timeout: 8000, intervals: [150, 300, 500] });
  });

  test("header renders nav, reload, design, screenshot, and the overflow kebab", async ({ page }) => {
    await expect(page.getByTestId("browser-header")).toBeVisible();
    await expect(page.getByLabel("Back")).toBeVisible();
    await expect(page.getByLabel("Forward")).toBeVisible();
    // Reload sits in the nav cluster (outside the URL pill) once a page loads.
    await expect(page.getByLabel("Reload")).toBeVisible();
    await expect(page.getByLabel("Design")).toBeVisible();
    await expect(page.getByLabel("Screenshot")).toBeVisible();
    await expect(page.getByLabel("More browser tools")).toBeVisible();
  });

  test("rail and header stay borderless at the rounded panel corner", async ({ page }) => {
    const rail = page.getByTestId("activity-rail");
    const header = page.getByTestId("browser-header");
    await expect(rail).not.toHaveClass(/border-r/);
    await expect(header).not.toHaveClass(/border-b/);

    const [railBackground, headerBackground] = await Promise.all([
      rail.evaluate((el) => getComputedStyle(el).backgroundColor),
      header.evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    expect(railBackground).toBe(headerBackground);
  });

  test("chat and right panel meet at the draggable split line", async ({ page }) => {
    const main = page.locator("main").first();
    const panel = page.getByTestId("right-panel");
    const separator = page.getByRole("separator", { name: "Resize panel" });

    const [mainBox, panelBox] = await Promise.all([
      main.boundingBox(),
      panel.boundingBox(),
    ]);
    expect(mainBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(Math.abs(mainBox!.x + mainBox!.width - panelBox!.x)).toBeLessThanOrEqual(1);

    await expect(separator).toBeVisible();
    const lineBackground = await separator.locator("span").evaluate((el) =>
      getComputedStyle(el).backgroundColor,
    );
    expect(lineBackground).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("loaded bar shows the page title centered in the URL field", async ({ page }) => {
    await expect(page.getByLabel("Preview URL")).toHaveValue("Example");
  });

  test("legacy capture buttons are gone from the header", async ({ page }) => {
    await expect(page.getByLabel("Crop region")).toHaveCount(0);
    await expect(page.getByLabel("Pick element")).toHaveCount(0);
    await expect(page.getByLabel("Capture viewport")).toHaveCount(0);
    await expect(page.getByLabel("Toggle capture tools")).toHaveCount(0);
  });

  test("hovering the loaded bar reveals open-in-external", async ({ page }) => {
    // Reload lives in the nav cluster and is always present once loaded; only
    // the external-open arrow stays hidden inside the pill until hover.
    await expect(page.getByLabel("Reload")).toBeVisible();
    await expect(page.getByLabel("Open in system browser")).toHaveCount(0);
    await page.getByTestId("browser-url-bar").hover();
    await expect(page.getByLabel("Open in system browser")).toBeVisible();
  });

  test("the overflow kebab lists the relocated tools in order with Soon stubs", async ({ page }) => {
    await page.getByLabel("More browser tools").click();
    const menu = page.getByTestId("browser-overflow-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveClass(/pointer-events-auto/);
    await expect(menu.locator("..")).toHaveClass(/pointer-events-none/);
    await expect(page.locator("[data-base-ui-inert][role='presentation']")).toHaveCount(0);
    await expect(menu.getByText("New page")).toBeVisible();
    await expect(menu.getByText("Force reload")).toBeVisible();
    await expect(menu.getByText("Dump page content")).toBeVisible();
    await expect(menu.getByText("Region capture")).toBeVisible();
    await expect(menu.getByText("Developer tools")).toBeVisible();
    await expect(menu.getByText("Show device toolbar")).toBeVisible();
    await expect(menu.getByText("Zoom")).toBeVisible();
    await expect(menu.getByText("Clear cookies")).toBeVisible();
    await expect(menu.getByText("Clear cache")).toBeVisible();
    // The two future tools are present but disabled.
    await expect(menu.getByText("Developer tools").locator("..")).toHaveAttribute(
      "data-disabled",
      "",
    );
    await expect(menu.getByText("Show device toolbar").locator("..")).toHaveAttribute(
      "data-disabled",
      "",
    );

    // Zoom stepper adjusts the percent readout.
    await expect(menu.getByText("100%")).toBeVisible();
    await menu.getByLabel("Zoom in").click();
    await expect(menu.getByText("110%")).toBeVisible();
    await menu.getByLabel("Reset zoom").click();
    await expect(menu.getByText("100%")).toBeVisible();
  });

  test("design mode keeps browser chrome before the first annotation", async ({ page }) => {
    const designBtn = page.getByRole("button", { name: "Design", exact: true });
    await expect(designBtn).toHaveAttribute("aria-pressed", "false");
    await designBtn.click();
    await expect(page.getByTestId("browser-header")).toBeVisible();
    await expect(page.getByTestId("preview-annotation-header")).toHaveCount(0);
    await expect(page.getByTestId("preview-annotation-send-state")).toHaveCount(0);
    await expect(designBtn).toHaveAttribute("aria-pressed", "true");
    await expect(designBtn).toContainText("Design");
    await designBtn.click();
    await expect(page.getByRole("button", { name: "Design", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("exiting design mode removes an unsaved annotation draft", async ({ page }) => {
    await seedUnsavedAnnotationDraft(page);

    const designBtn = page.getByRole("button", { name: "Design", exact: true });
    await expect(designBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("preview-annotation-bubble")).toBeVisible();
    await expect.poll(() => hasUnsavedAnnotationDraft(page)).toBe(true);

    await designBtn.click();

    await expect(designBtn).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("preview-annotation-bubble")).toHaveCount(0);
    await expect.poll(() => hasUnsavedAnnotationDraft(page)).toBe(false);
  });

  test("discarding page annotations asks for confirmation", async ({ page }) => {
    await seedSavedAnnotation(page);

    await expect(page.getByTestId("preview-annotation-header")).toBeVisible();
    await expect(page.getByTestId("preview-annotation-marker")).toHaveCount(1);
    await expect.poll(() => savedAnnotationCount(page)).toBe(1);

    await page.getByLabel("Discard page annotations").click();

    const cancelDialog = page.getByRole("dialog", {
      name: "Delete page annotations?",
    });
    await expect(cancelDialog).toBeVisible();
    await expect(
      cancelDialog.getByText("This removes 1 saved annotation from this page."),
    ).toBeVisible();

    await cancelDialog.getByRole("button", { name: "Cancel" }).click();

    await expect(
      page.getByRole("dialog", { name: "Delete page annotations?" }),
    ).toHaveCount(0);
    await expect.poll(() => savedAnnotationCount(page)).toBe(1);
    await expect(page.getByTestId("preview-annotation-marker")).toHaveCount(1);

    await page.getByLabel("Discard page annotations").click();
    const deleteDialog = page.getByRole("dialog", {
      name: "Delete page annotations?",
    });
    await deleteDialog.getByRole("button", { name: "Delete" }).click();

    await expect.poll(() => savedAnnotationCount(page)).toBe(0);
    await expect(page.getByTestId("preview-annotation-marker")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — empty browser (localhost ports)
// ---------------------------------------------------------------------------

test.describe("PreviewPanel — empty localhost ports", () => {
  const PORTS = [
    { name: "Mcode", port: 5173, online: true },
    { name: "API", port: 19400, online: false },
  ];

  test("lists detected ports with names and online state", async ({ page }) => {
    await injectPreviewBridge(page, { loaded: false, ports: PORTS });
    await openAppAtThread(page);
    await openPreviewTab(page);

    const list = page.getByTestId("browser-local-ports");
    await expect(list).toBeVisible();
    const cards = page.getByTestId("browser-local-port");
    await expect(cards).toHaveCount(2);
    await expect(list.getByText("Mcode")).toBeVisible();
    await expect(list.getByText("localhost:5173")).toBeVisible();
    await expect(list.getByText("API")).toBeVisible();

    const dots = page.getByTestId("browser-local-port-status");
    await expect(dots.nth(0)).toHaveAttribute("data-online", "true");
    await expect(dots.nth(1)).toHaveAttribute("data-online", "false");
  });

  test("the sort/filter control is a disabled stub", async ({ page }) => {
    await injectPreviewBridge(page, { loaded: false, ports: PORTS });
    await openAppAtThread(page);
    await openPreviewTab(page);
    await expect(page.getByLabel("Sort and filter (coming soon)")).toBeDisabled();
  });

  test("clicking a port card navigates the preview to that localhost URL", async ({ page }) => {
    await injectPreviewBridge(page, { loaded: false, ports: PORTS });
    await openAppAtThread(page);
    await openPreviewTab(page);

    await page.getByTestId("browser-local-port").first().click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __mcodeNav: string[] }).__mcodeNav,
        ),
      )
      .toContain("http://localhost:5173");
  });
});

// ---------------------------------------------------------------------------
// Tests — preview error states (W1)
// ---------------------------------------------------------------------------

test.describe("PreviewPanel — error states", () => {
  test("surfaces a failed load with copy and the distilled recovery actions", async ({ page }) => {
    await injectPreviewBridge(page);
    await injectErrorBridge(page, { url: "https://nope.test", canGoBack: true });
    await openAppAtThread(page);
    await openPreviewTab(page);

    const panel = page.getByTestId("preview-error-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("preview-error-headline")).toHaveText(
      "Can't reach this site",
    );
    // Distilled to the essentials: Retry (primary) + Go back (history exists).
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Go back" })).toBeVisible();
    // Redundant-with-chrome actions were removed: the omnibox is the URL editor
    // and the toolbar owns Open-in-system-browser.
    await expect(panel.getByRole("button", { name: "Edit URL" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Open in browser" })).toHaveCount(0);
    // Diagnostic code is shown for the developer audience.
    await expect(panel.getByText(/ERR_NAME_NOT_RESOLVED/)).toBeVisible();
  });

  test("Retry reloads the failed page", async ({ page }) => {
    await injectPreviewBridge(page);
    await injectErrorBridge(page, { url: "https://nope.test", canGoBack: true });
    await openAppAtThread(page);
    await openPreviewTab(page);

    await page.getByTestId("preview-error-retry").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __mcodePreview: { reload: number } }).__mcodePreview.reload))
      .toBeGreaterThan(0);
  });

  test("Go back is hidden when the guest has no history", async ({ page }) => {
    await injectPreviewBridge(page);
    await injectErrorBridge(page, { url: "https://nope.test", canGoBack: false });
    await openAppAtThread(page);
    await openPreviewTab(page);

    const panel = page.getByTestId("preview-error-panel");
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Go back" })).toHaveCount(0);
  });

  test("renders the panel for a file failure with Retry only (no history)", async ({ page }) => {
    await injectPreviewBridge(page);
    await injectErrorBridge(page, { url: "file:///gone.html", canGoBack: false });
    await openAppAtThread(page);
    await openPreviewTab(page);

    const panel = page.getByTestId("preview-error-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Go back" })).toHaveCount(0);
  });
});
