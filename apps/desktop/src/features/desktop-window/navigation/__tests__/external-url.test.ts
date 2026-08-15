import { beforeEach, describe, expect, it, vi } from "vitest";

const externalUrlTest = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const shell = { openExternal: vi.fn(() => Promise.resolve()) };
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
  return { handlers, shell, ipcMain };
});

vi.mock("electron", () => ({
  ipcMain: externalUrlTest.ipcMain,
  shell: externalUrlTest.shell,
}));

import {
  openExternalUrl,
  registerExternalUrlHandler,
} from "../external-url.js";

describe("Desktop Window external URL policy", () => {
  beforeEach(() => {
    externalUrlTest.handlers.clear();
    externalUrlTest.shell.openExternal.mockClear();
  });

  it.each([
    "https://example.com/docs",
    "http://example.com/docs",
    "mailto:user@example.com",
  ])("opens approved %s URLs", (url) => {
    openExternalUrl(url);

    expect(externalUrlTest.shell.openExternal).toHaveBeenCalledWith(url);
  });

  it.each(["file:///tmp/mcode.html", "javascript:alert(1)", "not a URL"])(
    "denies %s URLs",
    (url) => {
      openExternalUrl(url);

      expect(externalUrlTest.shell.openExternal).not.toHaveBeenCalled();
    },
  );

  it("delegates workspace Preview URLs to the public Preview resolver", async () => {
    const resolveWorkspacePreviewUrl = vi.fn(async () => ({
      ok: true as const,
      url: "file:///workspace/docs/page.html",
    }));
    registerExternalUrlHandler(resolveWorkspacePreviewUrl);

    const handler = externalUrlTest.handlers.get("open-external-url");
    await handler?.({}, "  mcode-workspace:///docs/page.html  ", " C:/workspace ");

    expect(resolveWorkspacePreviewUrl).toHaveBeenCalledWith(
      "mcode-workspace:///docs/page.html",
      "C:/workspace",
    );
    expect(externalUrlTest.shell.openExternal).toHaveBeenCalledWith(
      "file:///workspace/docs/page.html",
    );
  });

  it("does not open unresolved workspace Preview URLs", async () => {
    const resolveWorkspacePreviewUrl = vi.fn(async () => ({
      ok: false as const,
      error: "invalid-url",
    }));
    registerExternalUrlHandler(resolveWorkspacePreviewUrl);

    const handler = externalUrlTest.handlers.get("open-external-url");
    await handler?.({}, "mcode-workspace:///../escape.html", null);

    expect(externalUrlTest.shell.openExternal).not.toHaveBeenCalled();
  });
});
