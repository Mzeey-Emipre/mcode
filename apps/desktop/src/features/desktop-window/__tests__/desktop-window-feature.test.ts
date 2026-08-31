import { describe, expect, it, vi } from "vitest";

const desktopWindowFeatureTest = vi.hoisted(() => {
  type Listener = (...args: any[]) => unknown;
  type FakeWindow = {
    id: number;
    webContents: {
      on: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      getURL: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      openDevTools: ReturnType<typeof vi.fn>;
      getZoomLevel: ReturnType<typeof vi.fn>;
      setZoomLevel: ReturnType<typeof vi.fn>;
    };
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    setMenuBarVisibility: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  const windows: FakeWindow[] = [];
  const handlers = new Map<string, Listener>();
  let nextWindowId = 1;

  const createWindow = (): FakeWindow => {
    const listeners = new Map<string, Listener[]>();
    const addListener = (event: string, listener: Listener) => {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);
    };
    const webContents = {
      on: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      once: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      setWindowOpenHandler: vi.fn(),
      getURL: vi.fn(() => "http://localhost:5173/"),
      send: vi.fn(),
      openDevTools: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn(),
    };
    const window = {
      id: nextWindowId++,
      webContents,
      once: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      on: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
      show: vi.fn(),
      setMenuBarVisibility: vi.fn(),
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      close: vi.fn(),
    };
    windows.push(window);
    return window;
  };

  class FakeBrowserWindow {
    static getAllWindows = vi.fn(() => windows);
    static getFocusedWindow = vi.fn(() => null);
    static fromWebContents = vi.fn(() => windows[0] ?? null);

    constructor(_options: unknown) {
      return createWindow();
    }
  }

  const app = {
    isPackaged: false,
    getAppPath: vi.fn(() => "C:/mcode"),
    quit: vi.fn(),
  };
  const menu = {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  };
  const shell = { openExternal: vi.fn(() => Promise.resolve()) };
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Listener) => handlers.set(channel, handler)),
  };

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    menu,
    shell,
    ipcMain,
    handlers,
    windows,
    reset() {
      handlers.clear();
      windows.length = 0;
      nextWindowId = 1;
      vi.clearAllMocks();
    },
  };
});

vi.mock("electron", () => ({
  app: desktopWindowFeatureTest.app,
  BrowserWindow: desktopWindowFeatureTest.BrowserWindow,
  Menu: desktopWindowFeatureTest.menu,
  shell: desktopWindowFeatureTest.shell,
  ipcMain: desktopWindowFeatureTest.ipcMain,
}));

import { createDesktopWindowFeature } from "../index.js";

function dependencies() {
  return {
    platform: "linux" as const,
    isDesktopDev: () => false,
    lifecycleHooks: {
      disposePreviewForWindow: vi.fn(),
      disposeBrowserAutomationForWindow: vi.fn(),
      hardenPreviewWebviewAttachment: vi.fn(),
      resolvePreviewGuestPreloadPath: vi.fn(() => "C:/mcode/preview-preload.cjs"),
      setupSpellcheck: vi.fn(),
      attachServerWindow: vi.fn(),
    },
    closeGuard: {
      getActiveAgentCount: vi.fn(async () => 0),
      showMessageBox: vi.fn(async () => ({ response: 1 })),
      quit: vi.fn(),
    },
  };
}

describe("Desktop Window feature entry point", () => {
  it("registers native capabilities and recreates only when no window exists", () => {
    desktopWindowFeatureTest.reset();
    const deps = dependencies();
    const feature = createDesktopWindowFeature(deps);

    expect(desktopWindowFeatureTest.menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(desktopWindowFeatureTest.handlers.has("window:perform")).toBe(true);

    const firstWindow = feature.createWindow();
    const popupHandler = firstWindow.webContents.setWindowOpenHandler.mock.calls[0][0] as (
      details: { url: string },
    ) => { action: string };
    expect(popupHandler({ url: "https://example.com" })).toEqual({ action: "deny" });
    expect(desktopWindowFeatureTest.shell.openExternal).toHaveBeenCalledWith(
      "https://example.com/",
    );

    const actionHandler = desktopWindowFeatureTest.handlers.get("window:perform");
    actionHandler?.({ sender: {} }, "quit");
    expect(desktopWindowFeatureTest.app.quit).toHaveBeenCalledOnce();
    expect(deps.lifecycleHooks.setupSpellcheck).toHaveBeenCalledOnce();
    expect(deps.lifecycleHooks.attachServerWindow).toHaveBeenCalledOnce();

    expect(feature.recreateWindowIfNeeded()).toBeNull();
    desktopWindowFeatureTest.windows.length = 0;
    const recreatedWindow = feature.recreateWindowIfNeeded();
    expect(recreatedWindow).not.toBeNull();
    expect(deps.lifecycleHooks.setupSpellcheck).toHaveBeenCalledTimes(2);
    expect(deps.lifecycleHooks.attachServerWindow).toHaveBeenCalledTimes(2);
  });
});
