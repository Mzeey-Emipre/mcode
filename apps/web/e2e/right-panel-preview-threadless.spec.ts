import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-preview-threadless",
  name: "Threadless Preview WS",
  path: "/tmp/preview-threadless",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

/**
 * Inject a no-op `window.desktopBridge.preview` before the page loads so the
 * PreviewPanel renders its chrome instead of the desktop-only empty state.
 * Mirrors the bridge stub in preview-chrome.spec.ts, trimmed to the methods the
 * panel touches on first paint.
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
      capturePictureReferenceElementPick: captureFail,
      capturePageContext: () =>
        Promise.resolve({ ok: false, error: "no-preview" } as const),
      releaseBrowserCaptureSpills: noop,
      onPageStatus: (
        cb: (s: {
          url: string | null;
          title: string | null;
          favicon: string | null;
          phase: "loading" | "loaded" | "error" | "discarded";
        }) => void,
      ) => {
        cb({ url: null, title: null, favicon: null, phase: "loaded" });
        return () => undefined;
      },
      cancelCapture: noop,
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
 * Enters the new-thread composer view (a workspace is active but no thread is)
 * and opens the right panel threadless on the Preview tab. This is the state the
 * user sees before sending the first message, where the Browser tab must still
 * render against the workspace's local checkout.
 */
async function openThreadlessPreview(page: Page): Promise<void> {
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
              setRightPanelTab: (id: string, threadId: string | null, t: string) => void;
            };
          }
        ).getState();
        // No thread id → threadless workspace visibility.
        api.showRightPanel(wid);
        api.setRightPanelTab(wid, null, "preview");
      }
    },
    { workspace: WORKSPACE, wid: WORKSPACE.id },
  );
}

test.describe("Right panel threadless preview", () => {
  test.beforeEach(async ({ page }) => {
    await injectPreviewBridge(page);
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [],
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

  test("the Preview tab renders chrome with no active thread", async ({ page }) => {
    await openThreadlessPreview(page);

    // The Browser tab must paint against the workspace scope, not stay blank
    // because no thread is active. The chrome path (not the desktop-only empty
    // state) proves the panel mounted threadless.
    await expect(page.getByTestId("preview-panel")).toBeVisible({ timeout: 5_000 });
    // The URL field is always part of the chrome (the Reload button is only
    // present once a page has loaded), so it is the reliable chrome signal.
    await expect(page.getByRole("textbox", { name: "Preview URL" })).toBeVisible();
  });
});
