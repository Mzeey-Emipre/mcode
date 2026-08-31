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
    exitCode: null,
    signalCode: null,
  };

  // Shared existsSync spy used by "fs"/"node:fs" mocks.
  const existsSyncSpy = vi.fn((path) =>
    String(path).includes("better_sqlite3"),
  );

  // Spy for resolveServerBinary — lets tests override the resolved binary path
  // directly without depending on node:fs mock aliasing behaviour.
  const resolveServerBinarySpy = vi.fn(
    (input: { isPackaged: boolean; execPath: string }) => input.execPath,
  );

  return {
    mockChildProcess,
    existsSyncSpy,
    resolveServerBinarySpy,
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

// Mock the binary resolver so tests can control the spawn target directly
// without depending on node:fs aliasing in the test environment.
vi.mock("../binary-resolver.js", () => ({
  resolveServerBinary: refs.resolveServerBinarySpy,
}));

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
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn().mockReturnValue("/tmp/mcode"),
}));

vi.mock("net", () => ({
  createServer: vi.fn().mockReturnValue({
    once: vi.fn(),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
    address: vi.fn().mockReturnValue({ port: 19600 }),
    close: vi.fn((cb: () => void) => cb()),
  }),
}));

// Single mock for both "fs" and "node:fs" (Vitest normalises them to the same
// module). binary-resolver imports existsSync from "node:fs", while manager
// imports from "fs"; the shared existsSyncSpy covers both.
vi.mock("node:fs", () => ({
  existsSync: refs.existsSyncSpy,
  readFileSync: vi.fn(() => {
    const err = new Error(
      "ENOENT: no such file or directory",
    ) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }),
  renameSync: vi.fn(),
  linkSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  rmdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  // createWriteStream is used in non-dev mode to route stderr to a log file.
  // Return a minimal writable-stream stub so callers like child.stderr.pipe() work.
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(() => {
    const err = new Error(
      "ENOENT: no such file or directory",
    ) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    return Promise.reject(err);
  }),
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
const TEST_PLATFORM: NodeJS.Platform = "linux";

/** Create lock data for a specific spawned child process. */
function lockFileJsonForPid(pid: number): string {
  return JSON.stringify({ ...JSON.parse(LOCK_FILE_JSON), pid });
}

/** Update the platform selected for this manager's explicit runtime boundary. */
function setManagerPlatform(manager: ServerManager, platform: NodeJS.Platform): void {
  Object.defineProperty(manager, "platform", { value: platform });
}

/**
 * Build the standard readFileSync mock sequence for a normal start():
 *  1. tryExistingServer: lock file -> ENOENT
 *  2. readServerHeapMb: settings.json -> ENOENT (use default heap)
 *  3. readAuthTokenFromLock: lock file -> return LOCK_FILE_JSON
 */
function setupDefaultReadFileMock() {
  const enoent = () => {
    const err = new Error(
      "ENOENT: no such file or directory",
    ) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
  vi.mocked(readFileSync)
    .mockImplementationOnce(enoent) // tryExistingServer lock read
    .mockImplementationOnce(enoent); // readServerHeapMb settings.json read
  vi.mocked(readFile).mockResolvedValueOnce(LOCK_FILE_JSON as never); // readAuthTokenFromLock (async)
}

// Mock fetch for health check
const originalFetch = globalThis.fetch;

import { ServerManager } from "../manager.js";
import { execFileSync, spawn } from "child_process";
import {
  existsSync,
  readFileSync,
  createWriteStream,
  rmdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { createServer } from "net";
import {
  SERVER_HEAP_DEFAULT_MB,
  SERVER_HEAP_LEGACY_DEFAULT_MB,
} from "@mcode/contracts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ServerManager", () => {
  let manager: ServerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReset();
    refs.resetExitCallback();
    manager = new ServerManager();

    // Reset readFileSync fully (clears queued once-returns) then restore
    // the default throwing implementation so it simulates a missing file.
    vi.mocked(readFileSync)
      .mockReset()
      .mockImplementation(() => {
        const err = new Error(
          "ENOENT: no such file or directory",
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });

    // Reset async readFile (fs/promises) used by readAuthTokenFromLock
    vi.mocked(readFile).mockReset();

    // Mock fetch: first call returns healthy (waitForReady); subsequent calls
    // also return ok so tryExistingServer health probes work too.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    vi.mocked(existsSync).mockImplementation((path) =>
      String(path).includes("better_sqlite3"),
    );

    setupDefaultReadFileMock();
  });

  afterEach(() => {
    manager.shutdown();
    globalThis.fetch = originalFetch;
    delete process.env.MCODE_SERVER_HEAP_MB;
    refs.setIsPackaged(false);
    delete (process as Record<string, unknown>).resourcesPath;
    vi.mocked(existsSync).mockImplementation((path) =>
      String(path).includes("better_sqlite3"),
    );
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
    // Options include detached: true; in non-dev mode stderr is piped to a log file
    const opts = spawnCall[2] as Record<string, unknown>;
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "ignore", "pipe"]);
    expect(result.port).toBe(19600);
    expect(result.authToken).toBe("test-auth-token");
    const portProbe = vi.mocked(createServer).mock.results[0]?.value;
    expect(portProbe.listen).toHaveBeenCalledWith(
      19600,
      "127.0.0.1",
      expect.any(Function),
    );
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
    expect(env.MCODE_SINGLE_INSTANCE).toBe("false");
    // Auth token is NOT set by ServerManager - it is read from the lock file
    expect(env.MCODE_AUTH_TOKEN).toBeUndefined();

    if (savedToken !== undefined) process.env.MCODE_AUTH_TOKEN = savedToken;
  });

  // -----------------------------------------------------------------------
  // V8 flags in args array
  // -----------------------------------------------------------------------

  it("passes V8 flags in the args array with default heap", async () => {
    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain(`--max-old-space-size=${SERVER_HEAP_DEFAULT_MB}`);
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

  it("ends the packaged stderr stream after a normal server exit", async () => {
    const stderrStream = { write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    vi.mocked(createWriteStream).mockReturnValueOnce(stderrStream as never);

    await manager.start();
    refs.getExitCallback()!(0);

    expect(stderrStream.end).toHaveBeenCalledOnce();
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

  it("suppresses the expected exit when forceReplace stops the current child", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    const exitCallback = refs.getExitCallback();
    vi.spyOn(manager, "stopServerHeldByLock").mockImplementation(async () => {
      exitCallback?.(0);
    });

    await manager.forceReplace();

    expect(onCrash).not.toHaveBeenCalled();
  });

  it("suppresses the expected exit when an ordinary restart replaces the child", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    const exitCallback = refs.getExitCallback();
    vi.spyOn(manager, "stopServerHeldByLock").mockImplementation(async () => {
      exitCallback?.(0);
    });
    vi.spyOn(manager, "start").mockResolvedValue({
      port: 19600,
      authToken: "replacement-token",
    });
    vi.useFakeTimers();

    try {
      const restart = manager.restart();
      await vi.advanceTimersByTimeAsync(500);
      await restart;
    } finally {
      vi.useRealTimers();
    }

    expect(onCrash).not.toHaveBeenCalled();
  });

  it("suppresses the expected exit when a version mismatch replaces the child", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    const exitCallback = refs.getExitCallback();
    vi.mocked(readFileSync)
      .mockReset()
      .mockReturnValue(
        JSON.stringify({ ...JSON.parse(LOCK_FILE_JSON), version: "0.0.0" }),
      );
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(LOCK_FILE_JSON as never);
    vi.spyOn(manager, "stopServerHeldByLock").mockImplementation(async () => {
      exitCallback?.(0);
    });

    await manager.start();

    expect(onCrash).not.toHaveBeenCalled();
  });

  it("clears a version-replacement marker when the replacement fails to spawn", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    const exitCallback = refs.getExitCallback();
    vi.mocked(readFileSync)
      .mockReset()
      .mockReturnValue(
        JSON.stringify({ ...JSON.parse(LOCK_FILE_JSON), version: "0.0.0" }),
      );
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("replacement spawn failed");
    });
    vi.spyOn(manager, "stopServerHeldByLock").mockResolvedValue();

    await expect(manager.start()).rejects.toThrow("replacement spawn failed");

    exitCallback?.(1);
    expect(onCrash).toHaveBeenCalledWith(1);
  });

  it("clears an ordinary restart marker when replacement startup fails", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    const exitCallback = refs.getExitCallback();
    vi.spyOn(manager, "stopServerHeldByLock").mockResolvedValue();
    vi.spyOn(manager, "start").mockRejectedValue(new Error("start failed"));
    vi.useFakeTimers();

    try {
      const restart = manager.restart();
      const rejectedRestart = expect(restart).rejects.toThrow("start failed");
      await vi.advanceTimersByTimeAsync(500);
      await rejectedRestart;
    } finally {
      vi.useRealTimers();
    }

    exitCallback?.(1);
    expect(onCrash).toHaveBeenCalledWith(1);
  });

  it("suppresses only the planned old child during a planned restart", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    const oldChild = {
      on: vi.fn((event: string, callback: (code: number | null) => void) => {
        if (event === "exit") oldChild.exit = callback;
      }),
      unref: vi.fn(),
      pid: 54321,
      exitCode: null,
      signalCode: null,
      exit: undefined as ((code: number | null) => void) | undefined,
    };
    const newChild = {
      on: vi.fn((event: string, callback: (code: number | null) => void) => {
        if (event === "exit") newChild.exit = callback;
      }),
      unref: vi.fn(),
      pid: 54322,
      exitCode: null,
      signalCode: null,
      exit: undefined as ((code: number | null) => void) | undefined,
    };
    vi.mocked(spawn)
      .mockImplementationOnce(() => oldChild as never)
      .mockImplementationOnce(() => newChild as never);
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(lockFileJsonForPid(54321) as never);
    await manager.start();

    const restart = vi
      .spyOn(manager, "restart")
      .mockImplementation(async () => {
        oldChild.exit?.(0);
        vi.mocked(readFile)
          .mockReset()
          .mockResolvedValueOnce(lockFileJsonForPid(54322) as never);
        await manager.start();
        newChild.exit?.(1);
      });

    await manager.restartPlanned();

    expect(restart).toHaveBeenCalledOnce();
    expect(onCrash).toHaveBeenCalledOnce();
    expect(onCrash).toHaveBeenCalledWith(1);
  });

  it("coalesces concurrent planned restart requests", async () => {
    const restart = vi
      .spyOn(manager, "restart")
      .mockImplementation(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );

    const first = manager.restartPlanned();
    const second = manager.restartPlanned();

    expect(restart).toHaveBeenCalledOnce();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("rejects a planned restart when the server is unowned", async () => {
    const restart = vi.spyOn(manager, "restart");
    (manager as unknown as { _reusedExisting: boolean })._reusedExisting = true;

    await expect(manager.restartPlanned()).rejects.toThrow("unowned server");
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not suppress an old child after a planned restart fails", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    const oldChild = {
      on: vi.fn((event: string, callback: (code: number | null) => void) => {
        if (event === "exit") oldChild.exit = callback;
      }),
      unref: vi.fn(),
      pid: 54323,
      exitCode: null,
      signalCode: null,
      exit: undefined as ((code: number | null) => void) | undefined,
    };
    vi.mocked(spawn).mockImplementationOnce(() => oldChild as never);
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(lockFileJsonForPid(54323) as never);
    await manager.start();
    vi.spyOn(manager, "restart").mockRejectedValue(
      new Error("planned restart failed"),
    );

    await expect(manager.restartPlanned()).rejects.toThrow(
      "planned restart failed",
    );
    oldChild.exit?.(9);

    expect(onCrash).toHaveBeenCalledWith(9);
  });

  it("clears a late planned old-child exit marker without touching the replacement", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    const oldChild = {
      on: vi.fn((event: string, callback: (code: number | null) => void) => {
        if (event === "exit") oldChild.exit = callback;
      }),
      unref: vi.fn(),
      pid: 54324,
      exitCode: null,
      signalCode: null,
      exit: undefined as ((code: number | null) => void) | undefined,
    };
    const replacement = {
      on: vi.fn(),
      unref: vi.fn(),
      pid: 54325,
      exitCode: null,
      signalCode: null,
    };
    vi.mocked(spawn)
      .mockImplementationOnce(() => oldChild as never)
      .mockImplementationOnce(() => replacement as never);
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(lockFileJsonForPid(54324) as never);
    await manager.start();
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(lockFileJsonForPid(54325) as never);
    vi.spyOn(manager, "restart").mockImplementation(() =>
      manager.start().then(() => undefined),
    );

    await manager.restartPlanned();
    oldChild.exit?.(4);

    expect(onCrash).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Heap size configuration
  // -----------------------------------------------------------------------

  it("reads heapMb from settings.json", async () => {
    // Re-sequence readFileSync: lock ENOENT, then settings.json with custom heap.
    // readAuthTokenFromLock uses async readFile (fs/promises), set up separately.
    vi.mocked(readFileSync).mockReset();
    const enoent = () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    vi.mocked(readFileSync)
      .mockImplementationOnce(enoent) // tryExistingServer
      .mockReturnValueOnce(
        JSON.stringify({ server: { memory: { heapMb: 1024 } } }),
      ); // settings.json
    vi.mocked(readFile).mockResolvedValueOnce(LOCK_FILE_JSON as never); // readAuthTokenFromLock
    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--max-old-space-size=1024");
  });

  it("treats the old default heap setting as unset", async () => {
    vi.mocked(readFileSync).mockReset();
    const enoent = () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    vi.mocked(readFileSync)
      .mockImplementationOnce(enoent)
      .mockReturnValueOnce(
        JSON.stringify({
          server: { memory: { heapMb: SERVER_HEAP_LEGACY_DEFAULT_MB } },
        }),
      );
    vi.mocked(readFile).mockResolvedValueOnce(LOCK_FILE_JSON as never);
    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain(`--max-old-space-size=${SERVER_HEAP_DEFAULT_MB}`);
  });

  it("uses MCODE_SERVER_HEAP_MB env var over settings.json", async () => {
    process.env.MCODE_SERVER_HEAP_MB = "2048";

    // When env var is set, settings.json is never read. Re-sequence accordingly:
    // tryExistingServer lock ENOENT only. readAuthTokenFromLock via async readFile.
    vi.mocked(readFileSync).mockReset();
    const enoent = () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    vi.mocked(readFileSync).mockImplementationOnce(enoent); // tryExistingServer
    vi.mocked(readFile).mockResolvedValueOnce(LOCK_FILE_JSON as never); // readAuthTokenFromLock

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--max-old-space-size=2048");
  });

  it("falls through to settings.json when MCODE_SERVER_HEAP_MB is invalid", async () => {
    process.env.MCODE_SERVER_HEAP_MB = "invalid";

    vi.mocked(readFileSync).mockReset();
    const enoent = () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    vi.mocked(readFileSync)
      .mockImplementationOnce(enoent)
      .mockReturnValueOnce(
        JSON.stringify({ server: { memory: { heapMb: 1024 } } }),
      );
    vi.mocked(readFile).mockResolvedValueOnce(LOCK_FILE_JSON as never);

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--max-old-space-size=1024");
  });

  // -----------------------------------------------------------------------
  // Packaged vs dev entry path branching
  // -----------------------------------------------------------------------

  it("spawns the bundled server.cjs without ts-loader when app.isPackaged is false", async () => {
    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(
      args.some(
        (arg) =>
          arg.includes("dist") &&
          arg.includes("server") &&
          arg.endsWith("server.cjs"),
      ),
    ).toBe(true);
    expect(args.join(" ")).not.toContain("tsx");
    expect(args.join(" ")).not.toContain("--import");
  });

  it("sets ELECTRON_RUN_AS_NODE=1 in the server child process env", async () => {
    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const options = spawnCall[2] as { env: Record<string, string> };
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("replaces an inherited Node binding with the workspace Electron binding in dev", async () => {
    const previousBinding = process.env.BETTER_SQLITE3_BINDING;
    process.env.BETTER_SQLITE3_BINDING = "/inherited/better_sqlite3.node";

    try {
      await manager.start();

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const options = spawnCall[2] as { env: Record<string, string> };
      expect(options.env.BETTER_SQLITE3_BINDING).toContain(
        "better_sqlite3.electron.node",
      );
    } finally {
      if (previousBinding === undefined)
        delete process.env.BETTER_SQLITE3_BINDING;
      else process.env.BETTER_SQLITE3_BINDING = previousBinding;
    }
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

  it("enables fatal V8 reports in packaged builds", async () => {
    refs.setIsPackaged(true);
    Object.defineProperty(process, "resourcesPath", {
      value: "/test/resources",
      configurable: true,
      writable: true,
    });

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--report-on-fatalerror");
    expect(args).toContain("--report-directory=/tmp/mcode");
    expect(args).toContain("--heapsnapshot-near-heap-limit=1");
  });

  it("uses process.execPath when packaged but renamed binary is missing", async () => {
    refs.setIsPackaged(true);
    Object.defineProperty(process, "resourcesPath", {
      value: "/test/resources",
      configurable: true,
      writable: true,
    });
    // Resolver returns execPath (fallback) when renamed binary is absent
    refs.resolveServerBinarySpy.mockReturnValue(process.execPath);

    await manager.start();

    expect(refs.resolveServerBinarySpy).toHaveBeenCalledWith({
      isPackaged: true,
      execPath: process.execPath,
      resourcesPath: "/test/resources",
      platform: TEST_PLATFORM,
    });
    const spawnCall = vi.mocked(NodeChildProcess.spawn).mock.calls[0];
    expect(spawnCall[0]).toBe(process.execPath);
    const opts = spawnCall[2] as { env: Record<string, string> };
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("uses renamed binary when packaged and mcode-server binary exists", async () => {
    refs.setIsPackaged(true);
    Object.defineProperty(process, "resourcesPath", {
      value: "/test/resources",
      configurable: true,
      writable: true,
    });
    const expectedBinary = "/test/resources/bin/mcode-server";
    // Resolver returns the renamed binary when it exists
    refs.resolveServerBinarySpy.mockReturnValue(expectedBinary);

    await manager.start();

    expect(refs.resolveServerBinarySpy).toHaveBeenCalledWith({
      isPackaged: true,
      execPath: process.execPath,
      resourcesPath: "/test/resources",
      platform: TEST_PLATFORM,
    });
    const spawnCall = vi.mocked(NodeChildProcess.spawn).mock.calls[0];
    expect(spawnCall[0]).toBe(expectedBinary);
    const opts = spawnCall[2] as { env: Record<string, string> };
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("passes BETTER_SQLITE3_BINDING env var when packaged and binding exists", async () => {
    refs.setIsPackaged(true);
    Object.defineProperty(process, "resourcesPath", {
      value: "/test/resources",
      configurable: true,
      writable: true,
    });
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).includes("better_sqlite3.node"),
    );

    await manager.start();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    const opts = spawnCall[2] as Record<string, unknown>;
    const env = opts.env as Record<string, string>;
    expect(env.BETTER_SQLITE3_BINDING).toContain("better_sqlite3.node");
    expect(env.MCODE_PACKAGED_RESOURCES_ROOT).toBe("/test/resources");
  });

  it("fails before spawn when the packaged Electron binding is unavailable", async () => {
    refs.setIsPackaged(true);
    Object.defineProperty(process, "resourcesPath", {
      value: "/test/resources",
      configurable: true,
      writable: true,
    });
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(manager.start()).rejects.toThrow(
      "Packaged better-sqlite3 binding not found",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // forceReplace
  // -----------------------------------------------------------------------

  it("forceReplace sends POST /shutdown to the running server", async () => {
    // Lock file exists with a running server
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);

    // process.kill returns normally (server is alive) then throws (server dead)
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => true as never); // alive check
    // Second kill(0) throws to break poll loop
    killSpy.mockImplementationOnce(() => {
      throw new Error("ESRCH");
    });

    await manager.forceReplace();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19600/shutdown",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-auth-token",
          "X-Mcode-Shutdown-Reason": "desktop-update-exit",
        }),
      }),
    );

    killSpy.mockRestore();
  });

  it("stopServerHeldByLock matches forceReplace shutdown behavior", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => true as never);
    killSpy.mockImplementationOnce(() => {
      throw new Error("ESRCH");
    });

    await manager.stopServerHeldByLock();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:19600/shutdown",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-auth-token",
          "X-Mcode-Shutdown-Reason": "desktop-update-exit",
        }),
      }),
    );
    killSpy.mockRestore();
  });

  it("rejects a lock with an invalid PID before probing or stopping it", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync)
      .mockReset()
      .mockReturnValue(
        JSON.stringify({ ...JSON.parse(LOCK_FILE_JSON), pid: 0 }),
      );
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);

    try {
      await expect(manager.stopServerHeldByLock()).rejects.toThrow(
        "Invalid server lock file",
      );

      expect(killSpy).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(unlinkSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("rejects malformed lock JSON and preserves the lock file", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue("{ malformed");

    await expect(manager.stopServerHeldByLock()).rejects.toThrow(
      "Unable to read server lock file",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it("rejects an unreadable lock and preserves the lock file", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.mocked(readFileSync)
      .mockReset()
      .mockImplementation(() => {
        throw denied;
      });

    await expect(manager.stopServerHeldByLock()).rejects.toThrow(
      "Unable to read server lock file",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it("preserves a foreign port-band lock without probing or stopping it", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync)
      .mockReset()
      .mockReturnValue(
        JSON.stringify({ ...JSON.parse(LOCK_FILE_JSON), port: 19500 }),
      );
    const killSpy = vi.spyOn(process, "kill");

    try {
      await manager.stopServerHeldByLock();

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      expect(unlinkSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("refuses to force-kill a live process it does not own", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000;
      return now;
    });

    try {
      await expect(manager.stopServerHeldByLock()).rejects.toThrow(
        "refusing to terminate unrelated process",
      );
      expect(execFileSync).not.toHaveBeenCalled();
      expect(unlinkSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it("keeps the lock and reports Windows tree-kill failure", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("taskkill failed");
    });
    (manager as unknown as { serverProcess: unknown }).serverProcess =
      refs.mockChildProcess;
    (
      manager as unknown as { ownedServerIdentity: unknown }
    ).ownedServerIdentity = JSON.parse(LOCK_FILE_JSON);
    (
      manager as unknown as { ownedServerProcess: unknown }
    ).ownedServerProcess = refs.mockChildProcess;
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    setManagerPlatform(manager, "win32");
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000;
      return now;
    });

    try {
      await expect(manager.stopServerHeldByLock()).rejects.toThrow(
        "Failed to terminate server process tree 12345",
      );
      expect(NodeFS.unlinkSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it("kills the owned POSIX process group and treats ESRCH as success", async () => {
    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    vi.mocked(NodeFS.readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    (manager as unknown as { serverProcess: unknown }).serverProcess =
      refs.mockChildProcess;
    (
      manager as unknown as { ownedServerIdentity: unknown }
    ).ownedServerIdentity = JSON.parse(LOCK_FILE_JSON);
    (
      manager as unknown as { ownedServerProcess: unknown }
    ).ownedServerProcess = refs.mockChildProcess;
    setManagerPlatform(manager, "linux");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid < 0) {
        const error = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        throw error;
      }
      return true as never;
    });
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000;
      return now;
    });

    try {
      await manager.stopServerHeldByLock();

      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(NodeFS.unlinkSync).toHaveBeenCalledOnce();
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it("refuses a PID-reused POSIX process group after the owned leader exits", async () => {
    await manager.start();
    refs.getExitCallback()!(1);

    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    vi.mocked(NodeFS.readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    vi.mocked(NodeFS.unlinkSync).mockReset();
    setManagerPlatform(manager, "linux");
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid > 0) {
          const error = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          throw error;
        }
        if (signal === 0) {
          return true as never;
        }
        return true as never;
      });
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000;
      return now;
    });

    try {
      await expect(manager.stopServerHeldByLock()).rejects.toThrow(
        "refusing to terminate unrelated process",
      );

      expect(killSpy).not.toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(NodeFS.unlinkSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it("refuses a PID-reused Windows process after the owned child exits", async () => {
    await manager.start();
    refs.getExitCallback()!(1);

    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    vi.mocked(NodeFS.readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    vi.mocked(NodeChildProcess.execFileSync).mockReset();
    setManagerPlatform(manager, "win32");
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000;
      return now;
    });

    try {
      await expect(manager.stopServerHeldByLock()).rejects.toThrow(
        "refusing to terminate unrelated process",
      );

      expect(NodeChildProcess.execFileSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it("preserves an unknown lock when its leader is dead but POSIX group remains", async () => {
    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    vi.mocked(NodeFS.readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    setManagerPlatform(manager, "linux");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid > 0) {
        const error = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        throw error;
      }
      return true as never;
    });
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000;
      return now;
    });

    try {
      await expect(manager.stopServerHeldByLock()).rejects.toThrow(
        "refusing to terminate unrelated process",
      );
      expect(killSpy).not.toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(NodeFS.unlinkSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it("does not unlink a lock replaced while shutdown was in progress", async () => {
    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    const replacement = JSON.stringify({
      ...JSON.parse(LOCK_FILE_JSON),
      authToken: "replacement-token",
    });
    vi.mocked(NodeFS.readFileSync)
      .mockReset()
      .mockReturnValueOnce(LOCK_FILE_JSON)
      .mockReturnValueOnce(replacement);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => true as never)
      .mockImplementationOnce(() => {
        const error = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        throw error;
      });

    try {
      await manager.stopServerHeldByLock();

      expect(unlinkSync).not.toHaveBeenCalledWith(
        join("/tmp/mcode", "server.lock"),
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it("does not signal a replacement lock after the owned child exits", async () => {
    await manager.start();
    refs.getExitCallback()!(1);

    const replacement = JSON.stringify({
      ...JSON.parse(LOCK_FILE_JSON),
      authToken: "replacement-token",
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(replacement);
    vi.mocked(unlinkSync).mockReset();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);

    try {
      await manager.stopServerHeldByLock();

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      expect(unlinkSync).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("forceReplace polls PID until process exits", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);

    // process.kill sequence during poll loop and force-kill check:
    // call 1 = alive (poll continues), call 2 = alive (poll continues),
    // call 3 = throws ESRCH (poll breaks), subsequent = throws (dead)
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => {
        throw new Error("ESRCH");
      }) // default: dead
      .mockImplementationOnce(() => true as never) // poll: alive
      .mockImplementationOnce(() => true as never) // poll: alive
      .mockImplementationOnce(() => {
        throw new Error("ESRCH");
      }); // poll: dead, breaks loop

    try {
      await manager.forceReplace();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:19600/shutdown",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-auth-token",
            "X-Mcode-Shutdown-Reason": "desktop-update-exit",
          }),
        }),
      );

      expect(killSpy).toHaveBeenCalledWith(12345, 0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("forceReplace force-kills server if it does not exit within timeout", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReset().mockReturnValue(LOCK_FILE_JSON);
    (manager as unknown as { serverProcess: unknown }).serverProcess =
      refs.mockChildProcess;
    (
      manager as unknown as { ownedServerIdentity: unknown }
    ).ownedServerIdentity = JSON.parse(LOCK_FILE_JSON);
    (
      manager as unknown as { ownedServerProcess: unknown }
    ).ownedServerProcess = refs.mockChildProcess;

    // Always report alive so we hit the SIGKILL fallback.
    // Mock Date.now to fast-forward past the 10s deadline.
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true as never);
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 5000; // jump 5s each call to exceed 10s deadline quickly
      return now;
    });
    setManagerPlatform(manager, "win32");

    try {
      await manager.forceReplace();

      expect(NodeChildProcess.execFileSync).toHaveBeenCalledWith(
        "taskkill",
        ["/T", "/F", "/PID", "12345"],
        expect.objectContaining({ stdio: "ignore" }),
      );
    } finally {
      killSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // Reuse existing server from lock file
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // stderrStream cleanup on spawn failure
  // -----------------------------------------------------------------------

  it("destroys stderrStream when spawn throws in non-dev mode", async () => {
    // Capture the stream instance created by createWriteStream so we can
    // assert that destroy() was called on it after spawn fails.
    const mockStream = { write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    vi.mocked(createWriteStream).mockReturnValueOnce(mockStream as never);

    // Make spawn throw synchronously - simulates a missing executable or
    // other OS-level failure before any child process is created.
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
    });

    await expect(manager.start()).rejects.toThrow("spawn ENOENT");
    expect(mockStream.destroy).toHaveBeenCalledOnce();
  });

  it("ends stderr and clears the child reference when readiness times out", async () => {
    const stderrStream = { write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    vi.mocked(createWriteStream).mockReturnValueOnce(stderrStream as never);
    vi.spyOn(
      manager as unknown as {
        waitForReady: (timeoutMs: number) => Promise<void>;
      },
      "waitForReady",
    ).mockRejectedValue(new Error("Server did not become ready"));

    await expect(manager.start()).rejects.toThrow("did not become ready");

    expect(stderrStream.end).toHaveBeenCalledOnce();
    expect(
      (manager as unknown as { serverProcess: unknown }).serverProcess,
    ).toBeNull();
    expect(rmdirSync).toHaveBeenCalledWith(
      join("/tmp/mcode", "server.starting"),
    );
  });

  it("rotates the previous stderr log before opening a new one", async () => {
    vi.mocked(existsSync).mockImplementation(
      (path) =>
        String(path).endsWith("server-stderr.log") ||
        String(path).includes("better_sqlite3"),
    );

    await manager.start();

    expect(renameSync).toHaveBeenCalledWith(
      join("/tmp/mcode", "server-stderr.log"),
      join("/tmp/mcode", "server-stderr.1.log"),
    );
    expect(createWriteStream).toHaveBeenCalledWith(
      join("/tmp/mcode", "server-stderr.log"),
      { flags: "w" },
    );
  });

  // -----------------------------------------------------------------------
  // Reuse existing server from lock file
  // -----------------------------------------------------------------------

  it("bounds a never-resolving existing-server health probe before spawning", async () => {
    vi.mocked(readFileSync).mockReset().mockReturnValueOnce(LOCK_FILE_JSON);
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(LOCK_FILE_JSON as never);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    globalThis.fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    vi.useFakeTimers();

    try {
      const start = manager.start();
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(start).resolves.toEqual({
        port: 19600,
        authToken: "test-auth-token",
      });
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
  });

  it("rejects a readiness lock that belongs to a different spawned child", async () => {
    vi.mocked(readFile)
      .mockReset()
      .mockResolvedValueOnce(
        JSON.stringify({ ...JSON.parse(LOCK_FILE_JSON), pid: 99999 }) as never,
      );

    await expect(manager.start()).rejects.toThrow(
      "Server lock does not match the spawned server process",
    );
    expect(
      (manager as unknown as { serverProcess: unknown }).serverProcess,
    ).toBeNull();
  });

  it("rejects readiness when the spawned child exits before lock application", async () => {
    vi.mocked(readFile)
      .mockReset()
      .mockImplementationOnce(async () => {
        refs.getExitCallback()!(1);
        return LOCK_FILE_JSON as never;
      });

    await expect(manager.start()).rejects.toThrow(
      "Server process exited before lock application",
    );
    expect(
      (manager as unknown as { serverProcess: unknown }).serverProcess,
    ).toBeNull();
  });

  it("detaches a prior child before it adopts an external lock holder", async () => {
    const onCrash = vi.fn();
    manager.onUnexpectedExit = onCrash;
    await manager.start();
    const delayedExit = refs.getExitCallback();
    const externalLock = JSON.stringify({
      ...JSON.parse(LOCK_FILE_JSON),
      pid: 54326,
      authToken: "external-token",
      startedAt: "2026-01-02T00:00:00.000Z",
    });
    vi.mocked(readFileSync).mockReset().mockReturnValue(externalLock);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);

    try {
      await expect(manager.start()).resolves.toEqual({
        port: 19600,
        authToken: "external-token",
      });
      delayedExit?.(1);

      expect(onCrash).not.toHaveBeenCalled();
      expect(manager.reusedExisting).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("preserves a replacement lock when stale-lock cleanup reaches the deletion race", async () => {
    const replacement = JSON.stringify({
      ...JSON.parse(LOCK_FILE_JSON),
      authToken: "replacement-token",
    });
    const enoent = () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    vi.mocked(readFileSync)
      .mockReset()
      .mockReturnValueOnce(LOCK_FILE_JSON)
      .mockReturnValueOnce(replacement)
      .mockImplementation(enoent);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("ESRCH") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    try {
      await manager.start();

      expect(unlinkSync).not.toHaveBeenCalledWith(
        join("/tmp/mcode", "server.lock"),
      );
      expect(renameSync).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
    }
  });

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

  it("does not probe or reuse an existing server with an invalid PID", async () => {
    const enoent = () => {
      const err = new Error(
        "ENOENT: no such file or directory",
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    vi.mocked(readFileSync)
      .mockReset()
      .mockReturnValueOnce(
        JSON.stringify({ ...JSON.parse(LOCK_FILE_JSON), pid: 0 }),
      )
      .mockImplementationOnce(enoent);
    vi.mocked(readFile).mockResolvedValueOnce(LOCK_FILE_JSON as never);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true as never);

    try {
      await manager.start();

      expect(killSpy).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
