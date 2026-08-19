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

import { CodexAppServer, performInitialize, isRecoverableCodexResumeError } from "../../private/codex/codex-app-server.js";
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

  it("treated structured THREAD_NOT_FOUND code as recoverable", () => {
    const err = new Error("resume failed") as Error & { code: string };
    err.code = "THREAD_NOT_FOUND";
    expect(isRecoverableCodexResumeError(err)).toBe(true);
  });

  it("did not treat unrelated auth errors as recoverable", () => {
    expect(isRecoverableCodexResumeError(new Error("not authenticated"))).toBe(false);
    expect(isRecoverableCodexResumeError(new Error("api key missing"))).toBe(false);
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
  params?: Record<string, unknown>;
}

function findUnexpectedExitLogFields(): { stderrTail?: string[] } | undefined {
  const call = (vi.mocked(logger.error).mock.calls as unknown[][]).find(([message]) =>
    String(message).includes("Codex app-server exited unexpectedly"),
  );
  return call?.[1] as { stderrTail?: string[] } | undefined;
}

/** Builds an EventEmitter-backed fake child with stream-backed stdio. */
function makeFakeChild(): { child: FakeChild; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as FakeChild;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4321;
  child.kill = vi.fn();
  return { child, stdin, stdout, stderr };
}

/**
 * Wires `mockSpawn`/`mockWhich`/`mockExecFile` to a fresh fake child and
 * routes each NDJSON request the client writes to `respond`, which returns the
 * JSON-RPC result/error payload (or `null` to stay silent, e.g. notifications).
 * Returns the live child so tests can drive exit/stderr.
 */
function harnessFakeServer(
  respond: (req: RpcRequest) => Record<string, unknown> | null,
): { child: FakeChild; stderr: PassThrough } {
  const { child, stdin, stdout, stderr } = makeFakeChild();

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

  return { child, stderr };
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

  it("(d2) concurrent kill() calls awaited the same teardown", async () => {
    harnessFakeServer(rejectInitialize);

    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await expect(server.start()).rejects.toThrow();

    mockExecFile.mockClear();
    await Promise.all([server.kill(), server.kill()]);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(server.isAlive).toBe(false);
  }, 10_000);

  it("passes config overrides to codex app-server as -c arguments", async () => {
    harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-config" } } } : { result: {} },
    );

    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      configOverrides: ["mcp_servers.figma-dev-mode.enabled=false"],
    });

    await server.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/bin/codex",
      ["app-server", "-c", "mcp_servers.figma-dev-mode.enabled=false"],
      expect.any(Object),
    );
  }, 10_000);

  it("forwards MCP startup status notifications to provider mapping", async () => {
    const { child } = harnessFakeServer((req): Record<string, unknown> => {
      switch (req.method) {
        case "thread/start":
          return { result: { thread: { id: "thread-mcp-status" } } };
        default:
          return { result: {} };
      }
    });
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const notification = vi.fn();

    server.on("notification", notification);
    await server.start();
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "thread-mcp-status",
        name: "figma-dev-mode",
        status: "cancelled",
        failureReason: "optional server was cancelled",
      },
    }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(notification).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "thread-mcp-status",
        name: "figma-dev-mode",
        status: "cancelled",
        failureReason: "optional server was cancelled",
      },
    });
  }, 10_000);

  it("does not rotate the root thread id for a spawned child thread", async () => {
    const { child } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-root" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await server.start();
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: {
        thread: { id: "thread-child", parentThreadId: "thread-root" },
      },
    }) + "\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(server.threadId).toBe("thread-root");
    await server.kill();
  }, 10_000);

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

  it("appends configured instructions to thread/start in block order", async () => {
    let configRequest: RpcRequest | undefined;
    let startRequest: RpcRequest | undefined;
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "config/read") {
        configRequest = req;
        return { result: { config: { developer_instructions: "configured rules" } } };
      }
      if (req.method === "thread/start") {
        startRequest = req;
        return { result: { thread: { id: "thread-instructions-start" } } };
      }
      return { result: {} };
    });
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      developerInstructions: "mcode runtime",
    });

    await server.start();

    expect(startRequest?.params).toEqual(expect.objectContaining({
      cwd: "/tmp",
      developerInstructions: "configured rules\n\nmcode runtime",
    }));
    expect(configRequest?.params).toEqual({ includeLayers: false, cwd: "/tmp" });
    await server.kill();
  }, 10_000);

  it("appends configured instructions to thread/resume in block order", async () => {
    let configRequest: RpcRequest | undefined;
    let resumeRequest: RpcRequest | undefined;
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "config/read") {
        configRequest = req;
        return { result: { config: { developer_instructions: "configured rules" } } };
      }
      if (req.method === "thread/resume") {
        resumeRequest = req;
        return { result: { thread: { id: "thread-instructions-resume" } } };
      }
      return { result: {} };
    });
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      resumeThreadId: "thread-existing",
      developerInstructions: "mcode runtime",
    });

    await server.start();

    expect(resumeRequest?.params).toEqual(expect.objectContaining({
      cwd: "/tmp",
      threadId: "thread-existing",
      developerInstructions: "configured rules\n\nmcode runtime",
    }));
    expect(configRequest?.params).toEqual({ includeLayers: false, cwd: "/tmp" });
    await server.kill();
  }, 10_000);

  it("continues thread/start without an override when config/read fails", async () => {
    let startRequest: RpcRequest | undefined;
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "config/read") return { error: { message: "config unavailable" } };
      if (req.method === "thread/start") {
        startRequest = req;
        return { result: { thread: { id: "thread-instructions-fallback" } } };
      }
      return { result: {} };
    });
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      developerInstructions: "mcode runtime",
    });

    await expect(server.start()).resolves.toBeUndefined();

    expect(startRequest?.params).not.toHaveProperty("developerInstructions");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "Codex config/read failed; omitting developer instructions",
      expect.objectContaining({ error: expect.stringContaining("config unavailable") }),
    );
    await server.kill();
  }, 10_000);

  it("continues thread/start without an override when config/read is malformed", async () => {
    let startRequest: RpcRequest | undefined;
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "config/read") return { result: { config: { developer_instructions: 42 } } };
      if (req.method === "thread/start") {
        startRequest = req;
        return { result: { thread: { id: "thread-instructions-malformed" } } };
      }
      return { result: {} };
    });
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      developerInstructions: "mcode runtime",
    });

    await expect(server.start()).resolves.toBeUndefined();

    expect(startRequest?.params).not.toHaveProperty("developerInstructions");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "Codex config/read failed; omitting developer instructions",
      expect.objectContaining({ error: expect.stringContaining("invalid response") }),
    );
    await server.kill();
  }, 10_000);

  it("reuses composed instructions when recoverable resume falls back to thread/start", async () => {
    let configReadCount = 0;
    let resumeRequest: RpcRequest | undefined;
    let startRequest: RpcRequest | undefined;
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "config/read") {
        configReadCount += 1;
        return { result: { config: { developer_instructions: "configured rules" } } };
      }
      if (req.method === "thread/resume") {
        resumeRequest = req;
        return { error: { message: "no rollout found for thread id thread-existing" } };
      }
      if (req.method === "thread/start") {
        startRequest = req;
        return { result: { thread: { id: "thread-instructions-fallback" } } };
      }
      return { result: {} };
    });
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      resumeThreadId: "thread-existing",
      developerInstructions: "mcode runtime",
    });

    await expect(server.start()).resolves.toBeUndefined();

    expect(configReadCount).toBe(1);
    expect(resumeRequest?.params).toEqual(expect.objectContaining({
      developerInstructions: "configured rules\n\nmcode runtime",
    }));
    expect(startRequest?.params).toEqual(expect.objectContaining({
      developerInstructions: "configured rules\n\nmcode runtime",
    }));
    await server.kill();
  }, 10_000);

  it.each([
    { name: "missing", config: {} },
    { name: "blank", config: { developer_instructions: "  " } },
  ])("sends Mcode instructions alone when config is $name", async ({ config }) => {
    let startRequest: RpcRequest | undefined;
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "config/read") return { result: { config } };
      if (req.method === "thread/start") {
        startRequest = req;
        return { result: { thread: { id: `thread-instructions-${config}` } } };
      }
      return { result: {} };
    });
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      developerInstructions: "mcode runtime",
    });

    await expect(server.start()).resolves.toBeUndefined();

    expect(startRequest?.params).toEqual(expect.objectContaining({
      developerInstructions: "mcode runtime",
    }));
    await server.kill();
  }, 10_000);

  it("uses the raised thread handshake budget for thread/start", async () => {
    harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-start-budget" } } } : { result: {} },
    );
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    try {
      await server.start();

      const timeoutBudgets = setTimeoutSpy.mock.calls.map(([, delay]) => delay);
      expect(timeoutBudgets).toContain(10_000);
      expect(timeoutBudgets).toContain(3_000);
      expect(timeoutBudgets.filter((delay) => delay === 30_000)).toHaveLength(2);
      expect(timeoutBudgets).not.toContain(15_000);
    } finally {
      setTimeoutSpy.mockRestore();
      await server.kill();
    }
  }, 10_000);

  it("uses the raised thread handshake budget for thread/resume", async () => {
    harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/resume" ? { result: { thread: { id: "thread-resume-budget" } } } : { result: {} },
    );
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      getSpawnEnv: () => ({}),
      resumeThreadId: "thread-existing",
    });

    try {
      await server.start();

      const timeoutBudgets = setTimeoutSpy.mock.calls.map(([, delay]) => delay);
      expect(timeoutBudgets).toContain(10_000);
      expect(timeoutBudgets.filter((delay) => delay === 30_000)).toHaveLength(2);
      expect(timeoutBudgets).not.toContain(15_000);
    } finally {
      setTimeoutSpy.mockRestore();
      await server.kill();
    }
  }, 10_000);

  it("reads active child identity without requiring thread/resume to succeed", async () => {
    const readRequests: Array<Record<string, unknown>> = [];
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "thread/start") return { result: { thread: { id: "parent-thread" } } };
      if (req.method === "thread/read") {
        readRequests.push(req as Record<string, unknown>);
        const threadId = (req.params as { threadId?: string } | undefined)?.threadId;
        return {
          result: {
            thread: threadId === "child-without-settings"
              ? { id: threadId, agentNickname: "Ada", agentRole: "worker" }
              : {
                  id: "child-thread",
                  name: "read_docs_worker",
                  agentNickname: "Ada",
                  agentRole: "worker",
                },
          },
        };
      }
      return { result: {} };
    });
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await server.start();
    await expect(server.getChildThreadMetadata("child-thread")).resolves.toEqual({
      identity: "read_docs_worker",
    });
    await expect(server.getChildThreadMetadata("child-without-settings")).resolves.toEqual({
      identity: "Ada",
    });
    await expect(server.getChildThreadMetadata("../invalid")).resolves.toBeNull();

    expect(server.threadId).toBe("parent-thread");
    expect(readRequests).toHaveLength(2);
    await server.kill();
  }, 10_000);

  it("emits decoded unexpected-exit diagnostics with the latest non-benign stderr", async () => {
    const { child, stderr } = harnessFakeServer((req): Record<string, unknown> => {
      switch (req.method) {
        case "thread/start":
          return { result: { thread: { id: "thread-crash" } } };
        default:
          return { result: {} };
      }
    });
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const fatal = vi.fn();
    server.on("fatal", fatal);

    await server.start();
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { turnId: "turn-crash" } }) + "\n");
    stderr.write("ExperimentalWarning: ignore me\n");
    stderr.write("\u001b[31mfirst useful line\u001b[0m\n");
    stderr.write("latest crash cause\n");
    child.emit("exit", 4294967295, null);

    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("Codex app-server exited unexpectedly"));
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("raw code=4294967295"));
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("signal=null"));
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("signed int32=-1"));
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("hex=0xffffffff"));
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("latest stderr: latest crash cause"));
    expect(fatal).not.toHaveBeenCalledWith(expect.stringContaining("ExperimentalWarning"));
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining("Codex app-server exited unexpectedly"),
      expect.objectContaining({
        exit: expect.objectContaining({
          rawCode: 4294967295,
          signal: null,
          signedInt32: -1,
          hexCode: "0xffffffff",
        }),
        stderrTail: ["first useful line", "latest crash cause"],
      }),
    );

    expect(vi.mocked(fatal).mock.calls[0]).toHaveLength(1);
    const breadcrumb = server.lastTransportBreadcrumb as {
      cause: string;
      pid: number | null;
      activeTurnId: string | null;
      lastActivity: { method: string; timestamp: number } | null;
      exit: { code: number | null; signal: string | null };
      stderrTail: readonly string[];
    };
    expect(breadcrumb).toMatchObject({
      cause: "unexpected_exit",
      pid: 4321,
      activeTurnId: "turn-crash",
      lastActivity: { method: "turn/started" },
      exit: { code: 4294967295, signal: null },
      stderrTail: ["first useful line", "latest crash cause"],
    });
    expect(Object.isFrozen(breadcrumb)).toBe(true);
    expect(Object.isFrozen(breadcrumb.stderrTail)).toBe(true);
    expect(JSON.stringify(breadcrumb)).not.toContain("prompt");
  }, 10_000);

  it("captures crash breadcrumb without request payload content", async () => {
    const { child } = harnessFakeServer((req): Record<string, unknown> => {
      if (req.method === "thread/start") return { result: { thread: { id: "thread-redacted" } } };
      if (req.method === "turn/start") return { result: { turn: { id: "turn-redacted" } } };
      return { result: {} };
    });
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const fatal = vi.fn();
    server.on("fatal", fatal);

    await server.start();
    await server.sendTurn("secret prompt and response payload");
    child.emit("exit", 9, "SIGKILL");

    expect(vi.mocked(fatal).mock.calls[0]).toHaveLength(1);
    const breadcrumb = server.lastTransportBreadcrumb;
    expect(breadcrumb).toMatchObject({ activeTurnId: "turn-redacted", exit: { code: 9, signal: "SIGKILL" } });
    expect(JSON.stringify(breadcrumb)).not.toContain("secret prompt");
    expect(JSON.stringify(breadcrumb)).not.toContain("response payload");
  }, 10_000);

  it("bounds oversized protocol identifiers in crash breadcrumbs", async () => {
    const { child } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-bounded-identifiers" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const oversizedTurnId = "turn-" + "x".repeat(1024);
    const oversizedMethod = "method/" + "y".repeat(1024);

    await server.start();
    child.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { turnId: oversizedTurnId },
    }) + "\n");
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: oversizedMethod, params: {} }) + "\n");
    child.emit("exit", 2, null);

    const breadcrumb = server.lastTransportBreadcrumb;
    expect(breadcrumb?.activeTurnId).toBe("turn-" + "x".repeat(251));
    expect(breadcrumb?.lastActivity?.method).toBe("method/" + "y".repeat(249));
    expect(breadcrumb?.activeTurnId).toHaveLength(256);
    expect(breadcrumb?.lastActivity?.method).toHaveLength(256);
  }, 10_000);

  it("reports when unexpected exit has no captured non-benign stderr", async () => {
    const { child, stderr } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-no-stderr" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const fatal = vi.fn();
    server.on("fatal", fatal);

    await server.start();
    stderr.write("Reading prompt from stdin\n");
    child.emit("exit", 1, "SIGTERM");

    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("no stderr was captured"));
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining("Codex app-server exited unexpectedly"),
      expect.objectContaining({ stderrTail: [] }),
    );
  }, 10_000);

  it("bounds unexpected-exit stderr tail by line count and evicts oldest lines", async () => {
    const { child, stderr } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-bounded" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await server.start();
    for (let i = 0; i < 60; i++) {
      stderr.write(`line-${i}\n`);
    }
    child.emit("exit", 2, null);

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining("Codex app-server exited unexpectedly"),
      expect.objectContaining({
        stderrTail: expect.arrayContaining(["line-10", "line-59"]),
      }),
    );
    const logFields = findUnexpectedExitLogFields();
    expect(logFields?.stderrTail).toHaveLength(50);
    expect(logFields?.stderrTail?.[0]).toBe("line-10");
    expect(logFields?.stderrTail).not.toContain("line-9");
  }, 10_000);

  it("bounds unexpected-exit stderr tail by bytes and keeps the newest line", async () => {
    const { child, stderr } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-byte-bounded" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await server.start();
    stderr.write(`${"A".repeat(12 * 1024)}\n`);
    stderr.write(`${"B".repeat(12 * 1024)}\n`);
    child.emit("exit", 2, null);

    const logFields = findUnexpectedExitLogFields();
    expect(logFields?.stderrTail).toHaveLength(1);
    expect(logFields?.stderrTail?.[0]).toBe("B".repeat(12 * 1024));
  }, 10_000);

  it("retains one oversized non-benign stderr line in bounded form", async () => {
    const { child, stderr } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-oversized-stderr" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const fatal = vi.fn();
    server.on("fatal", fatal);

    await server.start();
    stderr.write(`${"oversized crash cause ".repeat(1024)}\n`);
    child.emit("exit", 2, null);

    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("latest stderr:"));
    const logFields = findUnexpectedExitLogFields();
    expect(logFields?.stderrTail).toHaveLength(1);
    expect(Buffer.byteLength(logFields?.stderrTail?.[0] ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(logFields?.stderrTail?.[0]).toContain("oversized crash cause");
  }, 10_000);

  it("truncates and strips backticks in the fatal message excerpt while keeping the full line in stderrTail", async () => {
    const { child, stderr } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-backtick-stderr" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const fatal = vi.fn();
    server.on("fatal", fatal);

    await server.start();
    const longBadLine = "run `rm -rf ~` now ".repeat(30);
    stderr.write(longBadLine + "\n");
    child.emit("exit", 2, null);

    expect(fatal).toHaveBeenCalledWith(expect.stringContaining("latest stderr:"));

    const fatalMsg: string = vi.mocked(fatal).mock.calls
      .flatMap((args) => args)
      .find((a): a is string => typeof a === "string" && a.includes("latest stderr:")) ?? "";

    expect(fatalMsg).not.toContain("`");

    const excerptMatch = fatalMsg.match(/latest stderr: ([\s\S]*)\)$/);
    expect(excerptMatch).not.toBeNull();
    const excerpt = excerptMatch![1];
    // 256-code-point cap plus the trailing ellipsis character.
    expect([...excerpt].length).toBeLessThanOrEqual(257);

    const logFields = findUnexpectedExitLogFields();
    expect(logFields?.stderrTail?.some((l) => l.includes("`"))).toBe(true);
  }, 10_000);

  it("does not split surrogate pairs when bounding an oversized stderr line", async () => {
    const { child, stderr } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-emoji-stderr" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });

    await server.start();
    stderr.write(`${"A".repeat(16 * 1024 - 3)}😀${"B".repeat(100)}\n`);
    child.emit("exit", 2, null);

    const retainedLine = findUnexpectedExitLogFields()?.stderrTail?.[0] ?? "";
    const lastCodeUnit = retainedLine.charCodeAt(retainedLine.length - 1);
    expect(Buffer.byteLength(retainedLine, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdfff).toBe(true);
  }, 10_000);

  it("keeps kill-requested teardown silent", async () => {
    const { child } = harnessFakeServer((req): Record<string, unknown> =>
      req.method === "thread/start" ? { result: { thread: { id: "thread-kill" } } } : { result: {} },
    );
    const server = new CodexAppServer({ cliPath: "codex", workingDirectory: "/tmp", getSpawnEnv: () => ({}) });
    const fatal = vi.fn();
    server.on("fatal", fatal);

    await server.start();
    await server.kill();
    child.emit("exit", 1, null);

    expect(fatal).not.toHaveBeenCalledWith(expect.stringContaining("Codex app-server exited unexpectedly"));
  }, 10_000);

  it("initializes a catalog-only connection without creating a thread", async () => {
    const methods: string[] = [];
    harnessFakeServer((req): Record<string, unknown> => {
      if (req.method) methods.push(req.method);
      return { result: {} };
    });
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: "/tmp",
      catalogOnly: true,
      getSpawnEnv: () => ({}),
    });

    await server.start();

    expect(methods).toContain("initialize");
    expect(methods).not.toContain("model/list");
    expect(methods).not.toContain("thread/start");
    await server.kill();
  }, 10_000);
});
