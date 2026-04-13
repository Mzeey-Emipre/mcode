import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted to avoid reference-before-initialization issues)
// ---------------------------------------------------------------------------

const refs = vi.hoisted(() => {
  let exitCallback: ((code: number | null) => void) | null = null;
  let isPackaged = false;

  const mockChildProcess = {
    on: vi.fn((event: string, cb: (code: number | null) => void) => {
      if (event === "exit") exitCallback = cb;
    }),
    unref: vi.fn(),
    pid: 12345,
  };

  return {
    mockChildProcess,
    getExitCallback: () => exitCallback,
    resetExitCallback: () => {
      exitCallback = null;
    },
    setIsPackaged: (v: boolean) => {
      isPackaged = v;
    },
    getIsPackaged: () => isPackaged,
  };
});

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return refs.getIsPackaged();
    },
    getPath: vi.fn().mockReturnValue("/tmp"),
    getVersion: vi.fn().mockReturnValue("0.1.0-test"),
  },
}));

vi.mock("child_process", () => ({
  spawn: vi.fn().mockReturnValue(refs.mockChildProcess),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
}));

vi.mock("net", () => ({
  createServer: vi.fn().mockReturnValue({
    once: vi.fn(),
    listen: vi.fn((_port: number, cb: () => void) => cb()),
    address: vi.fn().mockReturnValue({ port: 19600 }),
    close: vi.fn((cb: () => void) => cb()),
  }),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default lock file JSON returned after waitForReady. */
const LOCK_FILE_JSON = JSON.stringify({
  port: 19600,
  authToken: "test-auth-token",
  pid: 12345,
  startedAt: "2026-01-01T00:00:00.000Z",
  version: "0.1.0-test",
  ipcPath: "",
});

/**
 * Build the standard readFileSync mock sequence for a normal start():
 *  1. tryExistingServer: lock file -> ENOENT
 *  2. readServerHeapMb: settings.json -> ENOENT (use default heap)
 *  3. readAuthTokenFromLock: lock file -> return LOCK_FILE_JSON
 */
function setupDefaultReadFileMock() {
  const enoent = () => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
  vi.mocked(readFileSync)
    .mockImplementationOnce(enoent) // tryExistingServer lock read
    .mockImplementationOnce(enoent) // readServerHeapMb settings.json read
    .mockImplementationOnce(() => LOCK_FILE_JSON); // readAuthTokenFromLock
}

// Mock fetch for health check
const originalFetch = globalThis.fetch;

import { ServerManager } from "../server-manager.js";
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";

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

    // Mock fetch: first call returns healthy (waitForReady); subsequent calls
    // also return ok so tryExistingServer health probes work too.
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    setupDefaultReadFileMock();
  });

  afterEach(() => {
    manager.shutdown();
    globalThis.fetch = originalFetch;
    delete process.env.MCODE_SERVER_HEAP_MB;
    refs.setIsPackaged(false);
    delete (process as Record<string, unknown>).resourcesPath;
    vi.mocked(existsSync).mockReturnValue(false);
  });

  // -----------------------------------------------------------------------
  // Basic spawn and property tests
  // -----------------------------------------------------------------------

  it("starts the server by spawning a detached child process", async () => {
    const result = await manager.start();

    expect(spawn).toHaveBeenCalledOnce();
    const spawnCall = vi.mocked(spawn).mock.calls[0];
    // First arg is process.execPath
    expect(spawnCall[0]).toBe(process.execPath);
    // Options include detached: true and stdio: "ignore"
    const opts = spawnCall[2] as Record<string, unknown>;
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(result.port).toBe(19600);
    expect(result.authToken).toBe("test-auth-token");
  });

  it("calls unref() on the child process after spawning", async () => {
    await manager.start();
    expect(refs.mockChildProcess.unref).toHaveBeenCalledOnce();
  });

  it("exposes port and authToken as properties", async () => {
    await manager.start();

    expect(manager.port).toBe(19600);
    expect(manager.authToken).toBe("test-auth-token");
  });

  // -----------------------------------------------------------------------
  // Environment variables passed to spawn
  // -----------------------------------------------------------------------

  it("passes correct environment to spawn", async () => {
    // Ensure MCODE_AUTH_TOKEN is not present in the test environment so the
    // assertion below reflects what ServerManager sets, not a leaked env var.
    const savedToken = process.env.MCODE_AUTH_TOKEN;
    delete process.env.MCODE_AUTH_TOKEN;

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const opts = spawnCall[2] as Record<string, unknown>;
    const env = opts.env as Record<string, string>;
    expect(env.MCODE_PORT).toBe("19600");
    expect(env.MCODE_MODE).toBe("desktop");
    // Auth token is NOT set by ServerManager - it is read from the lock file
    expect(env.MCODE_AUTH_TOKEN).toBeUndefined();

    if (savedToken !== undefined) process.env.MCODE_AUTH_TOKEN = savedToken;
  });

  // -----------------------------------------------------------------------
  // V8 flags in args array
  // -----------------------------------------------------------------------

  it("passes V8 flags in the args array with default heap (96 MB)", async () => {
    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--max-old-space-size=96");
    expect(args).toContain("--max-semi-space-size=2");
    expect(args).toContain("--expose-gc");
  });

  // -----------------------------------------------------------------------
  // Shutdown behaviour
  // -----------------------------------------------------------------------

  it("shutdown nulls the serverProcess reference without killing the process", async () => {
    await manager.start();

    manager.shutdown();

    // The child process mock has no kill() method - verifying it was not
    // called would throw. Instead confirm the manager no longer holds the ref
    // by checking that a subsequent shutdown is a no-op (no throw).
    expect(() => manager.shutdown()).not.toThrow();
  });

  it("shutdown is a no-op when no server is running", () => {
    expect(() => manager.shutdown()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Exit callback / onUnexpectedExit
  // -----------------------------------------------------------------------

  it("handles process exit by clearing serverProcess reference", async () => {
    await manager.start();

    const exitCb = refs.getExitCallback();
    expect(exitCb).toBeDefined();
    exitCb!(0);

    // After exit, shutdown should be a no-op (reference already cleared)
    expect(() => manager.shutdown()).not.toThrow();
  });

  it("calls onUnexpectedExit when the process exits without shutdown", async () => {
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

  // -----------------------------------------------------------------------
  // Heap size configuration
  // -----------------------------------------------------------------------

  it("reads heapMb from settings.json", async () => {
    // Re-sequence readFileSync: lock ENOENT, then settings.json with custom heap,
    // then lock file for readAuthTokenFromLock.
    vi.mocked(readFileSync).mockReset();
    const enoent = () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    vi.mocked(readFileSync)
      .mockImplementationOnce(enoent) // tryExistingServer
      .mockReturnValueOnce(JSON.stringify({ server: { memory: { heapMb: 1024 } } })) // settings.json
      .mockReturnValueOnce(LOCK_FILE_JSON); // readAuthTokenFromLock

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--max-old-space-size=1024");
  });

  it("uses MCODE_SERVER_HEAP_MB env var over settings.json", async () => {
    process.env.MCODE_SERVER_HEAP_MB = "2048";

    // When env var is set, settings.json is never read. Re-sequence accordingly:
    // tryExistingServer lock ENOENT, then readAuthTokenFromLock.
    vi.mocked(readFileSync).mockReset();
    const enoent = () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    vi.mocked(readFileSync)
      .mockImplementationOnce(enoent) // tryExistingServer
      .mockReturnValueOnce(LOCK_FILE_JSON); // readAuthTokenFromLock

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--max-old-space-size=2048");
  });

  // -----------------------------------------------------------------------
  // Packaged vs dev entry path branching
  // -----------------------------------------------------------------------

  it("spawns the dev entry.mjs when app.isPackaged is false", async () => {
    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args.join(" ")).toContain("entry.mjs");
  });

  it("spawns the bundled server.cjs when app.isPackaged is true", async () => {
    refs.setIsPackaged(true);
    Object.defineProperty(process, "resourcesPath", {
      value: "/test/resources",
      configurable: true,
      writable: true,
    });

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args.join(" ")).toContain("server.cjs");
  });

  it("passes BETTER_SQLITE3_BINDING env var when packaged and binding exists", async () => {
    refs.setIsPackaged(true);
    Object.defineProperty(process, "resourcesPath", {
      value: "/test/resources",
      configurable: true,
      writable: true,
    });
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).includes("better_sqlite3.electron.node"),
    );

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const opts = spawnCall[2] as Record<string, unknown>;
    const env = opts.env as Record<string, string>;
    expect(env.BETTER_SQLITE3_BINDING).toContain("better_sqlite3.electron.node");
  });

  // -----------------------------------------------------------------------
  // forceReplace
  // -----------------------------------------------------------------------

  it("forceReplace sends POST /shutdown to the running server", async () => {
    // Lock file exists with a running server
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);

    // process.kill returns normally (server is alive) then throws (server dead)
    const killSpy = vi.spyOn(process, "kill").mockImplementationOnce(() => true as never); // alive check
    // Second kill(0) throws to break poll loop
    killSpy.mockImplementationOnce(() => {
      throw new Error("ESRCH");
    });

    await manager.forceReplace();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19600/shutdown",
      expect.objectContaining({ method: "POST" }),
    );

    killSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Reuse existing server from lock file
  // -----------------------------------------------------------------------

  it("reuses existing server when lock file is present and health check passes", async () => {
    // tryExistingServer: lock file returns valid JSON and health check passes
    vi.mocked(readFileSync).mockReset().mockReturnValueOnce(LOCK_FILE_JSON);
    // fetch already returns ok from beforeEach

    // Allow PID liveness check to succeed (process.kill(pid, 0) should not throw)
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);

    const result = await manager.start();

    killSpy.mockRestore();

    // spawn should NOT have been called - we reused the existing server
    expect(spawn).not.toHaveBeenCalled();
    expect(result.port).toBe(19600);
    expect(result.authToken).toBe("test-auth-token");
    expect(manager.reusedExisting).toBe(true);
  });
});
