import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windowActionsTest = vi.hoisted(() => ({
  app: { isPackaged: false, quit: vi.fn() },
}));

vi.mock("electron", () => ({ app: windowActionsTest.app }));

import {
  DESKTOP_WINDOW_ACTIONS,
  performDesktopWindowAction,
} from "../window-actions.js";

function createWindow() {
  let fullScreen = false;
  let devToolsOpen = false;
  const webContents = {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    getZoomLevel: vi.fn(() => 1),
    setZoomLevel: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    isDevToolsOpened: vi.fn(() => devToolsOpen),
    closeDevTools: vi.fn(() => {
      devToolsOpen = false;
    }),
    openDevTools: vi.fn(() => {
      devToolsOpen = true;
    }),
  };
  const window = {
    webContents,
    close: vi.fn(),
    isFullScreen: vi.fn(() => fullScreen),
    setFullScreen: vi.fn((value: boolean) => {
      fullScreen = value;
    }),
  };
  return { window, webContents };
}

describe("Desktop Window native actions", () => {
  beforeEach(() => {
    windowActionsTest.app.quit.mockClear();
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the complete native action allowlist", () => {
    expect([...DESKTOP_WINDOW_ACTIONS]).toEqual([
      "closeWindow",
      "quit",
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "zoomIn",
      "zoomOut",
      "zoomReset",
      "toggleFullScreen",
      "reload",
      "toggleDevTools",
    ]);
  });

  it.each([
    ["undo", "undo"],
    ["redo", "redo"],
    ["cut", "cut"],
    ["copy", "copy"],
    ["paste", "paste"],
    ["selectAll", "selectAll"],
  ] as const)("applies the %s edit action", (action, method) => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, action);

    expect(fixture.webContents[method]).toHaveBeenCalledOnce();
  });

  it("closes the target window and quits the application", () => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, "closeWindow");
    performDesktopWindowAction(fixture.window as never, "quit");

    expect(fixture.window.close).toHaveBeenCalledOnce();
    expect(windowActionsTest.app.quit).toHaveBeenCalledOnce();
  });

  it("changes zoom by one half level and resets it", () => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, "zoomIn");
    performDesktopWindowAction(fixture.window as never, "zoomOut");
    performDesktopWindowAction(fixture.window as never, "zoomReset");

    expect(fixture.webContents.setZoomLevel).toHaveBeenNthCalledWith(1, 1.5);
    expect(fixture.webContents.setZoomLevel).toHaveBeenNthCalledWith(2, 0.5);
    expect(fixture.webContents.setZoomLevel).toHaveBeenNthCalledWith(3, 0);
  });

  it("toggles fullscreen", () => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, "toggleFullScreen");

    expect(fixture.window.setFullScreen).toHaveBeenCalledWith(true);
  });

  it("allows reload and DevTools only in desktop development", () => {
    const fixture = createWindow();
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");

    performDesktopWindowAction(fixture.window as never, "reload");
    performDesktopWindowAction(fixture.window as never, "toggleDevTools");
    performDesktopWindowAction(fixture.window as never, "toggleDevTools");

    expect(fixture.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(fixture.webContents.openDevTools).toHaveBeenCalledWith({ mode: "right" });
    expect(fixture.webContents.closeDevTools).toHaveBeenCalledOnce();
  });

  it("does not reload or open DevTools outside desktop development", () => {
    const fixture = createWindow();

    performDesktopWindowAction(fixture.window as never, "reload");
    performDesktopWindowAction(fixture.window as never, "toggleDevTools");

    expect(fixture.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(fixture.webContents.openDevTools).not.toHaveBeenCalled();
  });
});
