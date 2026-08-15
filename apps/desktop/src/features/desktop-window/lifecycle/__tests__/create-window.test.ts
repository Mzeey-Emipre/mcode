import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";

const createWindowTest = vi.hoisted(() => {
  type Listener = (...args: any[]) => unknown;
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
    openDevTools: vi.fn(),
  };
  const window = {
    id: 17,
    webContents,
    once: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
    on: vi.fn((event: string, listener: Listener) => addListener(event, listener)),
    show: vi.fn(),
    setMenuBarVisibility: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
  };
  const BrowserWindow = vi.fn(function BrowserWindow() {
    return window;
  });
  const app = {
    isPackaged: false,
    getAppPath: vi.fn(() => "C:/mcode"),
  };
  return {
    listeners,
    webContents,
    window,
    BrowserWindow,
    app,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    reset() {
      listeners.clear();
      vi.clearAllMocks();
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: createWindowTest.BrowserWindow,
  app: createWindowTest.app,
}));

import { createWindow } from "../create-window.js";

function createHooks() {
  return {
    disposePreviewForWindow: vi.fn(),
    disposeBrowserAutomationForWindow: vi.fn(),
    hardenPreviewWebviewAttachment: vi.fn(),
    resolvePreviewGuestPreloadPath: vi.fn(() => "C:/mcode/dist/preload/preview-guest-preload.cjs"),
    setupSpellcheck: vi.fn(),
    attachServerWindow: vi.fn(),
  };
}

describe("Desktop Window creation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createWindowTest.reset();
    delete process.env.ELECTRON_RENDERER_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a hidden secure window with the current non-macOS title-bar options", () => {
    const hooks = createHooks();

    createWindow({ isDesktopDev: () => false, hooks });

    const options = createWindowTest.BrowserWindow.mock.calls[0][0] as Record<string, any>;
    const iconFile =
      process.platform === "win32"
        ? "icon.ico"
        : process.platform === "darwin"
          ? "icon.icns"
          : "icon.png";
    expect(options).toMatchObject({
      width: 1200,
      icon: join("C:/mcode", "build", iconFile),
      height: 800,
      show: false,
      backgroundColor: "#0a0a0f",
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#8a8a92",
        height: 40,
      },
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
        webviewTag: true,
        devTools: false,
      },
    });
    expect(String(options.webPreferences.preload)).toContain("preload.cjs");
    expect(createWindowTest.window.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(hooks.setupSpellcheck).toHaveBeenCalledWith(createWindowTest.window);
    expect(hooks.attachServerWindow).toHaveBeenCalledWith(createWindowTest.window);
  });

  it("keeps the macOS title-bar and traffic-light options", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      createWindow({ isDesktopDev: () => false, hooks: createHooks() });
      const options = createWindowTest.BrowserWindow.mock.calls[0][0] as Record<string, any>;

      expect(options.titleBarStyle).toBe("hiddenInset");
      expect(options.trafficLightPosition).toEqual({ x: 14, y: 12 });
      expect(options.titleBarOverlay).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("shows on first paint and clears the fallback timer", () => {
    createWindow({ isDesktopDev: () => false, hooks: createHooks() });

    createWindowTest.emit("ready-to-show");
    expect(createWindowTest.window.show).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3000);
    expect(createWindowTest.window.show).toHaveBeenCalledOnce();
  });

  it("shows after the bounded fallback when first paint does not occur", () => {
    createWindow({ isDesktopDev: () => false, hooks: createHooks() });

    vi.advanceTimersByTime(2999);
    expect(createWindowTest.window.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(createWindowTest.window.show).toHaveBeenCalledOnce();
  });

  it("loads the development URL and opens restricted DevTools in development", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    createWindow({ isDesktopDev: () => true, hooks: createHooks() });

    expect(createWindowTest.window.loadURL).toHaveBeenCalledWith("http://localhost:5173");
    expect(createWindowTest.window.loadFile).not.toHaveBeenCalled();
    createWindowTest.emit("did-finish-load");
    expect(createWindowTest.webContents.openDevTools).toHaveBeenCalledWith({ mode: "right" });
  });

  it("loads the packaged renderer and does not open DevTools", () => {
    createWindow({ isDesktopDev: () => false, hooks: createHooks() });

    expect(createWindowTest.window.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer[\\/]index\.html/),
    );
    createWindowTest.emit("did-finish-load");
    expect(createWindowTest.webContents.openDevTools).not.toHaveBeenCalled();
  });

  it("hardens Preview webviews and disposes resources only after close completes", () => {
    const hooks = createHooks();
    createWindow({ isDesktopDev: () => false, hooks });
    const preferences = { nodeIntegration: true };
    const params = { preload: "C:/attacker/preload.js" };

    createWindowTest.emit("will-attach-webview", {}, preferences, params);
    createWindowTest.emit("close");

    expect(hooks.disposePreviewForWindow).not.toHaveBeenCalled();
    expect(hooks.disposeBrowserAutomationForWindow).not.toHaveBeenCalled();

    createWindowTest.emit("closed");

    expect(hooks.hardenPreviewWebviewAttachment).toHaveBeenCalledWith(
      preferences,
      params,
      "C:/mcode/dist/preload/preview-guest-preload.cjs",
    );
    expect(hooks.disposePreviewForWindow).toHaveBeenCalledWith(createWindowTest.window);
    expect(hooks.disposeBrowserAutomationForWindow).toHaveBeenCalledWith(17);
  });
});
