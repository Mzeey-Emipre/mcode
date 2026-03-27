import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted to avoid reference-before-initialization issues)
// ---------------------------------------------------------------------------

const refs = vi.hoisted(() => {
  let exitCallback: ((code: number | null) => void) | null = null;

  const mockChildProcess = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (code: number | null) => void) => {
      if (event === "exit") exitCallback = cb;
    }),
    once: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  };

  return {
    mockChildProcess,
    getExitCallback: () => exitCallback,
    resetExitCallback: () => { exitCallback = null; },
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
    getVersion: vi.fn().mockReturnValue("0.1.0-test"),
  },
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
}));

vi.mock("child_process", () => ({
  fork: vi.fn().mockReturnValue(refs.mockChildProcess),
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
import { fork } from "child_process";

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

  it("starts the server by forking a child process", async () => {
    const result = await manager.start();

    expect(fork).toHaveBeenCalledOnce();
    expect(result.port).toBe(19400);
    expect(result.authToken).toBe("mock-auth-token");
  });

  it("exposes port and authToken as properties", async () => {
    await manager.start();

    expect(manager.port).toBe(19400);
    expect(manager.authToken).toBe("mock-auth-token");
  });

  it("passes correct environment to the forked process", async () => {
    await manager.start();

    const forkCall = vi.mocked(fork).mock.calls[0];
    const env = forkCall[2]?.env as Record<string, string>;
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.MCODE_PORT).toBe("19400");
    expect(env.MCODE_AUTH_TOKEN).toBe("mock-auth-token");
    expect(env.MCODE_MODE).toBe("desktop");
  });

  it("shutdown sends SIGTERM to the child process", async () => {
    await manager.start();

    manager.shutdown();

    expect(refs.mockChildProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("shutdown is a no-op when no server is running", () => {
    expect(() => manager.shutdown()).not.toThrow();
  });

  it("handles child process exit by clearing serverProcess reference", async () => {
    await manager.start();

    // Simulate the child process exiting
    const exitCb = refs.getExitCallback();
    expect(exitCb).toBeDefined();
    exitCb!(0);

    // After exit, shutdown should be a no-op (no kill call)
    refs.mockChildProcess.kill.mockClear();
    manager.shutdown();
    expect(refs.mockChildProcess.kill).not.toHaveBeenCalled();
  });
});
