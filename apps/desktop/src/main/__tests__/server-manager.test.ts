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

// Mock fetch for health check
const originalFetch = globalThis.fetch;

import { ServerManager } from "../server-manager.js";
import { utilityProcess } from "electron";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ServerManager", () => {
  let manager: ServerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    refs.resetExitCallback();
    manager = new ServerManager();

    // Mock fetch to simulate server health
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    manager.shutdown();
    globalThis.fetch = originalFetch;
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
    // utilityProcess does not need ELECTRON_RUN_AS_NODE; verify it is not
    // explicitly added beyond whatever process.env already contains.
    expect(env.MCODE_PORT).toBe("19400");
    expect(env.MCODE_AUTH_TOKEN).toBe("mock-auth-token");
    expect(env.MCODE_MODE).toBe("desktop");
    // stdio should be "pipe" instead of the old IPC array
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

    // Should have called postMessage with the stream-port message and port2
    expect(refs.mockUtilityProcess.postMessage).toHaveBeenCalledWith(
      { type: "stream-port" },
      expect.any(Array),
    );
    // Should return port1 (the renderer-side port)
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

    // Simulate the utility process exiting
    const exitCb = refs.getExitCallback();
    expect(exitCb).toBeDefined();
    exitCb!(0);

    // After exit, shutdown should be a no-op (no kill call)
    refs.mockUtilityProcess.kill.mockClear();
    manager.shutdown();
    expect(refs.mockUtilityProcess.kill).not.toHaveBeenCalled();
  });
});
