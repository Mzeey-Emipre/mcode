import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

/**
 * Exercises the Codex `app-server` initialize handshake through a fake RPC
 * client (cases a/b/c) and a spawn-mocked `start()` (case d), so cold-start
 * tolerance and orphan teardown are verified without launching a real CLI.
 */

const { mockSpawn, mockExecFile, mockWhich } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFile: vi.fn(),
  mockWhich: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
}));

vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return { ...actual, promisify: () => mockExecFile };
});

vi.mock("which", () => ({ default: mockWhich }));

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { CodexAppServer, performInitialize, isRecoverableCodexResumeError } from "../codex-app-server.js";
import { logger } from "@mcode/shared";

const noSleep = (): Promise<void> => Promise.resolve();

describe("isRecoverableCodexResumeError", () => {
  it("treated missing rollout as recoverable (falls back to thread/start)", () => {
    expect(
      isRecoverableCodexResumeError(
        new Error("no rollout found for thread id 019e886c-5dda-7010-9497-6d776caa0cb0"),
      ),
    ).toBe(true);
  });

  it("treated thread not found as recoverable", () => {
    expect(isRecoverableCodexResumeError(new Error("thread not found"))).toBe(true);
  });
});

describe("performInitialize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) succeeds using the raised cold-start budget", async () => {
    const rpc = { sendRequest: vi.fn().mockResolvedValue({}) };

    await expect(
      performInitialize({
        rpc,
        timeoutMs: 30_000,
        attempts: 2,
        backoffMs: 500,
        getLastStderr: () => null,
        sleep: noSleep,
      }),
    ).resolves.toBeUndefined();

    expect(rpc.sendRequest).toHaveBeenCalledTimes(1);
    // The raised 30s budget (not the old 10s) is passed to the RPC layer, so a
    // server that answers after the old boundary still connects.
    expect(rpc.sendRequest).toHaveBeenCalledWith("initialize", expect.anything(), 30_000);
  });

  it("(b) succeeds on the retry after one failed attempt", async () => {
    const rpc = {
      sendRequest: vi
        .fn()
        .mockRejectedValueOnce(new Error("Timed out waiting for initialize (30000ms)"))
        .mockResolvedValueOnce({}),
    };
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      performInitialize({
        rpc,
        timeoutMs: 30_000,
        attempts: 2,
        backoffMs: 500,
        getLastStderr: () => null,
        sleep,
      }),
    ).resolves.toBeUndefined();

    expect(rpc.sendRequest).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
    // Cold-start recovery is observable in the field.
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "Codex initialize succeeded after retry",
      expect.objectContaining({ attempt: 2 }),
    );
  });

  it("(c) folds the classified stderr reason into the error when every attempt fails", async () => {
    const rpc = {
      sendRequest: vi.fn().mockRejectedValue(new Error("Timed out waiting for initialize (30000ms)")),
    };

    await expect(
      performInitialize({
        rpc,
        timeoutMs: 30_000,
        attempts: 2,
        backoffMs: 500,
        getLastStderr: () => "not authenticated",
        sleep: noSleep,
      }),
    ).rejects.toThrow(/not authenticated/);

    expect(rpc.sendRequest).toHaveBeenCalledTimes(2);
  });

  it("throws the bare timeout when no stderr reason was observed", async () => {
    const rpc = {
      sendRequest: vi.fn().mockRejectedValue(new Error("Timed out waiting for initialize (30000ms)")),
    };

    await expect(
      performInitialize({
        rpc,
        timeoutMs: 30_000,
        attempts: 2,
        backoffMs: 500,
        getLastStderr: () => null,
        sleep: noSleep,
      }),
    ).rejects.toThrow("Timed out waiting for initialize (30000ms)");
  });
});

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

/** A parsed JSON-RPC request line written by the client to the child's stdin. */
interface RpcRequest {
  id?: number;
  method?: string;
}

/** Builds an EventEmitter-backed fake child with stream-backed stdio. */
function makeFakeChild(): { child: FakeChild; stdin: PassThrough; stdout: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as FakeChild;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4321;
  child.kill = vi.fn();
  return { child, stdin, stdout };
}

/**
 * Wires `mockSpawn`/`mockWhich`/`mockExecFile` to a fresh fake child and
 * routes each NDJSON request the client writes to `respond`, which returns the
 * JSON-RPC result/error payload (or `null` to stay silent, e.g. notifications).
 * Returns the live child so tests can drive exit/stderr.
 */
function harnessFakeServer(
  respond: (req: RpcRequest) => Record<string, unknown> | null,
): { child: FakeChild } {
  const { child, stdin, stdout } = makeFakeChild();

  mockWhich.mockResolvedValue("/usr/bin/codex");
  mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
  mockSpawn.mockImplementation(() => {
    setImmediate(() => child.emit("spawn"));
    return child;
  });

  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as RpcRequest;
      if (typeof msg.id !== "number") continue;
      const payload = respond(msg);
      if (payload) stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...payload }) + "\n");
    }
  });

  return { child };
}

describe("CodexAppServer.start (failed handshake teardown)", () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    // Force the Windows teardown path so taskkill is asserted deterministically
    // regardless of the host OS running the suite.
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  });

  // Reject every `initialize`; ack anything else so kill()'s best-effort
  // turn/interrupt resolves immediately instead of waiting out its timeout.
  const rejectInitialize = (req: RpcRequest): Record<string, unknown> =>
    req.method === "initialize"
      ? { error: { message: "not authenticated" } }
      : { result: {} };

  it("(d) kills the spawned child via taskkill on Windows so a failed start leaves no orphan", async () => {
    harnessFakeServer(rejectInitialize);

    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await expect(server.start()).rejects.toThrow();

    expect(mockExecFile).toHaveBeenCalledWith("taskkill", ["/T", "/F", "/PID", "4321"]);
    expect(server.isAlive).toBe(false);
  }, 10_000);

  it("(e) signals the spawned child on Unix so a failed start leaves no orphan", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { child } = harnessFakeServer(rejectInitialize);
    // SIGTERM should suffice; emit exit so kill() does not escalate to SIGKILL.
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") setImmediate(() => child.emit("exit", 0, null));
      return true;
    });

    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await expect(server.start()).rejects.toThrow();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(server.isAlive).toBe(false);
  }, 10_000);

  it("(f) wires the retry config through runHandshake: a slow initialize recovers and the thread starts", async () => {
    let initializeAttempts = 0;
    const { child } = harnessFakeServer((req): Record<string, unknown> | null => {
      switch (req.method) {
        case "initialize":
          initializeAttempts += 1;
          // Fail the first attempt, succeed on the retry.
          return initializeAttempts === 1 ? { error: { message: "still warming up" } } : { result: {} };
        case "thread/start":
          return { result: { thread: { id: "thread-cold-start" } } };
        default:
          // model/list and any best-effort calls.
          return { result: {} };
      }
    });

    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await expect(server.start()).resolves.toBeUndefined();

    expect(initializeAttempts).toBe(2);
    expect(server.threadId).toBe("thread-cold-start");
    expect(server.isAlive).toBe(true);

    // Clean up the live fake session (taskkill is mocked under the forced win32 platform).
    await server.kill();
    void child;
  }, 10_000);
});
