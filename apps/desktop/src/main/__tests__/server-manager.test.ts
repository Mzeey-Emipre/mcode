import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted to avoid reference-before-initialization issues)
// ---------------------------------------------------------------------------

const refs = vi.hoisted(() => {
  let exitCallback: ((code: number | null) => void) | null = null;

  const mockUtilityProcess = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (code: number | null) => void) => {
      if (event === "exit") exitCallback = cb;
    }),
    once: vi.fn(),
    kill: vi.fn(),
    postMessage: vi.fn(),
    pid: 12345,
  };

  return {
    mockUtilityProcess,
    getExitCallback: () => exitCallback,
    resetExitCallback: () => { exitCallback = null; },
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
    getVersion: vi.fn().mockReturnValue("0.1.0-test"),
  },
  utilityProcess: {
    fork: vi.fn().mockReturnValue(refs.mockUtilityProcess),
  },
  MessageChannelMain: class {
    port1 = { postMessage: vi.fn(), close: vi.fn() };
    port2 = { postMessage: vi.fn(), close: vi.fn() };
  },
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
}));

vi.mock("net", () => ({
  createServer: vi.fn().mockReturnValue({
    once: vi.fn(),
    listen: vi.fn((_port: number, cb: () => void) => cb()),
    address: vi.fn().mockReturnValue({ port: 19400 }),
    close: vi.fn((cb: () => void) => cb()),
  }),
}));

vi.mock("crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("mock-auth-token"),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
}));

// Mock fetch for health check
const originalFetch = globalThis.fetch;

import { ServerManager } from "../server-manager.js";
import { utilityProcess } from "electron";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ServerManager", () => {
  let manager: ServerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    refs.resetExitCallback();
    manager = new ServerManager();

    // Reset readFileSync fully (clears queued once-returns) then restore
    // the default throwing implementation so it simulates a missing file.
    vi.mocked(readFileSync).mockReset().mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    // Mock fetch to simulate server health
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    manager.shutdown();
    globalThis.fetch = originalFetch;
    delete process.env.MCODE_SERVER_HEAP_MB;
  });

  it("starts the server by forking a utility process", async () => {
    const result = await manager.start();

    expect(utilityProcess.fork).toHaveBeenCalledOnce();
    expect(result.port).toBe(19400);
    expect(result.authToken).toBe("mock-auth-token");
  });

  it("exposes port and authToken as properties", async () => {
    await manager.start();

    expect(manager.port).toBe(19400);
    expect(manager.authToken).toBe("mock-auth-token");
  });

  it("passes correct environment to the utility process", async () => {
    await manager.start();

    const forkCall = vi.mocked(utilityProcess.fork).mock.calls[0];
    const opts = forkCall[2] as Record<string, unknown>;
    const env = opts.env as Record<string, string>;
    expect(env.MCODE_PORT).toBe("19400");
    expect(env.MCODE_AUTH_TOKEN).toBe("mock-auth-token");
    expect(env.MCODE_MODE).toBe("desktop");
    expect(opts.stdio).toBe("pipe");
  });

  it("shutdown kills the utility process", async () => {
    await manager.start();

    manager.shutdown();

    expect(refs.mockUtilityProcess.kill).toHaveBeenCalledWith();
  });

  it("shutdown is a no-op when no server is running", () => {
    expect(() => manager.shutdown()).not.toThrow();
  });

  it("createStreamPort creates a MessageChannelMain pair and posts to server", async () => {
    await manager.start();

    const port = manager.createStreamPort();

    expect(refs.mockUtilityProcess.postMessage).toHaveBeenCalledWith(
      { type: "stream-port" },
      expect.any(Array),
    );
    expect(port).toBeDefined();
    expect(port).toHaveProperty("postMessage");
  });

  it("createStreamPort throws when server is not running", () => {
    expect(() => manager.createStreamPort()).toThrow(
      "Cannot create stream port: server not running",
    );
  });

  it("handles utility process exit by clearing serverProcess reference", async () => {
    await manager.start();

    const exitCb = refs.getExitCallback();
    expect(exitCb).toBeDefined();
    exitCb!(0);

    refs.mockUtilityProcess.kill.mockClear();
    manager.shutdown();
    expect(refs.mockUtilityProcess.kill).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // V8 heap flags in execArgv
  // -----------------------------------------------------------------------

  it("passes V8 heap flags in execArgv with default 96", async () => {
    await manager.start();
    const forkCall = vi.mocked(utilityProcess.fork).mock.calls[0];
    const execArgv = forkCall[2]?.execArgv as string[];
    expect(execArgv).toContain("--max-old-space-size=96");
    expect(execArgv).toContain("--max-semi-space-size=2");
    expect(execArgv).toContain("--expose-gc");
    // --import tsx is NOT in execArgv; handled by entry.mjs bootstrap
    expect(execArgv).not.toContain("--import");
  });

  it("reads heapMb from settings.json when file exists", async () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ server: { memory: { heapMb: 1024 } } }),
    );
    await manager.start();
    const forkCall = vi.mocked(utilityProcess.fork).mock.calls[0];
    const execArgv = forkCall[2]?.execArgv as string[];
    expect(execArgv).toContain("--max-old-space-size=1024");
  });

  it("uses MCODE_SERVER_HEAP_MB env var over settings.json", async () => {
    process.env.MCODE_SERVER_HEAP_MB = "2048";
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ server: { memory: { heapMb: 1024 } } }),
    );
    await manager.start();
    const forkCall = vi.mocked(utilityProcess.fork).mock.calls[0];
    const execArgv = forkCall[2]?.execArgv as string[];
    expect(execArgv).toContain("--max-old-space-size=2048");
  });

  it("falls back to default when settings.json has invalid heapMb", async () => {
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ server: { memory: { heapMb: 10 } } }),
    );
    await manager.start();
    const forkCall = vi.mocked(utilityProcess.fork).mock.calls[0];
    const execArgv = forkCall[2]?.execArgv as string[];
    expect(execArgv).toContain("--max-old-space-size=96");
  });

  // -----------------------------------------------------------------------
  // onUnexpectedExit callback
  // -----------------------------------------------------------------------

  it("calls onUnexpectedExit when server exits without shutdown", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    const exitCb = refs.getExitCallback();
    exitCb!(1);
    expect(onCrash).toHaveBeenCalledWith(1);
  });

  it("does not call onUnexpectedExit after shutdown", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    manager.shutdown();
    const exitCb = refs.getExitCallback();
    exitCb!(0);
    expect(onCrash).not.toHaveBeenCalled();
  });
});
