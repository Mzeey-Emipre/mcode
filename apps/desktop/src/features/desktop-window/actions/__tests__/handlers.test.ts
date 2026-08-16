import { beforeEach, describe, expect, it, vi } from "vitest";

const handlersTest = vi.hoisted(() => {
  type Handler = (...args: any[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
  const browserWindowFromWebContents = vi.fn();
  const app = { isPackaged: false, quit: vi.fn() };
  return { handlers, ipcMain, browserWindowFromWebContents, app };
});

vi.mock("electron", () => ({
  ipcMain: handlersTest.ipcMain,
  BrowserWindow: { fromWebContents: handlersTest.browserWindowFromWebContents },
  app: handlersTest.app,
}));

import { registerDesktopWindowActionHandler } from "../handlers.js";

describe("Desktop Window action IPC handler", () => {
  beforeEach(() => {
    handlersTest.handlers.clear();
    handlersTest.browserWindowFromWebContents.mockReset();
    registerDesktopWindowActionHandler();
  });

  it("authorizes the sender window and dispatches an allowed action", () => {
    const close = vi.fn();
    const window = { isDestroyed: vi.fn(() => false), close };
    handlersTest.browserWindowFromWebContents.mockReturnValue(window);

    const handler = handlersTest.handlers.get("window:perform")!;
    handler({ sender: { id: 1 } }, "closeWindow");

    expect(handlersTest.browserWindowFromWebContents).toHaveBeenCalledWith({ id: 1 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects invalid action values before resolving a sender window", () => {
    const handler = handlersTest.handlers.get("window:perform")!;

    expect(() => handler({ sender: {} }, "execute arbitrary code")).toThrow(
      "Invalid desktop window action",
    );
    expect(handlersTest.browserWindowFromWebContents).not.toHaveBeenCalled();
  });

  it("ignores unauthorized and destroyed sender windows", () => {
    const handler = handlersTest.handlers.get("window:perform")!;
    const destroyed = {
      isDestroyed: vi.fn(() => true),
      close: vi.fn(),
    };
    handlersTest.browserWindowFromWebContents
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(destroyed);

    handler({ sender: { id: 1 } }, "closeWindow");
    handler({ sender: { id: 2 } }, "closeWindow");

    expect(destroyed.close).not.toHaveBeenCalled();
  });
});
