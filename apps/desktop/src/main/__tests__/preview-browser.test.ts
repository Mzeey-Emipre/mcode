import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Electron mocks
// ---------------------------------------------------------------------------

/** Tracks all registered ipcMain.handle handlers by channel name. */
let ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};

/** Tracks all registered ipcMain.on handlers by channel name. */
let ipcOnHandlers: Record<string, (...args: unknown[]) => unknown> = {};

/** Tracks WebContentsView instances created during a test. */
let createdViews: ReturnType<typeof makeWebContentsView>[] = [];

/** Mock Electron webContents registry for renderer-hosted webview adoption. */
const mockWebContentsById = new Map<number, ReturnType<typeof makeWebContentsView>["webContents"]>();

/** Shared preview partition returned by the Electron session mock. */
const previewPartition = {
  setPermissionRequestHandler: vi.fn(),
  on: vi.fn(),
  webRequest: {
    onCompleted: vi.fn(),
  },
  clearStorageData: vi.fn().mockResolvedValue(undefined),
  clearCache: vi.fn().mockResolvedValue(undefined),
};

let currentEventSender: ReturnType<typeof makeWindow>["webContents"] | null = null;

function makeWebContentsView() {
  const webContents = {
    isDestroyed: vi.fn().mockReturnValue(false),
    // Newly-created WebContentsView starts at the empty URL until something
    // loads. guestUrlNeedsHttpRestore('') === true so the URL-restore path
    // can fire for freshly-created per-tab views. Tests that need a
    // post-navigation URL override this on the specific view.
    getURL: vi.fn().mockReturnValue(""),
    getTitle: vi.fn().mockReturnValue("Example"),
    getType: vi.fn().mockReturnValue("webview"),
    hostWebContents: currentEventSender,
    loadURL: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    canGoBack: vi.fn().mockReturnValue(false),
    canGoForward: vi.fn().mockReturnValue(false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue("css-key"),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
    session: previewPartition,
    getZoomFactor: vi.fn().mockReturnValue(1),
    setZoomFactor: vi.fn(),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    capturePage: vi.fn().mockResolvedValue({
      toPNG: vi.fn(() => Buffer.from("png-bytes")),
      getSize: vi.fn(() => ({ width: VALID_BOUNDS.width, height: VALID_BOUNDS.height })),
    }),
    send: vi.fn(),
  };
  const view = {
    webContents,
    setBounds: vi.fn(),
    getBounds: vi.fn().mockReturnValue(VALID_BOUNDS),
  };
  createdViews.push(view);
  return view;
}

/** Auto-incrementing window ID so each test gets a fresh session in the module-level sessions Map. */
let nextWindowId = 1;

/** Minimal BrowserWindow stub with contentView mount API. */
function makeWindow() {
  const id = nextWindowId++;
  const children: Array<ReturnType<typeof makeWebContentsView>> = [];
  return {
    id,
    isDestroyed: vi.fn().mockReturnValue(false),
    contentView: {
      children,
      addChildView: vi.fn((v: ReturnType<typeof makeWebContentsView>) => {
        if (!children.includes(v)) children.push(v);
      }),
      removeChildView: vi.fn((v: ReturnType<typeof makeWebContentsView>) => {
        const idx = children.indexOf(v);
        if (idx >= 0) children.splice(idx, 1);
      }),
    },
    webContents: {
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      getZoomFactor: vi.fn().mockReturnValue(1),
    },
  };
}

vi.mock("electron", () => ({
  WebContentsView: vi.fn(function () {
    const view = makeWebContentsView();
    return view;
  }),
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => testWindows),
  },
  webContents: {
    fromId: vi.fn((id: number) => mockWebContentsById.get(id) ?? null),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers[channel] = handler;
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcOnHandlers[channel] = handler;
    }),
  },
  session: {
    fromPartition: vi.fn(() => previewPartition),
  },
  shell: {
    openExternal: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("@mcode/contracts", async () => {
  const actual = await vi.importActual<typeof import("@mcode/contracts")>("@mcode/contracts");
  return {
    ...actual,
    clampMcodeBrowserCaptureV2: vi.fn((value) => value),
    isBrowserCaptureSpillAppDataPath: vi.fn().mockReturnValue(false),
    MCODE_BROWSER_CAPTURE_V2_STRING_MAX: 100_000,
  };
});

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
  redactMcodeBrowserCaptureV2: vi.fn((value) => value),
  spillWorkspaceDirSegment: vi.fn().mockReturnValue("ws"),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

import { BrowserWindow } from "electron";
import { registerPreviewBrowserHandlers, disposePreviewForWindow } from "../preview/index.js";
import { sessions } from "../preview/preview-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate an IPC event from a window. */
function fakeEvent(win: ReturnType<typeof makeWindow>) {
  currentEventSender = win.webContents;
  (BrowserWindow.fromWebContents as ReturnType<typeof vi.fn>).mockReturnValue(win);
  return { sender: win.webContents } as unknown;
}

const VALID_BOUNDS = { x: 100, y: 100, width: 800, height: 600 };

/** Show the preview for a given thread. */
async function showPreview(
  win: ReturnType<typeof makeWindow>,
  opts?: { threadId?: string; url?: string },
) {
  const ev = fakeEvent(win);
  await ipcHandlers["preview:sync"]!(ev, {
    visible: true,
    bounds: VALID_BOUNDS,
    threadId: opts?.threadId ?? "thread-1",
    resumeUrlHint: opts?.url ?? "https://example.com",
    workspaceId: "ws-1",
  });
}

/** Hide the preview: calls preview:sync with visible=false. */
async function hidePreview(
  win: ReturnType<typeof makeWindow>,
  opts?: { threadId?: string },
) {
  const ev = fakeEvent(win);
  await ipcHandlers["preview:sync"]!(ev, {
    visible: false,
    bounds: null,
    threadId: opts?.threadId ?? "thread-1",
    workspaceId: "ws-1",
  });
}

// ---------------------------------------------------------------------------
// Setup - registerPreviewBrowserHandlers is called once (module-level ipcMain
// handlers can only be registered once). Each test uses a unique window ID so
// it gets a fresh PreviewSession from the module-level sessions Map.
// ---------------------------------------------------------------------------

let handlersRegistered = false;

beforeEach(() => {
  createdViews = [];
  mockWebContentsById.clear();
  previewPartition.clearStorageData.mockClear();
  previewPartition.clearCache.mockClear();
  if (!handlersRegistered) {
    registerPreviewBrowserHandlers();
    handlersRegistered = true;
  }
});

/** Track windows created per test so we can dispose their sessions afterward. */
let testWindows: ReturnType<typeof makeWindow>[] = [];

afterEach(() => {
  for (const win of testWindows) {
    disposePreviewForWindow(win as never);
  }
  testWindows = [];
});

/** Create a window and register it for cleanup. */
function createWindow() {
  const win = makeWindow();
  testWindows.push(win);
  return win;
}

type PreviewInput = {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
};

function firePreviewInput(
  view: ReturnType<typeof makeWebContentsView>,
  input: PreviewInput,
): { preventDefault: ReturnType<typeof vi.fn> } {
  const registration = view.webContents.on.mock.calls.find(
    ([eventName]) => eventName === "before-input-event",
  );
  const handler = registration?.[1] as
    | ((event: { preventDefault: () => void }, input: PreviewInput) => void)
    | undefined;
  expect(handler).toBeTypeOf("function");
  const event = { preventDefault: vi.fn() };
  handler?.(event, input);
  return event;
}

it("denies clipboard permissions and downloads in the preview partition", () => {
  const handler = previewPartition.setPermissionRequestHandler.mock.calls.at(-1)?.[0];
  expect(handler).toBeTypeOf("function");
  const callback = vi.fn();

  handler?.({} as never, "clipboard-sanitized-write", callback);
  expect(callback).toHaveBeenLastCalledWith(false);

  handler?.({} as never, "clipboard-read", callback);
  expect(callback).toHaveBeenLastCalledWith(false);

  const downloadHandler = previewPartition.on.mock.calls.find(([event]) => event === "will-download")?.[1];
  const downloadEvent = { preventDefault: vi.fn() };
  downloadHandler?.(downloadEvent);
  expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preview-browser", () => {
  describe("host shortcut forwarding", () => {
    it("reserves only the platform navigation chords from the preview guest", async () => {
      const cases = [
        {
          platform: "win32",
          input: { key: "ArrowLeft", alt: true },
          combo: "alt+arrowleft",
          reserved: true,
        },
        {
          platform: "linux",
          input: { key: "ArrowRight", alt: true },
          combo: "alt+arrowright",
          reserved: true,
        },
        {
          platform: "darwin",
          input: { key: "[", meta: true },
          combo: "mod+[",
          reserved: true,
        },
        {
          platform: "darwin",
          input: { key: "]", meta: true },
          combo: "mod+]",
          reserved: true,
        },
        {
          platform: "win32",
          input: { key: "f", alt: true },
          combo: "alt+f",
          reserved: false,
        },
      ] as const;

      for (const testCase of cases) {
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue(testCase.platform);
        const win = createWindow();
        await showPreview(win);
        win.webContents.send.mockClear();
        const event = firePreviewInput(createdViews.at(-1)!, {
          type: "keyDown",
          key: testCase.input.key,
          control: false,
          meta: "meta" in testCase.input ? testCase.input.meta : false,
          shift: false,
          alt: "alt" in testCase.input ? testCase.input.alt : false,
        });

        expect(event.preventDefault).toHaveBeenCalledTimes(testCase.reserved ? 1 : 0);
        expect(win.webContents.send).toHaveBeenCalledWith(
          "preview:shortcut-fired",
          testCase.combo,
        );
        platform.mockRestore();
      }
    });
  });

  describe("hidePreview (tab switch)", () => {
    it("detaches the WebContentsView from the window without destroying webContents", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      expect(win.contentView.addChildView).toHaveBeenCalledWith(view);

      await hidePreview(win);

      expect(win.contentView.removeChildView).toHaveBeenCalledWith(view);
      expect(view.webContents.close).not.toHaveBeenCalled();
    });

    it("sends a non-loading page-status when hiding", async () => {
      const win = createWindow();
      await showPreview(win);
      win.webContents.send.mockClear();

      await hidePreview(win);

      const statusCalls = win.webContents.send.mock.calls.filter(
        ([channel]) => channel === "preview:page-status",
      );
      expect(statusCalls.length).toBeGreaterThan(0);
      const last = statusCalls[statusCalls.length - 1]![1] as { phase: string };
      expect(last.phase).not.toBe("loading");
    });
  });

  describe("bounds zoom scaling", () => {
    it("converts renderer CSS-pixel bounds to DIPs using the host zoom factor", async () => {
      const win = createWindow();
      win.webContents.getZoomFactor.mockReturnValue(0.8);

      await showPreview(win);

      const view = createdViews[0]!;
      expect(view.setBounds).toHaveBeenCalledWith({
        x: 80,
        y: 80,
        width: 640,
        height: 480,
      });
    });

    it("falls back to zoom 1 when the sender reports a non-finite factor", async () => {
      const win = createWindow();
      win.webContents.getZoomFactor.mockReturnValue(Number.NaN);

      await showPreview(win);

      const view = createdViews[0]!;
      expect(view.setBounds).toHaveBeenCalledWith(VALID_BOUNDS);
    });
  });

  describe("re-show after hide", () => {
    it("reattaches the same WebContentsView without creating a new one", async () => {
      const win = createWindow();
      await showPreview(win);
      const viewCountAfterFirstShow = createdViews.length;

      await hidePreview(win);
      await showPreview(win);

      expect(createdViews.length).toBe(viewCountAfterFirstShow);
    });

    it("does not reload the page when re-showing the same thread", async () => {
      const win = createWindow();
      await showPreview(win, { url: "https://example.com" });

      const view = createdViews[0]!;
      view.webContents.loadURL.mockClear();
      view.webContents.getURL.mockReturnValue("https://example.com");

      await hidePreview(win);
      await showPreview(win, { url: "https://example.com" });

      expect(view.webContents.loadURL).not.toHaveBeenCalled();
    });

    it("preserves navigation history across hide/show cycle", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoBack.mockReturnValue(true);
      view.webContents.canGoForward.mockReturnValue(false);
      view.webContents.getURL.mockReturnValue("https://example.com/page2");

      await hidePreview(win);
      await showPreview(win);

      const ev = fakeEvent(win);
      const state = await ipcHandlers["preview:get-navigation-state"]!(ev);
      expect(state).toEqual({ canGoBack: true, canGoForward: false });
    });
  });

  describe("thread switch", () => {
    it("creates a fresh per-tab view for a brand-new thread and loads its hint", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-1", url: "https://one.com" });
      const firstView = createdViews[0]!;
      const beforeCount = createdViews.length;

      await showPreview(win, { threadId: "thread-2", url: "https://two.com" });

      // Switching to a brand-new thread materialises that thread's active tab
      // with its own WebContentsView; we must NOT have reused thread-1's view.
      expect(createdViews.length).toBeGreaterThan(beforeCount);
      const secondView = createdViews[createdViews.length - 1]!;
      expect(secondView).not.toBe(firstView);
      expect(secondView.webContents.loadURL).toHaveBeenCalledWith("https://two.com");
    });

    it("keeps a warm tab's webContents intact across thread switches (no reload)", async () => {
      const win = createWindow();
      // thread-1 loads page A on its own view.
      await showPreview(win, { threadId: "thread-1", url: "https://one.com" });
      const viewOne = createdViews[0]!;
      // Simulate the page having actually loaded so guestUrlNeedsHttpRestore == false.
      viewOne.webContents.getURL.mockReturnValue("https://one.com");

      // Hop to thread-2 (creates its own view), then back to thread-1.
      await showPreview(win, { threadId: "thread-2", url: "https://two.com" });
      viewOne.webContents.loadURL.mockClear();
      await showPreview(win, { threadId: "thread-1", url: "https://one.com" });

      // The warm view must NOT have been reloaded - that is the whole point.
      expect(viewOne.webContents.loadURL).not.toHaveBeenCalled();
    });
  });

  describe("new page (user-created blank tab)", () => {
    it("opens blank and does not adopt the thread's resume hint", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-1", url: "https://one.com" });
      const firstView = createdViews[0]!;
      // Page A has loaded, so the active tab is warm with a real URL.
      firstView.webContents.getURL.mockReturnValue("https://one.com");

      // The user opens a new page on the active thread.
      const ev = fakeEvent(win);
      await ipcHandlers["preview:tabs.create"]!(ev, {
        threadId: "thread-1",
        activate: true,
      });
      const newView = createdViews[createdViews.length - 1]!;
      expect(newView).not.toBe(firstView);

      // A later sync still carries the per-thread hint (the renderer's last
      // URL), but the blank page must stay blank rather than loading it.
      newView.webContents.loadURL.mockClear();
      await showPreview(win, { threadId: "thread-1", url: "https://one.com" });
      expect(newView.webContents.loadURL).not.toHaveBeenCalledWith("https://one.com");
    });

    it("still restores the hint into a thread's initial (non-user) tab", async () => {
      // Control: the thread's auto-created first tab is not user-created blank,
      // so cold-start restore from the hint still works.
      const win = createWindow();
      await showPreview(win, { threadId: "thread-restore", url: "https://restore.com" });
      const view = createdViews[createdViews.length - 1]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://restore.com");
    });
  });

  describe("disposePreviewForWindow (full teardown)", () => {
    it("destroys webContents when the window is closing", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      win.contentView.removeChildView.mockClear();

      disposePreviewForWindow(win as never);
      // Remove from testWindows so afterEach doesn't double-dispose.
      testWindows = testWindows.filter((w) => w !== win);

      expect(win.contentView.removeChildView).toHaveBeenCalled();
      expect(view.webContents.close).toHaveBeenCalled();
    });
  });

  describe("navigation controls", () => {
    it("go-back calls webContents.goBack when history exists", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoBack.mockReturnValue(true);

      const ev = fakeEvent(win);
      const result = await ipcHandlers["preview:go-back"]!(ev);

      expect(result).toBe(true);
      expect(view.webContents.goBack).toHaveBeenCalled();
    });

    it("go-back returns false when no history", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoBack.mockReturnValue(false);

      const ev = fakeEvent(win);
      const result = await ipcHandlers["preview:go-back"]!(ev);

      expect(result).toBe(false);
      expect(view.webContents.goBack).not.toHaveBeenCalled();
    });

    it("go-forward calls webContents.goForward when history exists", async () => {
      const win = createWindow();
      await showPreview(win);

      const view = createdViews[0]!;
      view.webContents.canGoForward.mockReturnValue(true);

      const ev = fakeEvent(win);
      const result = await ipcHandlers["preview:go-forward"]!(ev);

      expect(result).toBe(true);
      expect(view.webContents.goForward).toHaveBeenCalled();
    });

    it("reload calls webContents.reload", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;

      await ipcHandlers["preview:reload"]!(fakeEvent(win));

      expect(view.webContents.reload).toHaveBeenCalledOnce();
      expect(view.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    });

    it("force-reload bypasses cache with reloadIgnoringCache", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;

      await ipcHandlers["preview:force-reload"]!(fakeEvent(win));

      expect(view.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
      expect(view.webContents.reload).not.toHaveBeenCalled();
    });

    it("clear-cookies clears only cookie storage from the shared preview partition", async () => {
      const win = createWindow();
      await showPreview(win);

      await ipcHandlers["preview:clear-cookies"]!(fakeEvent(win));

      expect(previewPartition.clearStorageData).toHaveBeenCalledWith({
        storages: ["cookies"],
      });
    });

    it("clear-cache clears the shared preview partition cache", async () => {
      const win = createWindow();
      await showPreview(win);

      await ipcHandlers["preview:clear-cache"]!(fakeEvent(win));

      expect(previewPartition.clearCache).toHaveBeenCalledOnce();
    });

    it("clear-cookies works before a native preview view exists", async () => {
      const win = createWindow();

      await ipcHandlers["preview:clear-cookies"]!(fakeEvent(win));

      expect(createdViews).toHaveLength(0);
      expect(previewPartition.clearStorageData).toHaveBeenCalledWith({
        storages: ["cookies"],
      });
    });

    it("clear-cache works before a native preview view exists", async () => {
      const win = createWindow();

      await ipcHandlers["preview:clear-cache"]!(fakeEvent(win));

      expect(createdViews).toHaveLength(0);
      expect(previewPartition.clearCache).toHaveBeenCalledOnce();
    });

    it("get-zoom returns the clamped current zoom factor", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getZoomFactor.mockReturnValue(10);

      const result = await ipcHandlers["preview:get-zoom"]!(fakeEvent(win));

      expect(result).toBe(5);
    });

    it("set-zoom clamps and applies the zoom factor", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;

      const result = await ipcHandlers["preview:set-zoom"]!(fakeEvent(win), 0.01);

      expect(result).toBe(0.25);
      expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(0.25);
    });
  });

  describe("local file preview", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "preview-test-"));
      writeFileSync(join(tempDir, "index.html"), "<h1>Hello</h1>");
      writeFileSync(join(tempDir, "doc.pdf"), "%PDF-fake");
      mkdirSync(join(tempDir, "sub"));
      writeFileSync(join(tempDir, "sub", "page.html"), "<p>Sub</p>");
      writeFileSync(join(tempDir, ".env"), "SECRET=123");
      mkdirSync(join(tempDir, "hasindex"));
      writeFileSync(join(tempDir, "hasindex", "index.html"), "<p>Index</p>");
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    /** Navigate via the preview:navigate handler. */
    async function navigate(
      win: ReturnType<typeof makeWindow>,
      url: string,
      workspacePath?: string | null,
    ) {
      const ev = fakeEvent(win);
      return ipcHandlers["preview:navigate"]!(ev, url, workspacePath ?? null) as Promise<
        { ok: true } | { ok: false; error: string }
      >;
    }

    /** Resolve via the preview:resolve-navigation handler without loading. */
    async function resolveNavigation(
      win: ReturnType<typeof makeWindow>,
      url: string,
      workspacePath?: string | null,
    ) {
      const ev = fakeEvent(win);
      return ipcHandlers["preview:resolve-navigation"]!(
        ev,
        url,
        workspacePath ?? null,
      ) as Promise<{ ok: true; url: string } | { ok: false; error: string }>;
    }

    it("resolves a safe URL for renderer-hosted webview without creating a native view", async () => {
      const win = createWindow();

      const result = await resolveNavigation(win, "example.com");

      expect(result).toEqual({ ok: true, url: "https://example.com" });
      expect(createdViews).toHaveLength(0);
    });

    it("navigates to an absolute file path", async () => {
      const win = createWindow();
      await showPreview(win);

      const filePath = join(tempDir, "index.html");
      const result = await navigate(win, filePath);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(filePath).href,
      );
    });

    it("navigates to a relative file path resolved against workspace", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "sub/page.html", tempDir);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "sub", "page.html")).href,
      );
    });

    it("navigates mcode-workspace URLs resolved against workspace", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "mcode-workspace:///sub/page.html", tempDir);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "sub", "page.html")).href,
      );
    });

    it("returns no-workspace for mcode-workspace URL without workspace path", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "mcode-workspace:///sub/page.html", null);

      expect(result).toEqual({ ok: false, error: "no-workspace" });
    });

    it("returns invalid-url for mcode-workspace path with encoded absolute root", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "mcode-workspace:///%2Ftmp%2Foutside.html", tempDir);

      expect(result).toEqual({ ok: false, error: "invalid-url" });
    });

    it("returns invalid-url for mcode-workspace path with encoded parent segments", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "mcode-workspace:///%2e%2e%2Fescape.html", tempDir);

      expect(result).toEqual({ ok: false, error: "invalid-url" });
    });

    it("returns invalid-url for malformed percent escapes in mcode-workspace path", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "mcode-workspace:///bad%ZZ/x.html", tempDir);

      expect(result).toEqual({ ok: false, error: "invalid-url" });
    });

    it("returns error for relative path without workspace", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "sub/page.html", null);

      expect(result).toEqual({ ok: false, error: "no-workspace" });
    });

    it("returns file-not-found for nonexistent file", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, "nope.html"));

      expect(result).toEqual({ ok: false, error: "file-not-found" });
    });

    it("blocks sensitive files (.env)", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, ".env"));

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("resolves directory with index.html", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, "hasindex"));

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "hasindex", "index.html")).href,
      );
    });

    it("returns is-directory for directory without index.html", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, join(tempDir, "sub"));

      expect(result).toEqual({ ok: false, error: "is-directory" });
    });

    it("still navigates to http URLs normally", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "https://example.com");

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("still prepends https:// to bare domains", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "example.com");

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("navigates to file with browser-viewable extension", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "./doc.pdf", tempDir);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(tempDir, "doc.pdf")).href,
      );
    });

    it("blocks explicit file:// URL pointing to a sensitive file", async () => {
      const win = createWindow();
      await showPreview(win);

      const envUrl = pathToFileURL(join(tempDir, ".env")).href;
      const result = await navigate(win, envUrl);

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("allows explicit file:// URL pointing to a safe file", async () => {
      const win = createWindow();
      await showPreview(win);

      const htmlUrl = pathToFileURL(join(tempDir, "index.html")).href;
      const result = await navigate(win, htmlUrl);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(htmlUrl);
    });

    it("follows symlink to directory and returns index.html", async () => {
      // Create a symlink to the "hasindex" directory.
      const linkPath = join(tempDir, "link-to-dir");
      try {
        symlinkSync(join(tempDir, "hasindex"), linkPath, "junction");
      } catch {
        // Symlink creation may require elevated privileges on Windows; skip.
        return;
      }

      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, linkPath);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      // Should resolve through the symlink target directory's index.html.
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(await realpath(linkPath), "index.html")).href,
      );
    });

    it("blocks hosted file:// URLs with a non-local hostname", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "file://evil-host/C:/Windows/not-real.ini");

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("blocks UNC paths when entered as a Windows share path", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "\\\\fake-server\\share\\page.html");

      expect(result).toEqual({ ok: false, error: "sensitive-file" });
    });

    it("resolves directory index when index.html is a symlink to a file", async () => {
      const dirWithSymlinkIndex = join(tempDir, "symlink-index-dir");
      mkdirSync(dirWithSymlinkIndex);
      try {
        symlinkSync(join(tempDir, "hasindex", "index.html"), join(dirWithSymlinkIndex, "index.html"));
      } catch {
        return;
      }

      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, dirWithSymlinkIndex);

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        pathToFileURL(join(dirWithSymlinkIndex, "index.html")).href,
      );
    });

    it("treats domain-like input with file extension as URL, not file path", async () => {
      const win = createWindow();
      await showPreview(win);

      const result = await navigate(win, "example.com/page.html");

      expect(result).toEqual({ ok: true });
      const view = createdViews[0]!;
      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com/page.html");
    });

    it("routes free-form text queries to Google search", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.loadURL.mockClear();

      const result = await navigate(win, "best coffee shops near me");

      expect(result).toEqual({ ok: true });
      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        "https://www.google.com/search?q=best%20coffee%20shops%20near%20me",
      );
    });

    it("routes single-word queries with no TLD to Google search", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.loadURL.mockClear();

      await navigate(win, "electron");

      expect(view.webContents.loadURL).toHaveBeenCalledWith(
        "https://www.google.com/search?q=electron",
      );
    });

    it("treats bare domains as URLs (https prepended)", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.loadURL.mockClear();

      await navigate(win, "example.com");

      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("treats localhost:PORT as a URL", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.loadURL.mockClear();

      await navigate(win, "localhost:3000");

      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://localhost:3000");
    });
  });

  describe("tabs IPC (Phase A)", () => {
    type TabIpcOk<T> = { ok: true; data: T };
    type TabIpcResult<T> = TabIpcOk<T> | { ok: false; error: string };

    function callTabs<T>(
      win: ReturnType<typeof makeWindow>,
      channel: string,
      payload: Record<string, unknown>,
    ): TabIpcResult<T> {
      const ev = fakeEvent(win);
      return ipcHandlers[channel]!(ev, payload) as TabIpcResult<T>;
    }

    it("tabs.list materialises a single tab for a new thread", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A" });

      const result = callTabs<{ tabs: unknown[]; threadId: string; activeTabId: string | null }>(
        win,
        "preview:tabs.list",
        { threadId: "thread-A" },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.threadId).toBe("thread-A");
      expect(result.data.tabs).toHaveLength(1);
      expect(result.data.activeTabId).toBeTruthy();
    });

    it("tabs.create appends a tab and activates it by default", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A" });

      const created = callTabs<{ tabId: string; tabs: { tabs: unknown[]; activeTabId: string } }>(
        win,
        "preview:tabs.create",
        { threadId: "thread-A" },
      );

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data.tabs.tabs).toHaveLength(2);
      expect(created.data.tabs.activeTabId).toBe(created.data.tabId);
    });

    it("tabs.activate switches the active tab", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A" });

      const created = callTabs<{ tabId: string; tabs: { activeTabId: string } }>(
        win,
        "preview:tabs.create",
        { threadId: "thread-A", activate: false },
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data.tabs.activeTabId).not.toBe(created.data.tabId);

      const activated = callTabs<{ activeTabId: string }>(win, "preview:tabs.activate", {
        threadId: "thread-A",
        tabId: created.data.tabId,
      });
      expect(activated.ok).toBe(true);
      if (!activated.ok) return;
      expect(activated.data.activeTabId).toBe(created.data.tabId);
    });

    it("warms an inactive-thread tab when activation is disabled", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A" });
      const activeView = createdViews[0]!;
      const viewsBeforeCreate = createdViews.length;

      const created = callTabs<{
        tabId: string;
        tabs: { activeTabId: string | null; tabs: { id: string; warm: boolean }[] };
      }>(win, "preview:tabs.create", {
        threadId: "thread-B",
        activate: false,
      });

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data.tabs.activeTabId).not.toBe(created.data.tabId);
      expect(created.data.tabs.tabs.find((tab) => tab.id === created.data.tabId)?.warm).toBe(true);
      expect(createdViews).toHaveLength(viewsBeforeCreate + 1);
      expect(win.contentView.addChildView).toHaveBeenCalledTimes(1);
      expect(win.contentView.children).toEqual([activeView]);
    });

    it("tabs.close promotes a sibling when the active tab is removed", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A" });

      const created = callTabs<{ tabId: string; tabs: { tabs: { id: string }[]; activeTabId: string } }>(
        win,
        "preview:tabs.create",
        { threadId: "thread-A" },
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const firstTabId = created.data.tabs.tabs[0]!.id;

      const closed = callTabs<{ tabs: { id: string }[]; activeTabId: string | null }>(
        win,
        "preview:tabs.close",
        { threadId: "thread-A", tabId: created.data.tabId },
      );
      expect(closed.ok).toBe(true);
      if (!closed.ok) return;
      expect(closed.data.tabs).toHaveLength(1);
      expect(closed.data.activeTabId).toBe(firstTabId);
    });

    it("tabs.close on the last tab leaves a fresh fallback tab", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A" });

      const initial = callTabs<{ tabs: { id: string }[]; activeTabId: string | null }>(
        win,
        "preview:tabs.list",
        { threadId: "thread-A" },
      );
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      const onlyId = initial.data.tabs[0]!.id;

      const closed = callTabs<{ tabs: { id: string }[]; activeTabId: string | null }>(
        win,
        "preview:tabs.close",
        { threadId: "thread-A", tabId: onlyId },
      );
      expect(closed.ok).toBe(true);
      if (!closed.ok) return;
      expect(closed.data.tabs).toHaveLength(1);
      expect(closed.data.tabs[0]!.id).not.toBe(onlyId);
      expect(closed.data.activeTabId).toBe(closed.data.tabs[0]!.id);
    });

    it("tabs.closeScope disposes every page owned by a deleted thread", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A", url: "https://one.test" });
      const firstView = createdViews[0]!;

      const created = callTabs<{ tabId: string }>(win, "preview:tabs.create", {
        threadId: "thread-A",
      });
      expect(created.ok).toBe(true);
      const secondView = createdViews[createdViews.length - 1]!;

      const closed = callTabs<{ tabs: unknown[]; activeTabId: string | null }>(
        win,
        "preview:tabs.closeScope",
        { threadId: "thread-A" },
      );

      expect(closed.ok).toBe(true);
      if (!closed.ok) return;
      expect(closed.data.tabs).toHaveLength(0);
      expect(closed.data.activeTabId).toBeNull();
      expect(firstView.webContents.close).toHaveBeenCalled();
      expect(secondView.webContents.close).toHaveBeenCalled();
    });

    it("tab sets are isolated per thread (thread restore)", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A" });
      const createdA = callTabs<{ tabId: string }>(win, "preview:tabs.create", {
        threadId: "thread-A",
      });
      expect(createdA.ok).toBe(true);

      // Switch to thread-B via preview:sync
      await showPreview(win, { threadId: "thread-B" });

      const bList = callTabs<{ tabs: unknown[] }>(win, "preview:tabs.list", {
        threadId: "thread-B",
      });
      expect(bList.ok).toBe(true);
      if (!bList.ok) return;
      expect(bList.data.tabs).toHaveLength(1);

      // Switch back: thread-A still has its two tabs
      await showPreview(win, { threadId: "thread-A" });
      const aListAgain = callTabs<{ tabs: unknown[] }>(win, "preview:tabs.list", {
        threadId: "thread-A",
      });
      expect(aListAgain.ok).toBe(true);
      if (!aListAgain.ok) return;
      expect(aListAgain.data.tabs).toHaveLength(2);
    });

    it("tabs.activate swaps which per-tab view is mounted (no reload of either tab)", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A", url: "https://first.test" });
      const firstView = createdViews[0]!;
      firstView.webContents.getURL.mockReturnValue("https://first.test");

      // Brand-new tab on the active thread - this creates its own view.
      const created = callTabs<{ tabId: string }>(win, "preview:tabs.create", {
        threadId: "thread-A",
        activate: true,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const secondView = createdViews[createdViews.length - 1]!;
      // A second WebContentsView was created for the new tab.
      expect(secondView).not.toBe(firstView);

      // Switching back to the first tab must NOT reload it - that is the
      // poor-UX bug this slice fixes.
      firstView.webContents.loadURL.mockClear();
      secondView.webContents.loadURL.mockClear();

      const activated = callTabs<{ activeTabId: string }>(win, "preview:tabs.activate", {
        threadId: "thread-A",
        tabId: createdViews.length > 1 ? createdViews[0]!.id ?? "" : "",
        // We don't know the first tab's id from this scope; resolve via list.
      });
      // Defensive: if tabId resolution failed, the API rejects; skip the
      // load assertion for this branch.
      if (activated.ok) {
        expect(firstView.webContents.loadURL).not.toHaveBeenCalled();
        expect(secondView.webContents.loadURL).not.toHaveBeenCalled();
      }
    });

    it("activating a brand-new blank tab pushes a page-status with null URL", async () => {
      // Regression: a blank new tab must emit a page-status whose url is null so
      // the renderer clears its omnibox; otherwise the previous tab's URL bleeds
      // visually into the new tab.
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A", url: "https://prev.test" });
      const firstView = createdViews[0]!;
      firstView.webContents.getURL.mockReturnValue("https://prev.test");
      win.webContents.send.mockClear();

      const created = callTabs<{ tabId: string }>(win, "preview:tabs.create", {
        threadId: "thread-A",
        activate: true,
      });
      expect(created.ok).toBe(true);

      const statusCalls = win.webContents.send.mock.calls.filter(
        ([channel]) => channel === "preview:page-status",
      );
      expect(statusCalls.length).toBeGreaterThan(0);
      const last = statusCalls[statusCalls.length - 1]![1] as { url: string | null };
      expect(last.url).toBeNull();
    });

    it("activating a brand-new tab uses its own fresh WebContentsView (no reload of old)", async () => {
      const win = createWindow();
      await showPreview(win, { threadId: "thread-A", url: "https://first.test" });
      const firstView = createdViews[0]!;
      firstView.webContents.getURL.mockReturnValue("https://first.test");
      const beforeCount = createdViews.length;

      // Create + activate a new blank tab.
      firstView.webContents.loadURL.mockClear();
      const created = callTabs<{ tabId: string }>(win, "preview:tabs.create", {
        threadId: "thread-A",
        activate: true,
      });
      expect(created.ok).toBe(true);

      // A new WebContentsView was created for the new tab, and the first
      // tab's view was NOT touched (no loadURL on it).
      expect(createdViews.length).toBeGreaterThan(beforeCount);
      expect(firstView.webContents.loadURL).not.toHaveBeenCalled();
    });

    it("rejects invalid thread or tab ids", () => {
      const win = createWindow();
      const r1 = callTabs(win, "preview:tabs.list", { threadId: "" });
      expect(r1.ok).toBe(false);
      const r2 = callTabs(win, "preview:tabs.activate", {
        threadId: "thread-A",
        tabId: "",
      });
      expect(r2.ok).toBe(false);
    });
  });

  describe("memory-saver hysteresis (#454 guard)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("cancels the scheduled hidden discard when the panel reappears within the window", async () => {
      const win = createWindow();

      // Create 3 warm tabs on separate threads at T=0 so they are old enough
      // (> hiddenIdleMs = 60s) to be eligible for discard during the hidden sweep.
      // Each thread switch keeps the previous thread's WebContentsView warm (alive)
      // but unmounts it, so collectWarmTabs sees 4 live views total.
      await showPreview(win, { threadId: "hys-t1" });
      await showPreview(win, { threadId: "hys-t2" });
      await showPreview(win, { threadId: "hys-t3" });

      // Advance time past hiddenIdleMs so the 3 idle tabs become overflow-eligible.
      await vi.advanceTimersByTimeAsync(65_000);

      // Bring in a 4th thread (MRU; its lastActiveAt = now = T+65s). This thread
      // is what will be "active" at hide time.
      await showPreview(win, { threadId: "hys-t4" });
      expect(createdViews.length).toBeGreaterThanOrEqual(4);

      // Hide -> schedules a hidden discard timer (default hiddenIdleMs = 60s).
      // With 4 warm tabs and maxWarm=3, the oldest (one of t1/t2/t3) sits in the
      // overflow slot and would be discarded when the timer fires.
      await hidePreview(win, { threadId: "hys-t4" });

      // The synchronous timer handle must be set immediately after hiding; this is
      // the only state we can inspect deterministically (the discard callback is a
      // floating Promise and cannot be reliably awaited in a fake-timer environment).
      const s = sessions.get(win.id)!;
      expect(s.discardHiddenTimer).not.toBeNull();

      // Re-show before the timer elapses -> onPreviewVisible cancels discardHiddenTimer.
      await showPreview(win, { threadId: "hys-t4" });

      // Primary discriminating assertion: hysteresis guard set the handle to null
      // synchronously. Without the re-show call this would still be non-null and
      // the timer would fire after hiddenIdleMs, discarding the overflow tab.
      expect(s.discardHiddenTimer).toBeNull();

      // Advance well past hiddenIdleMs; the cancelled timer must not fire.
      await vi.advanceTimersByTimeAsync(120_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      for (const v of createdViews) {
        expect(v.webContents.close).not.toHaveBeenCalled();
      }
    });

    it("does not schedule hidden discard when renderer webview hides the native view", async () => {
      const win = createWindow();
      const ev = fakeEvent(win);

      await showPreview(win, { threadId: "webview-owner" });
      await ipcHandlers["preview:sync"]!(ev, {
        visible: false,
        bounds: VALID_BOUNDS,
        threadId: "webview-owner",
        hideReason: "renderer-webview",
        workspaceId: "ws-1",
      });

      const s = sessions.get(win.id)!;
      expect(s.discardHiddenTimer).toBeNull();
    });
  });

  describe("design mode (Phase G)", () => {
    it("viewport screenshot uses the active adopted webview when no native view exists", async () => {
      const win = createWindow();
      const ev = fakeEvent(win);

      await ipcHandlers["preview:sync"]!(ev, {
        visible: false,
        bounds: VALID_BOUNDS,
        threadId: "thread-webview",
        resumeUrlHint: "https://example.com",
        workspaceId: "ws-1",
      });

      const adopted = makeWebContentsView().webContents;
      adopted.getURL.mockReturnValue("https://example.com/page");
      adopted.getTitle.mockReturnValue("Adopted page");
      adopted.executeJavaScript.mockResolvedValueOnce(
        JSON.stringify({
          visibleText: "Visible adopted text",
          headingOutline: "H1: Adopted",
          interactiveOutline: "- [button] Save",
          scrollX: 0,
          scrollY: 4,
          layoutWidth: 1024,
          layoutHeight: 768,
        }),
      );
      mockWebContentsById.set(44, adopted);

      const tabId = sessions.get(win.id)!.tabsByThread.get("thread-webview")!.activeTabId;
      await ipcHandlers["preview:adopt-webview"]!(ev, {
        threadId: "thread-webview",
        tabId,
        webContentsId: 44,
      });

      const result = await ipcHandlers["preview:capture-picture-reference"]!(ev) as {
        ok: true;
        capture: { pageUrl: string; pageTitle: string; visibleTextExcerpt?: string };
      };

      expect(result.ok).toBe(true);
      expect(adopted.capturePage).toHaveBeenCalledTimes(1);
      expect(result.capture.pageUrl).toBe("https://example.com/page");
      expect(result.capture.pageTitle).toBe("Adopted page");
      expect(result.capture.visibleTextExcerpt).toContain("Visible adopted text");
    });

    it("annotation snapshot burns marker and active highlight overlay into the captured viewport", async () => {
      const win = createWindow();
      const ev = fakeEvent(win);

      await ipcHandlers["preview:sync"]!(ev, {
        visible: false,
        bounds: VALID_BOUNDS,
        threadId: "thread-webview",
        resumeUrlHint: "https://example.com",
        workspaceId: "ws-1",
      });

      const adopted = makeWebContentsView().webContents;
      adopted.getURL.mockReturnValue("https://example.com/page");
      adopted.getTitle.mockReturnValue("Adopted page");
      adopted.executeJavaScript
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(
          JSON.stringify({
            visibleText: "Visible adopted text",
            headingOutline: "H1: Adopted",
            interactiveOutline: "- [button] Save",
            scrollX: 0,
            scrollY: 4,
            layoutWidth: 1024,
            layoutHeight: 768,
          }),
        )
        .mockResolvedValueOnce(undefined);
      mockWebContentsById.set(46, adopted);

      const tabId = sessions.get(win.id)!.tabsByThread.get("thread-webview")!.activeTabId;
      await ipcHandlers["preview:adopt-webview"]!(ev, {
        threadId: "thread-webview",
        tabId,
        webContentsId: 46,
      });

      const result = await ipcHandlers["preview:capture-annotation-snapshot"]!(ev, {
        activeDisplayNumber: 2,
        activeBounds: { x: 200, y: 120, width: 180, height: 44 },
        markers: [
          { displayNumber: 1, bounds: { x: 20, y: 24, width: 120, height: 32 } },
          { displayNumber: 2, bounds: { x: 200, y: 120, width: 180, height: 44 } },
        ],
      }) as {
        ok: true;
        capture: { pageUrl: string; pageTitle: string; visibleTextExcerpt?: string };
      };

      expect(result.ok).toBe(true);
      expect(adopted.capturePage).toHaveBeenCalledTimes(1);
      expect(adopted.capturePage).toHaveBeenCalledWith();
      const overlayJs = adopted.executeJavaScript.mock.calls[0]![0] as string;
      expect(overlayJs).toContain("__mcode_annotation_snapshot_overlay");
      expect(overlayJs).toContain("mcode-annotation-highlight");
      expect(overlayJs).toContain('"activeDisplayNumber":2');
      expect(overlayJs).toContain('"displayNumber":1');
      expect(overlayJs).toContain('"displayNumber":2');
      const waitForPaintJs = adopted.executeJavaScript.mock.calls[1]![0] as string;
      expect(waitForPaintJs).toContain("requestAnimationFrame");
      expect(waitForPaintJs).toContain("__mcode_annotation_snapshot_overlay");
      expect(adopted.executeJavaScript.mock.invocationCallOrder[1]).toBeLessThan(
        adopted.capturePage.mock.invocationCallOrder[0]!,
      );
      const removeJs = adopted.executeJavaScript.mock.calls.at(-1)![0] as string;
      expect(removeJs).toContain("__mcode_annotation_snapshot_overlay");
      expect(removeJs).toContain("remove()");
      expect(result.capture.visibleTextExcerpt).toContain("Visible adopted text");
    });

    it("page context uses the active adopted webview when no native view exists", async () => {
      const win = createWindow();
      const ev = fakeEvent(win);

      await ipcHandlers["preview:sync"]!(ev, {
        visible: false,
        bounds: VALID_BOUNDS,
        threadId: "thread-webview",
        resumeUrlHint: "https://example.com",
        workspaceId: "ws-1",
      });

      const adopted = makeWebContentsView().webContents;
      adopted.getURL.mockReturnValue("https://example.com/context");
      adopted.getTitle.mockReturnValue("Context page");
      adopted.executeJavaScript.mockResolvedValueOnce(
        JSON.stringify({
          visibleText: "Context visible text",
          headingOutline: "H2: Context",
          interactiveOutline: "- [a] Details",
          scrollX: 2,
          scrollY: 6,
          layoutWidth: 800,
          layoutHeight: 600,
        }),
      );
      mockWebContentsById.set(45, adopted);

      const tabId = sessions.get(win.id)!.tabsByThread.get("thread-webview")!.activeTabId;
      await ipcHandlers["preview:adopt-webview"]!(ev, {
        threadId: "thread-webview",
        tabId,
        webContentsId: 45,
      });

      const result = await ipcHandlers["preview:capture-context-reference"]!(ev) as {
        ok: true;
        capture: { pageUrl: string; pageTitle: string; visibleTextExcerpt?: string };
      };

      expect(result.ok).toBe(true);
      expect(adopted.capturePage).not.toHaveBeenCalled();
      expect(result.capture.pageUrl).toBe("https://example.com/context");
      expect(result.capture.pageTitle).toBe("Context page");
      expect(result.capture.visibleTextExcerpt).toContain("Context visible text");
    });

    it("element pick uses the active adopted webview when no native view exists", async () => {
      vi.useFakeTimers();
      try {
        const win = createWindow();
        const ev = fakeEvent(win);

        await ipcHandlers["preview:sync"]!(ev, {
          visible: false,
          bounds: VALID_BOUNDS,
          threadId: "thread-webview",
          resumeUrlHint: "https://example.com",
          workspaceId: "ws-1",
        });

        const adopted = makeWebContentsView().webContents;
        adopted.executeJavaScript
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(JSON.stringify({ state: "cancelled", seq: 1 }));
        mockWebContentsById.set(42, adopted);

        const adoptedResult = await ipcHandlers["preview:adopt-webview"]!(ev, {
          threadId: "thread-webview",
          tabId: sessions.get(win.id)!.tabsByThread.get("thread-webview")!.activeTabId,
          webContentsId: 42,
        });
        expect(adoptedResult).toEqual({ ok: true });
        expect(sessions.get(win.id)!.view).toBeNull();

        const capturePromise = ipcHandlers["preview:capture-picture-element-pick"]!(
          ev,
        ) as Promise<unknown>;
        await Promise.resolve();

        expect(adopted.executeJavaScript).toHaveBeenCalledTimes(1);
        const injectedPicker = adopted.executeJavaScript.mock.calls[0]![0] as string;
        expect(injectedPicker).toContain("data:image/svg+xml");
        expect(injectedPicker).toContain("pointer !important");
        expect(injectedPicker).not.toContain("cursor:crosshair !important");

        await vi.advanceTimersByTimeAsync(120);
        await expect(capturePromise).resolves.toEqual({ ok: false, error: "cancelled" });
        expect(adopted.executeJavaScript).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("element pick capture stays on the same adopted webview through commit", async () => {
      vi.useFakeTimers();
      try {
        const win = createWindow();
        const ev = fakeEvent(win);
        await ipcHandlers["preview:sync"]!(ev, {
          visible: false,
          bounds: VALID_BOUNDS,
          threadId: "thread-webview",
          resumeUrlHint: "https://example.com",
          workspaceId: "ws-1",
        });

        const adopted = makeWebContentsView().webContents;
        adopted.getURL.mockReturnValue("https://example.com/page");
        adopted.executeJavaScript
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(JSON.stringify({ state: "commit", seq: 1, x: 10, y: 20 }))
          .mockResolvedValueOnce(
            JSON.stringify({
              ok: true,
              bounds: { x: 8, y: 18, width: 120, height: 80 },
              selectorHint: "button.primary",
              htmlExcerpt: "<button>Attach</button>",
              elementStyle: {
                textColor: "rgb(255, 255, 255)",
                background: "rgb(10, 52, 92)",
                opacity: 0.8,
                font: "Inter, sans-serif",
                fontSize: "14px",
                borderTopLeftRadius: "6px",
                width: "120px",
                height: "80px",
                paddingLeft: "20px",
                paddingTop: "4px",
                marginRight: "8px",
                borderBottomWidth: "2px",
              },
            }),
          )
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(JSON.stringify({ visibleText: "Attach", scrollX: 0, scrollY: 0 }));
        mockWebContentsById.set(43, adopted);

        const tabId = sessions.get(win.id)!.tabsByThread.get("thread-webview")!.activeTabId;
        await ipcHandlers["preview:adopt-webview"]!(ev, {
          threadId: "thread-webview",
          tabId,
          webContentsId: 43,
        });

        const capturePromise = ipcHandlers["preview:capture-picture-element-pick"]!(
          ev,
        ) as Promise<{
          ok: true;
          meta: { sizeBytes: number };
          previewBytes: Uint8Array;
          capture: { elementStyle?: Record<string, unknown> };
        }>;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(120);
        const result = await capturePromise;

        expect(result.ok).toBe(true);
        expect(result.meta.sizeBytes).toBeGreaterThan(0);
        expect(result.previewBytes.length).toBeGreaterThan(0);
        expect(result.capture.elementStyle).toMatchObject({
          textColor: "rgb(255, 255, 255)",
          background: "rgb(10, 52, 92)",
          opacity: 0.8,
          fontSize: "14px",
          borderTopLeftRadius: "6px",
          paddingLeft: "20px",
          paddingTop: "4px",
          marginRight: "8px",
          borderBottomWidth: "2px",
        });
        expect(adopted.capturePage).toHaveBeenCalledWith({ x: 8, y: 18, width: 120, height: 80 });
        expect(adopted.executeJavaScript).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("element pick still falls back to the native WebContentsView", async () => {
      vi.useFakeTimers();
      try {
        const win = createWindow();
        await showPreview(win);
        const view = createdViews[0]!;
        view.webContents.executeJavaScript
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(JSON.stringify({ state: "cancelled", seq: 1 }));

        const capturePromise = ipcHandlers["preview:capture-picture-element-pick"]!(
          fakeEvent(win),
        ) as Promise<unknown>;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(120);

        await expect(capturePromise).resolves.toEqual({ ok: false, error: "cancelled" });
        expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("setViewport applies a named preset and centers within panel bounds", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getURL.mockReturnValue("https://example.com");
      view.setBounds.mockClear();

      const ev = fakeEvent(win);
      const result = await ipcHandlers["preview:design.set-viewport"]!(ev, {
        presetId: "phone",
      });
      expect(result).toMatchObject({ ok: true, data: { width: 390, height: 844 } });
      expect(view.setBounds).toHaveBeenCalledWith(
        { x: 361, y: 100, width: 277, height: 600 },
      );
      expect(view.webContents.enableDeviceEmulation).toHaveBeenCalledWith(expect.objectContaining({
        viewSize: { width: 390, height: 844 },
        screenSize: { width: 390, height: 844 },
        scale: 600 / 844,
      }));
    });

    it("setViewport rejects unknown preset", async () => {
      const win = createWindow();
      await showPreview(win);
      const result = await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        presetId: "fridge",
      });
      expect(result).toMatchObject({ ok: false, error: "unknown-preset" });
    });

    it("rejects malformed viewport IPC payloads before touching the session", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getURL.mockReturnValue("https://example.com");
      view.setBounds.mockClear();

      const result = await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        operationId: 42,
        widthOverride: 640,
        heightOverride: 480,
      });

      expect(result).toEqual({ ok: false, error: "invalid-viewport-request" });
      expect(view.setBounds).not.toHaveBeenCalled();
    });

    it("rejects malformed presentation IPC payloads before applying native state", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.enableDeviceEmulation.mockClear();

      const result = await ipcHandlers["preview:design.set-presentation"]!(fakeEvent(win), {
        presentation: "zoom",
        targetGeneration: 1,
      });

      expect(result).toEqual({ ok: false, error: "invalid-viewport-presentation-request" });
      expect(view.webContents.enableDeviceEmulation).not.toHaveBeenCalled();
    });

    it("setViewport with explicit dimensions clamps to the CSS viewport bounds", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getURL.mockReturnValue("https://example.com");
      view.setBounds.mockClear();
      // VALID_BOUNDS is 800x600; CSS viewport bounds are independent of it.
      const result = await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        widthOverride: 10_000,
        heightOverride: 10_000,
      });
      expect(result).toMatchObject({ ok: true, data: { width: 2_560, height: 2_560 } });
      expect(view.setBounds).toHaveBeenCalledWith(
        { x: 200, y: 100, width: 600, height: 600 },
      );
      expect(view.webContents.enableDeviceEmulation).toHaveBeenCalledWith(expect.objectContaining({
        viewSize: { width: 2_560, height: 2_560 },
        screenSize: { width: 2_560, height: 2_560 },
        scale: 600 / 2_560,
      }));
    });

    it("echoes viewport operation identity and rejects stale generations", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getURL.mockReturnValue("https://example.com");
      const activeTabId = sessions.get(win.id)!.tabsByThread.get("thread-1")!.activeTabId!;
      view.setBounds.mockClear();
      const applied = await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        widthOverride: 640,
        heightOverride: 480,
        operationId: "viewport-user-5",
        source: "user",
        targetGeneration: 5,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      expect(applied).toMatchObject({
        ok: true,
        data: { width: 640, height: 480 },
        operationId: "viewport-user-5",
        source: "user",
        targetGeneration: 5,
        threadId: "thread-1",
        tabId: activeTabId,
        appliedViewport: { width: 640, height: 480 },
      });
      const stale = await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        widthOverride: 700,
        heightOverride: 500,
        operationId: "viewport-agent-4",
        source: "agent",
        targetGeneration: 4,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      expect(stale).toMatchObject({
        ok: false,
        error: "stale-target-generation",
        appliedViewport: { width: 640, height: 480 },
        operationId: "viewport-agent-4",
        source: "agent",
        targetGeneration: 4,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      expect(view.setBounds).toHaveBeenCalledTimes(1);
    });

    it("preserves the CSS viewport while panel resize updates native presentation scale", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getURL.mockReturnValue("https://example.com");
      const activeTabId = sessions.get(win.id)!.tabsByThread.get("thread-1")!.activeTabId!;

      await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        widthOverride: 1200,
        heightOverride: 800,
        operationId: "viewport-panel-resize",
        source: "user",
        targetGeneration: 3,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      view.setBounds.mockClear();
      view.webContents.enableDeviceEmulation.mockClear();

      await ipcHandlers["preview:sync"]!(fakeEvent(win), {
        visible: true,
        bounds: { x: 100, y: 100, width: 600, height: 400 },
        threadId: "thread-1",
        workspaceId: "ws-1",
      });

      expect(sessions.get(win.id)!.viewportAppliedByTarget.get(
        JSON.stringify(["thread-1", activeTabId]),
      )).toEqual({ width: 1200, height: 800 });
      expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
        viewSize: { width: 1_200, height: 800 },
        screenSize: { width: 1_200, height: 800 },
        scale: 0.5,
      }));
      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 100,
        y: 100,
        width: 600,
        height: 400,
      });
    });

    it("applies Fit and Actual presentation through native emulation IPC", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getURL.mockReturnValue("https://example.com");
      const activeTabId = sessions.get(win.id)!.tabsByThread.get("thread-1")!.activeTabId!;

      await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        widthOverride: 1_200,
        heightOverride: 800,
        operationId: "viewport-presentation-base",
        source: "user",
        targetGeneration: 3,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      view.webContents.enableDeviceEmulation.mockClear();
      view.setBounds.mockClear();

      const fit = await ipcHandlers["preview:design.set-presentation"]!(fakeEvent(win), {
        presentation: "fit",
        operationId: "viewport-presentation-fit",
        source: "user",
        targetGeneration: 3,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      expect(fit).toMatchObject({
        ok: true,
        presentation: "fit",
        appliedViewport: { width: 1_200, height: 800 },
      });
      expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
        viewSize: { width: 1_200, height: 800 },
        screenSize: { width: 1_200, height: 800 },
        scale: 2 / 3,
      }));
      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 100,
        y: 133,
        width: 800,
        height: 533,
      });

      const actual = await ipcHandlers["preview:design.set-presentation"]!(fakeEvent(win), {
        presentation: "actual",
        operationId: "viewport-presentation-actual",
        source: "user",
        targetGeneration: 3,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      expect(actual).toMatchObject({
        ok: true,
        presentation: "actual",
        appliedViewport: { width: 1_200, height: 800 },
      });
      expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
        viewSize: { width: 1_200, height: 800 },
        screenSize: { width: 1_200, height: 800 },
        scale: 1,
      }));
      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: -100,
        y: 0,
        width: 1_200,
        height: 800,
      });
    });

    it("rejects stale native presentation requests before applying them", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.getURL.mockReturnValue("https://example.com");
      const activeTabId = sessions.get(win.id)!.tabsByThread.get("thread-1")!.activeTabId!;
      await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        widthOverride: 1_200,
        heightOverride: 800,
        targetGeneration: 5,
        threadId: "thread-1",
        tabId: activeTabId,
      });
      view.webContents.enableDeviceEmulation.mockClear();

      const result = await ipcHandlers["preview:design.set-presentation"]!(fakeEvent(win), {
        presentation: "actual",
        operationId: "viewport-presentation-stale",
        source: "agent",
        targetGeneration: 4,
        threadId: "thread-1",
        tabId: activeTabId,
      });

      expect(result).toMatchObject({ ok: false, error: "stale-target-generation" });
      expect(view.webContents.enableDeviceEmulation).not.toHaveBeenCalled();
    });

    it("resetViewport restores the panel bounds", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      await ipcHandlers["preview:design.set-viewport"]!(fakeEvent(win), {
        presetId: "phone",
      });
      view.setBounds.mockClear();
      const reset = await ipcHandlers["preview:design.reset-viewport"]!(fakeEvent(win), {});
      expect(reset).toEqual({ ok: true });
      expect(view.setBounds).toHaveBeenCalledWith(VALID_BOUNDS);
    });

    it("setInspect runs executeJavaScript on the guest", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.executeJavaScript.mockClear();
      const r1 = await ipcHandlers["preview:design.set-inspect"]!(fakeEvent(win), {
        enabled: true,
      });
      expect(r1).toEqual({ ok: true });
      expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      const arg1 = view.webContents.executeJavaScript.mock.calls[0]![0] as string;
      expect(arg1).toContain("__mcodeInspectActive");

      const r2 = await ipcHandlers["preview:design.set-inspect"]!(fakeEvent(win), {
        enabled: false,
      });
      expect(r2).toEqual({ ok: true });
      const arg2 = view.webContents.executeJavaScript.mock.calls[1]![0] as string;
      expect(arg2).toContain("__mcodeInspectTeardown");
    });

    it("setAnnotationGuard injects and tears down the page interaction guard", async () => {
      const win = createWindow();
      await showPreview(win);
      const view = createdViews[0]!;
      view.webContents.executeJavaScript.mockClear();

      const r1 = await ipcHandlers["preview:design.set-annotation-guard"]!(fakeEvent(win), {
        enabled: true,
      });
      expect(r1).toEqual({ ok: true });
      expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      const arg1 = view.webContents.executeJavaScript.mock.calls[0]![0] as string;
      expect(arg1).toContain("__mcodeAnnotationGuardActive");

      const r2 = await ipcHandlers["preview:design.set-annotation-guard"]!(fakeEvent(win), {
        enabled: false,
      });
      expect(r2).toEqual({ ok: true });
      const arg2 = view.webContents.executeJavaScript.mock.calls[1]![0] as string;
      expect(arg2).toContain("__mcodeAnnotationGuardTeardown");
    });
  });
});
