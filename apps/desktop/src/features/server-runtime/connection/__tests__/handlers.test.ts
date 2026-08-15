import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installServerAuthCookie } from "../auth-cookie.js";
import { registerServerConnectionHandlers } from "../handlers.js";
import { ServerRuntime } from "../../index.js";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

type IpcEvent = { sender: unknown };
type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

describe("registerServerConnectionHandlers", () => {
  let handlers: Map<string, Handler>;
  let mainWebContents: object;
  let otherWebContents: object;
  let ensureServerRunning: ReturnType<typeof vi.fn>;
  let reportBusy: ReturnType<typeof vi.fn>;
  let getConnection: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = new Map();
    mainWebContents = {};
    otherWebContents = {};
    ensureServerRunning = vi.fn().mockResolvedValue(undefined);
    reportBusy = vi.fn();
    getConnection = vi.fn().mockReturnValue({
      port: 43127,
      authToken: "token-with-unicode-✓",
      ipcPath: "\\\\.\\pipe\\mcode-✓",
    });

    registerServerConnectionHandlers({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler as Handler),
      },
      getMainWebContents: () => mainWebContents,
      getConnection,
      ensureServerRunning,
      reportBusy,
    });
  });

  it("registers the exact server connection channels", () => {
    expect([...handlers.keys()]).toEqual([
      "get-server-url",
      "ensure-server-running",
      "set-server-busy",
    ]);
  });

  it("returns the authenticated URL and IPC path only to the main renderer", () => {
    const getServerUrl = handlers.get("get-server-url");
    if (!getServerUrl) throw new Error("get-server-url handler was not registered");

    expect(getServerUrl({ sender: mainWebContents })).toEqual({
      url: "ws://localhost:43127?token=token-with-unicode-✓",
      ipcPath: "\\\\.\\pipe\\mcode-✓",
    });
    expect(getConnection).toHaveBeenCalledOnce();

    getConnection.mockClear();
    expect(() => getServerUrl({ sender: otherWebContents })).toThrow();
    expect(getConnection).not.toHaveBeenCalled();
  });

  it("delegates ensure-server-running after authorization", async () => {
    const ensure = handlers.get("ensure-server-running");
    if (!ensure) throw new Error("ensure-server-running handler was not registered");

    await expect(ensure({ sender: mainWebContents })).resolves.toBeUndefined();

    expect(ensureServerRunning).toHaveBeenCalledOnce();
  });

  it("delegates set-server-busy with the sender and boolean", () => {
    const setBusy = handlers.get("set-server-busy");
    if (!setBusy) throw new Error("set-server-busy handler was not registered");

    setBusy({ sender: mainWebContents }, true);

    expect(reportBusy).toHaveBeenCalledWith(mainWebContents, true);
  });

  it("rejects unauthorized ensure and busy requests", async () => {
    const ensure = handlers.get("ensure-server-running");
    const setBusy = handlers.get("set-server-busy");
    if (!ensure || !setBusy) throw new Error("server connection handlers were not registered");

    await expect(ensure({ sender: otherWebContents })).rejects.toThrow();
    expect(() => setBusy({ sender: otherWebContents }, true)).toThrow();
    expect(ensureServerRunning).not.toHaveBeenCalled();
    expect(reportBusy).not.toHaveBeenCalled();
  });

  it("rejects non-boolean busy payloads from the authorized renderer", () => {
    const setBusy = handlers.get("set-server-busy");
    if (!setBusy) throw new Error("set-server-busy handler was not registered");

    expect(() => setBusy({ sender: mainWebContents }, "busy")).toThrow();
    expect(reportBusy).not.toHaveBeenCalled();
  });
});

describe("installServerAuthCookie", () => {
  it("sets only the local strict auth cookie fields", async () => {
    const set = vi.fn().mockResolvedValue(undefined);

    await installServerAuthCookie(
      { set },
      { port: 43127, authToken: "token-with-unicode-✓" },
    );

    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      url: "http://localhost:43127",
      name: "mcode-auth",
      value: "token-with-unicode-✓",
      httpOnly: true,
      sameSite: "strict",
    });
  });
});

describe("ServerRuntime entry point", () => {
  type RuntimeManagerAdapter = {
    port: number;
    authToken: string;
    ipcPath: string;
    onUnexpectedExit: ((code: number | null) => void) | null;
    start: ReturnType<typeof vi.fn>;
    isHealthy: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
    forceReplace: ReturnType<typeof vi.fn>;
  };

  let manager: RuntimeManagerAdapter;
  let window: {
    isMinimized: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: {
      id: number;
      isDestroyed: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
    };
    once: ReturnType<typeof vi.fn>;
  };
  let handlers: Map<string, Handler>;
  let resumeListener: (() => void) | undefined;
  let cookieSet: ReturnType<typeof vi.fn>;
  let relayStarter: ReturnType<typeof vi.fn>;
  let powerSaveBlocker: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  let runtime: ServerRuntime;

  beforeEach(() => {
    manager = {
      port: 43210,
      authToken: "entry-token",
      ipcPath: "entry-ipc-path",
      onUnexpectedExit: null,
      start: vi.fn().mockResolvedValue({
        port: 43210,
        authToken: "entry-token",
      }),
      isHealthy: vi.fn().mockResolvedValue(true),
      restart: vi.fn().mockResolvedValue(undefined),
      forceReplace: vi.fn().mockResolvedValue(undefined),
    };
    window = {
      isMinimized: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: {
        id: 17,
        isDestroyed: vi.fn().mockReturnValue(false),
        send: vi.fn(),
        once: vi.fn(),
      },
      once: vi.fn(),
    };
    handlers = new Map();
    resumeListener = undefined;
    cookieSet = vi.fn().mockResolvedValue(undefined);
    const cleanupRelay = vi.fn();
    relayStarter = vi.fn().mockReturnValue(cleanupRelay);
    powerSaveBlocker = {
      start: vi.fn().mockReturnValue(23),
      stop: vi.fn(),
    };

    runtime = new ServerRuntime({
      manager,
      relayStarter,
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler as Handler),
      },
      getMainWindow: () => window,
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
      },
      app: { quit: vi.fn() },
      notification: {
        isSupported: vi.fn().mockReturnValue(false),
        create: vi.fn(),
      },
      powerMonitor: {
        on: (_event, listener) => {
          resumeListener = listener;
        },
      },
      powerSaveBlocker,
      getCookieStore: () => ({ set: cookieSet }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts through the manager and returns its port", async () => {
    await expect(runtime.start()).resolves.toBe(43210);
    expect(manager.start).toHaveBeenCalledOnce();
  });

  it("routes resume and unexpected exit through the real recovery policies", async () => {
    vi.useFakeTimers();
    runtime.registerLifecycle();
    expect(resumeListener).toBeDefined();
    expect(manager.onUnexpectedExit).toEqual(expect.any(Function));

    manager.isHealthy.mockResolvedValue(false);
    resumeListener?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.restart).toHaveBeenCalledOnce();

    manager.restart.mockClear();
    manager.onUnexpectedExit?.(17);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(manager.restart).toHaveBeenCalledOnce();
  });

  it("registers authenticated handlers and routes busy state through power control", () => {
    runtime.registerConnectionHandlers();

    const getServerUrl = handlers.get("get-server-url");
    const setBusy = handlers.get("set-server-busy");
    if (!getServerUrl || !setBusy) {
      throw new Error("server connection handlers were not registered");
    }

    expect(getServerUrl({ sender: window.webContents })).toEqual({
      url: "ws://localhost:43210?token=entry-token",
      ipcPath: "entry-ipc-path",
    });

    setBusy({ sender: window.webContents }, true);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith(
      "prevent-app-suspension",
    );

    expect(() => setBusy({ sender: window.webContents }, "busy")).toThrow();
    expect(powerSaveBlocker.start).toHaveBeenCalledOnce();
  });

  it("installs the current connection cookie and attaches relay cleanup", async () => {
    await runtime.installAuthCookie();
    expect(cookieSet).toHaveBeenCalledWith({
      url: "http://localhost:43210",
      name: "mcode-auth",
      value: "entry-token",
      httpOnly: true,
      sameSite: "strict",
    });

    runtime.attachWindow(window);
    const cleanupRelay = relayStarter.mock.results[0]?.value;
    expect(relayStarter).toHaveBeenCalledWith("entry-ipc-path", window);
    expect(window.once).toHaveBeenCalledWith("closed", cleanupRelay);
  });

  it("does not attach an empty IPC path", () => {
    manager.ipcPath = "";

    runtime.attachWindow(window);

    expect(relayStarter).not.toHaveBeenCalled();
    expect(window.once).not.toHaveBeenCalled();
  });

  it("delegates force replacement once", async () => {
    await runtime.forceReplace();

    expect(manager.forceReplace).toHaveBeenCalledOnce();
  });
});
