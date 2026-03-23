import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SidecarEvent } from "../sidecar/types.js";
import type { SDKSession } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock SDKSession whose stream() yields the given events and then
 * optionally hangs (liveAfter=true) or terminates.
 */
function createMockSession(
  events: Array<Record<string, unknown>>,
  opts: { liveAfter?: boolean } = {},
) {
  let closeResolve: (() => void) | undefined;

  const session = {
    sessionId: "mock-session-id",
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn().mockImplementation(async function* () {
      for (const event of events) {
        yield event;
      }
      if (opts.liveAfter) {
        // Simulate a long-lived stream that stays open until close() is called
        await new Promise<void>((r) => {
          closeResolve = r;
        });
      }
    }),
    close: vi.fn().mockImplementation(() => {
      closeResolve?.();
    }),
    [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
  };

  return session as unknown as SDKSession;
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { SidecarClient } from "../sidecar/client.js";
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function collectEvents(client: SidecarClient): SidecarEvent[] {
  const events: SidecarEvent[] = [];
  client.on("event", (e: SidecarEvent) => events.push(e));
  return events;
}

/** Wait until at least one event with the given method has been emitted. */
async function waitForEvent(
  events: SidecarEvent[],
  method: SidecarEvent["method"],
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.some((e) => e.method === method)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for event: ${method}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidecarClient (v2 session API)", () => {
  let client: SidecarClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = SidecarClient.start();
  });

  afterEach(() => {
    client.shutdown();
  });

  // -------------------------------------------------------------------------
  // Basics
  // -------------------------------------------------------------------------

  it("isReady returns true immediately", () => {
    expect(client.isReady()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  it("emits session.message and session.turnComplete on result", async () => {
    const session = createMockSession([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
      },
      {
        type: "result",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: { input_tokens: 50, output_tokens: 100 },
      },
    ]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    const messageEvent = events.find((e) => e.method === "session.message");
    expect(messageEvent).toBeTruthy();
    if (messageEvent?.method === "session.message") {
      expect(messageEvent.params.content).toBe("Hello world");
      expect(messageEvent.params.type).toBe("assistant");
      expect(messageEvent.params.tokens).toBe(100);
    }

    const turnEvent = events.find((e) => e.method === "session.turnComplete");
    expect(turnEvent).toBeTruthy();
    if (turnEvent?.method === "session.turnComplete") {
      expect(turnEvent.params.reason).toBe("end_turn");
      expect(turnEvent.params.costUsd).toBe(0.01);
      expect(turnEvent.params.totalTokensIn).toBe(50);
      expect(turnEvent.params.totalTokensOut).toBe(100);
    }
  });

  it("does not emit session.message when no text was accumulated", async () => {
    const session = createMockSession([
      { type: "assistant", message: { content: [] } },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(events.find((e) => e.method === "session.message")).toBeUndefined();
    expect(events.find((e) => e.method === "session.turnComplete")).toBeTruthy();
  });

  it("emits session.system for system events", async () => {
    const session = createMockSession([
      { type: "system", subtype: "init" },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.system");

    const sysEvent = events.find((e) => e.method === "session.system");
    expect(sysEvent?.method === "session.system" && sysEvent.params.subtype).toBe("init");
  });

  it("emits session.toolUse for tool_use blocks in assistant message", async () => {
    const session = createMockSession([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tc1", name: "Read", input: { path: "/foo" } },
          ],
        },
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Read file", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.toolUse");

    const toolEvent = events.find((e) => e.method === "session.toolUse");
    expect(toolEvent).toBeTruthy();
    if (toolEvent?.method === "session.toolUse") {
      expect(toolEvent.params.toolName).toBe("Read");
      expect(toolEvent.params.toolCallId).toBe("tc1");
      expect(toolEvent.params.toolInput).toEqual({ path: "/foo" });
    }
  });

  it("emits session.toolUse for top-level tool_use events", async () => {
    const session = createMockSession([
      {
        type: "tool_use",
        id: "tc2",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "List files", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.toolUse");

    const toolEvent = events.find((e) => e.method === "session.toolUse");
    expect(toolEvent).toBeTruthy();
    if (toolEvent?.method === "session.toolUse") {
      expect(toolEvent.params.toolName).toBe("Bash");
      expect(toolEvent.params.toolCallId).toBe("tc2");
      expect(toolEvent.params.toolInput).toEqual({ command: "ls" });
    }
  });

  it("emits session.toolResult for tool_result events", async () => {
    const session = createMockSession([
      {
        type: "tool_result",
        tool_use_id: "tc1",
        content: "file contents here",
        is_error: false,
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Read file", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.toolResult");

    const toolResult = events.find((e) => e.method === "session.toolResult");
    expect(toolResult).toBeTruthy();
    if (toolResult?.method === "session.toolResult") {
      expect(toolResult.params.toolCallId).toBe("tc1");
      expect(toolResult.params.output).toBe("file contents here");
      expect(toolResult.params.isError).toBe(false);
    }
  });

  it("emits session.toolResult with JSON stringified content when not a string", async () => {
    const session = createMockSession([
      {
        type: "tool_result",
        tool_use_id: "tc1",
        content: { result: "data" },
        is_error: false,
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Op", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.toolResult");

    const toolResult = events.find((e) => e.method === "session.toolResult");
    expect(toolResult?.method === "session.toolResult" && toolResult.params.output).toBe(
      JSON.stringify({ result: "data" }),
    );
  });

  it("emits session.error and session.ended when stream throws", async () => {
    const session = {
      sessionId: "s",
      send: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn().mockImplementation(async function* () {
        throw new Error("SDK crash");
      }),
      close: vi.fn(),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    } as unknown as SDKSession;

    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-456", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.ended");

    const errorEvent = events.find((e) => e.method === "session.error");
    expect(errorEvent).toBeTruthy();
    if (errorEvent?.method === "session.error") {
      expect(errorEvent.params.error).toBe("SDK crash");
      expect(errorEvent.params.sessionId).toBe("mcode-456");
    }

    expect(events.some((e) => e.method === "session.ended")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Three-state session model
  // -------------------------------------------------------------------------

  it("calls createSession on first message (resume=false, no pool entry)", async () => {
    const session = createMockSession([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(unstable_v2_createSession).toHaveBeenCalledOnce();
    expect(unstable_v2_resumeSession).not.toHaveBeenCalled();
    expect(session.send).toHaveBeenCalledWith("Hi");
  });

  it("calls resumeSession when resume=true and no pool entry", async () => {
    const session = createMockSession([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(unstable_v2_resumeSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc-def", "Hi", "/tmp", "claude-sonnet-4-6", true, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(unstable_v2_resumeSession).toHaveBeenCalledOnce();
    expect(unstable_v2_resumeSession).toHaveBeenCalledWith(
      "abc-def",
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
    );
    expect(unstable_v2_createSession).not.toHaveBeenCalled();
  });

  it("reuses existing session for second message (no re-create)", async () => {
    // Long-lived session that stays in pool after the first turn
    const session = createMockSession(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);

    // First message
    client.sendMessage("mcode-live", "msg1", "/tmp", "claude-sonnet-4-6", false, "default");
    await waitForEvent(events, "session.turnComplete");

    // Second message — session is in pool, should NOT call createSession again
    client.sendMessage("mcode-live", "msg2", "/tmp", "claude-sonnet-4-6", false, "default");
    await new Promise((r) => setTimeout(r, 20));

    expect(unstable_v2_createSession).toHaveBeenCalledOnce(); // not twice
    expect(session.send).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenNthCalledWith(1, "msg1");
    expect(session.send).toHaveBeenNthCalledWith(2, "msg2");
  });

  it("closes session and re-creates on model change", async () => {
    const session1 = createMockSession(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    const session2 = createMockSession([{ type: "result", stop_reason: "end_turn" }]);

    vi.mocked(unstable_v2_createSession)
      .mockReturnValueOnce(session1)
      .mockReturnValueOnce(session2);

    const events = collectEvents(client);

    // First message with sonnet
    client.sendMessage("mcode-switch", "msg1", "/tmp", "claude-sonnet-4-6", false, "default");
    await waitForEvent(events, "session.turnComplete");

    // Second message with different model — should close session1 and create new
    events.length = 0;
    client.sendMessage("mcode-switch", "msg2", "/tmp", "claude-opus-4-6", false, "default");
    await waitForEvent(events, "session.turnComplete");

    expect(session1.close).toHaveBeenCalled();
    expect(unstable_v2_createSession).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(unstable_v2_createSession).mock.calls[1]?.[0],
    ).toMatchObject({ model: "claude-opus-4-6" });
  });

  it("strips 'mcode-' prefix from sessionId for SDK uuid in resumeSession", async () => {
    const session = createMockSession([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(unstable_v2_resumeSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc-def", "Hi", "/tmp", "claude-sonnet-4-6", true, "default");

    await waitForEvent(events, "session.turnComplete");

    // UUID passed to resumeSession should NOT have "mcode-" prefix
    expect(unstable_v2_resumeSession).toHaveBeenCalledWith("abc-def", expect.any(Object));
  });

  it("passes executableArgs --cwd to session options", async () => {
    const session = createMockSession([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/my/workspace", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(unstable_v2_createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executableArgs: ["--cwd", "/my/workspace"],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Permission mode
  // -------------------------------------------------------------------------

  it("uses bypassPermissions when permissionMode is 'full'", async () => {
    const session = createMockSession([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "full");

    await waitForEvent(events, "session.turnComplete");

    expect(unstable_v2_createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
    );
  });

  it("uses default permissionMode for non-full modes", async () => {
    const session = createMockSession([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(unstable_v2_createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "default" }),
    );
  });

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  it("stopSession calls session.close()", async () => {
    const session = createMockSession(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-stop", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");
    await waitForEvent(events, "session.turnComplete");

    client.stopSession("mcode-stop");
    expect(session.close).toHaveBeenCalled();
  });

  it("stream loop cleans up pool entry after stream ends", async () => {
    const session = createMockSession([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    const events = collectEvents(client);
    client.sendMessage("mcode-cleanup", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.ended");

    const sessions = (client as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has("mcode-cleanup")).toBe(false);
  });

  it("shutdown calls close() on all active sessions", async () => {
    const session1 = createMockSession(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    const session2 = createMockSession(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );

    vi.mocked(unstable_v2_createSession)
      .mockReturnValueOnce(session1)
      .mockReturnValueOnce(session2);

    const e1 = collectEvents(client);
    client.sendMessage("mcode-a", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");
    const e2 = collectEvents(client);
    client.sendMessage("mcode-b", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(e1, "session.turnComplete");
    await waitForEvent(e2, "session.turnComplete");

    client.shutdown();

    expect(session1.close).toHaveBeenCalled();
    expect(session2.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idle eviction
  // -------------------------------------------------------------------------

  it("evicts idle sessions after TTL", async () => {
    vi.useFakeTimers();

    let closeResolve: (() => void) | undefined;
    const session = {
      sessionId: "s",
      send: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: "result", stop_reason: "end_turn" };
        await new Promise<void>((r) => {
          closeResolve = r;
        });
      }),
      close: vi.fn().mockImplementation(() => {
        closeResolve?.();
      }),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    } as unknown as SDKSession;

    vi.mocked(unstable_v2_createSession).mockReturnValue(session);

    client.sendMessage("mcode-evict", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    // Flush the async send and stream startup
    await Promise.resolve();
    await Promise.resolve();

    // Advance time past idle TTL (10 min) + eviction interval (1 min)
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000 + 1000);

    expect(session.close).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
