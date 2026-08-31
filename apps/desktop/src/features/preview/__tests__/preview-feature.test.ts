import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

const previewTest = vi.hoisted(() => {
  type IpcHandler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
  };
  const previewSession = {
    webRequest: { onCompleted: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    on: vi.fn(),
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
  };
  const browserWindowFromWebContents = vi.fn();
  const electronWebContents = {
    getAllWebContents: vi.fn((): object[] => []),
  };
  return {
    handlers,
    ipcMain,
    previewSession,
    session: { fromPartition: vi.fn(() => previewSession) },
    BrowserWindow: { fromWebContents: browserWindowFromWebContents },
    webContents: electronWebContents,
    app: { getPath: vi.fn(() => "C:/mcode-test") },
    shell: { openExternal: vi.fn() },
    nativeImage: { createFromBuffer: vi.fn() },
    browserWindowFromWebContents,
    electronWebContents,
  };
});

vi.mock("electron", () => ({
  ipcMain: previewTest.ipcMain,
  session: previewTest.session,
  BrowserWindow: previewTest.BrowserWindow,
  webContents: previewTest.webContents,
  app: previewTest.app,
  shell: previewTest.shell,
  nativeImage: previewTest.nativeImage,
}));

import {
  disposePreviewForWindow,
  hardenPreviewWebviewAttachment,
  registerPreviewBrowserHandlers,
  resolveMcodeWorkspacePreviewUrl,
  resolvePreviewGuestPreloadPath,
} from "../index.js";
import { getSession, sessions } from "../state/window-session.js";

describe("Preview feature public interface", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    registerPreviewBrowserHandlers("linux");
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("registers every Preview IPC capability, including performance counters", () => {
    const expectedChannels = [
      "preview:sync",
      "preview:resolve-navigation",
      "preview:navigate",
      "preview:go-back",
      "preview:go-forward",
      "preview:reload",
      "preview:force-reload",
      "preview:clear-cookies",
      "preview:clear-cache",
      "preview:get-zoom",
      "preview:set-zoom",
      "preview:open-external",
      "preview:get-navigation-state",
      "preview:capture-picture-reference",
      "preview:capture-annotation-snapshot",
      "preview:capture-context-reference",
      "preview:cancel-capture",
      "preview:capture-picture-region",
      "preview:capture-picture-element-pick",
      "preview:release-browser-capture-spill",
      "preview:tabs.list",
      "preview:tabs.open",
      "preview:tabs.activate",
      "preview:tabs.updateChrome",
      "preview:tabs.close",
      "preview:tabs.closeScope",
      "preview.surface.prepare",
      "preview.surface.adopt",
      "preview.surface.release",
      "preview.surface.navigate",
      "preview:design.set-inspect",
      "preview:design.set-annotation-guard",
      "preview:automation.execute",
      "preview:automation.begin-renderer-operation",
      "preview:automation.finish-renderer-operation",
      "preview:automation.cancel",
      "preview:automation.interrupt",
      "preview:automation.release-agent-control",
      "preview:automation.describe-target",
      "preview:automation.media-source",
      "preview:open-guest-devtools",
      "preview:get-perf-counters",
    ];
    const registeredChannels = [...previewTest.handlers.keys()];

    expect(registeredChannels).toEqual(expect.arrayContaining(expectedChannels));
    expect(new Set(registeredChannels).size).toBe(expectedChannels.length);
    expect(previewTest.ipcMain.on).toHaveBeenCalledWith(
      "mcode:browser-clipboard-trust",
      expect.any(Function),
    );
    expect(previewTest.ipcMain.on).toHaveBeenCalledWith(
      "preview:automation.subscribe",
      expect.any(Function),
    );
    expect(previewTest.ipcMain.on).toHaveBeenCalledWith(
      "preview:automation.heartbeat.subscribe",
      expect.any(Function),
    );
    expect(previewTest.previewSession.webRequest.onCompleted).toHaveBeenCalledWith(
      { urls: ["http://*/*", "https://*/*"] },
      expect.any(Function),
    );
    expect(previewTest.session.fromPartition).toHaveBeenCalledWith("persist:mcode-preview");
  });

  it("rejects malformed bounds and validates invalid URLs before requiring an active guest", async () => {
    const sender = { id: 301, isDestroyed: vi.fn(() => false), send: vi.fn() };
    const win = {
      id: 31,
      webContents: sender,
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => true),
    };
    previewTest.browserWindowFromWebContents.mockReturnValue(win);
    sessions.delete(win.id);
    const session = getSession(win as never);
    const sync = previewTest.handlers.get("preview:sync")!;

    for (const bounds of [
      { x: 0, y: 0, width: Number.NaN, height: 100 },
      { x: 0, y: 0, width: 100, height: Number.POSITIVE_INFINITY },
      { x: 0, y: 0, width: "100", height: 100 },
    ]) {
      await sync({ sender }, { visible: false, bounds, workspaceId: "workspace-1" });
      expect(session.lastBounds).toBeNull();
    }

    const navigate = previewTest.handlers.get("preview:navigate")!;
    await expect(navigate({ sender }, "")).resolves.toEqual({ ok: false, error: "empty-url" });
    await expect(navigate({ sender }, "file://attacker/share/page.html")).resolves.toEqual({
      ok: false,
      error: "sensitive-file",
    });

    if (session.discardHiddenTimer) clearTimeout(session.discardHiddenTimer);
    sessions.delete(win.id);
  });

  it("disposes the real window session and adopted Preview surfaces", async () => {
    const sender = {
      id: 101,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };
    const win = {
      id: 7,
      webContents: sender,
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => true),
    };
    previewTest.browserWindowFromWebContents.mockReturnValue(win);

    const openTab = previewTest.handlers.get("preview:tabs.open")!;
    const opened = (await openTab(
      { sender },
      { threadId: "thread-1", workspaceId: "workspace-1" },
    )) as { ok: true; data: { tabId: string } };
    const surface = {
      identity: {
        workspaceId: "workspace-1",
        scope: { kind: "thread" as const, id: "thread-1" },
        tabId: opened.data.tabId,
      },
      generation: 1,
    };
    const adoptionToken = "adoption-token-1";
    const prepare = previewTest.handlers.get("preview.surface.prepare")!;
    expect(await prepare({ sender }, { surface, adoptionToken })).toEqual({ ok: true });

    const guest = {
      id: 202,
      hostWebContents: sender,
      session: previewTest.previewSession,
      getType: vi.fn(() => "webview"),
      getURL: vi.fn(() => `about:blank#${adoptionToken}`),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    previewTest.electronWebContents.getAllWebContents.mockReturnValue([guest]);
    const adopt = previewTest.handlers.get("preview.surface.adopt")!;
    expect(await adopt({ sender }, { surface, adoptionToken })).toEqual({ ok: true });

    const oldTabId = opened.data.tabId;
    disposePreviewForWindow(win as never);

    expect(guest.removeListener).toHaveBeenCalled();
    expect(guest.setWindowOpenHandler).toHaveBeenCalledTimes(2);

    const reopened = (await openTab(
      { sender },
      { threadId: "thread-1", workspaceId: "workspace-1" },
    )) as { ok: true; data: { tabId: string } };
    expect(reopened.data.tabId).not.toBe(oldTabId);
  });

  it("enforces the fixed sandbox, partition, and guest preload policy", () => {
    const preferences = {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      devTools: false,
      preload: "C:/attacker/preload.js",
      preloadURL: "file:///attacker/preload.js",
    };
    const params = { partition: "persist:attacker", preload: "C:/attacker/preload.js" };
    const fixedPreload = resolvePreviewGuestPreloadPath("C:/mcode/dist/main");

    hardenPreviewWebviewAttachment(preferences, params, fixedPreload);

    expect(preferences).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: true,
      preload: fixedPreload,
    });
    expect(params).toEqual({
      partition: "persist:mcode-preview",
      preload: fixedPreload,
    });
    expect(fixedPreload.replaceAll("\\", "/")).toBe(
      "C:/mcode/dist/preload/preview-guest-preload.cjs",
    );
  });

  it("resolves a workspace Preview URL and rejects traversal", async () => {
    const workspacePath = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-preview-feature-"));
    try {
      await NodeFSPromises.mkdir(NodePath.join(workspacePath, "sub"));
      await NodeFSPromises.writeFile(NodePath.join(workspacePath, "sub", "page.html"), "<h1>Page</h1>");

      await expect(
        resolveMcodeWorkspacePreviewUrl("mcode-workspace:///sub/page.html", workspacePath),
      ).resolves.toEqual({
        ok: true,
        url: NodeURL.pathToFileURL(NodePath.join(workspacePath, "sub", "page.html")).href,
      });
      await expect(
        resolveMcodeWorkspacePreviewUrl("mcode-workspace:///%2e%2e%2Fescape.html", workspacePath),
      ).resolves.toEqual({ ok: false, error: "invalid-url" });
    } finally {
      await NodeFSPromises.rm(workspacePath, { recursive: true, force: true });
    }
  });
});
