import { describe, expect, it, vi } from "vitest";

const mainWindowPolicyTest = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}));

vi.mock("electron", () => mainWindowPolicyTest);

import { installMainWindowNavigationPolicy } from "../main-window-policy.js";

type NavigationListener = (event: { preventDefault(): void }, url: string) => void;

function createWindow(currentUrl: string) {
  let openHandler: ((details: { url: string }) => { action: "deny" }) | undefined;
  let navigationHandler: NavigationListener | undefined;
  const window = {
    webContents: {
      getURL: vi.fn(() => currentUrl),
      setWindowOpenHandler: vi.fn((handler) => {
        openHandler = handler;
      }),
      on: vi.fn((event: string, handler: NavigationListener) => {
        if (event === "will-navigate") navigationHandler = handler;
      }),
    },
  };
  return {
    window,
    open: (url: string) => openHandler?.({ url }),
    navigate: (url: string) => {
      const preventDefault = vi.fn();
      navigationHandler?.({ preventDefault }, url);
      return preventDefault;
    },
  };
}

describe("Desktop Window main-window navigation policy", () => {
  it("denies popups and opens approved popup URLs externally", () => {
    const openUrl = vi.fn();
    const fixture = createWindow("http://localhost:5173/");
    installMainWindowNavigationPolicy(fixture.window as never, openUrl);

    expect(fixture.open("https://example.com")).toEqual({ action: "deny" });
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("allows same-origin renderer navigation", () => {
    const openUrl = vi.fn();
    const fixture = createWindow("http://localhost:5173/");
    installMainWindowNavigationPolicy(fixture.window as never, openUrl);

    expect(fixture.navigate("http://localhost:5173/settings")).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("blocks cross-origin navigation and opens it externally", () => {
    const openUrl = vi.fn();
    const fixture = createWindow("http://localhost:5173/");
    installMainWindowNavigationPolicy(fixture.window as never, openUrl);

    const preventDefault = fixture.navigate("https://example.com");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("blocks navigation from a file renderer", () => {
    const openUrl = vi.fn();
    const fixture = createWindow("file:///app/index.html");
    installMainWindowNavigationPolicy(fixture.window as never, openUrl);

    const preventDefault = fixture.navigate("file:///app/settings.html");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("file:///app/settings.html");
  });
});
