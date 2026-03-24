import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SidecarEvent } from "../sidecar/types.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock Query (AsyncGenerator) that yields the given events.
 * When liveAfter is true, the generator stays open after yielding events
 * until close() is called.
 */
function createMockQuery(
  events: Array<Record<string, unknown>>,
  opts: { liveAfter?: boolean } = {},
) {
  let closeResolve: (() => void) | undefined;

  const generator = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (events.length > 0) {
        return { value: events.shift()!, done: false };
      }
      if (opts.liveAfter) {
        await new Promise<void>((r) => {
          closeResolve = r;
        });
        return { value: undefined, done: true };
      }
      return { value: undefined, done: true };
    },
    async return() {
      closeResolve?.();
      return { value: undefined, done: true };
    },
    async throw() {
      return { value: undefined, done: true };
    },
    close: vi.fn().mockImplementation(() => {
      closeResolve?.();
    }),
    setModel: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    initializationResult: vi.fn().mockResolvedValue({}),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
    rewindFiles: vi.fn().mockResolvedValue({}),
    reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
    toggleMcpServer: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn().mockResolvedValue({}),
    streamInput: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn().mockResolvedValue(undefined),
  };

  return generator as unknown as Query & {
    close: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { SidecarClient } from "../sidecar/client.js";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

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

describe("SidecarClient (v1 query API)", () => {
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
    const q = createMockQuery([
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
    vi.mocked(sdkQuery).mockReturnValue(q);

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
    const q = createMockQuery([
      { type: "assistant", message: { content: [] } },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(events.find((e) => e.method === "session.message")).toBeUndefined();
    expect(events.find((e) => e.method === "session.turnComplete")).toBeTruthy();
  });

  it("emits session.system for system events", async () => {
    const q = createMockQuery([
      { type: "system", subtype: "init" },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.system");

    const sysEvent = events.find((e) => e.method === "session.system");
    expect(sysEvent?.method === "session.system" && sysEvent.params.subtype).toBe("init");
  });

  it("emits session.toolUse for tool_use blocks in assistant message", async () => {
    const q = createMockQuery([
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
    vi.mocked(sdkQuery).mockReturnValue(q);

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
    const q = createMockQuery([
      {
        type: "tool_use",
        id: "tc2",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(sdkQuery).mockReturnValue(q);

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
    const q = createMockQuery([
      {
        type: "tool_result",
        tool_use_id: "tc1",
        content: "file contents here",
        is_error: false,
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(sdkQuery).mockReturnValue(q);

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
    const q = createMockQuery([
      {
        type: "tool_result",
        tool_use_id: "tc1",
        content: { result: "data" },
        is_error: false,
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Op", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.toolResult");

    const toolResult = events.find((e) => e.method === "session.toolResult");
    expect(toolResult?.method === "session.toolResult" && toolResult.params.output).toBe(
      JSON.stringify({ result: "data" }),
    );
  });

  it("emits session.error and session.ended when stream throws", async () => {
    const q = {
      [Symbol.asyncIterator]() { return this; },
      async next() { throw new Error("SDK crash"); },
      async return() { return { value: undefined, done: true }; },
      async throw() { return { value: undefined, done: true }; },
      close: vi.fn(),
      setModel: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      accountInfo: vi.fn().mockResolvedValue({}),
      rewindFiles: vi.fn().mockResolvedValue({}),
      reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
      toggleMcpServer: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi.fn().mockResolvedValue({}),
      streamInput: vi.fn().mockResolvedValue(undefined),
      stopTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as Query;

    vi.mocked(sdkQuery).mockReturnValue(q);

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
  // Session states
  // -------------------------------------------------------------------------

  it("calls query() on first message (resume=false, no pool entry)", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenCalledOnce();
    expect(sdkQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: "claude-sonnet-4-6",
          cwd: "/tmp",
          settingSources: ["user", "project", "local"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          tools: { type: "preset", preset: "claude_code" },
          sessionId: "abc",
        }),
      }),
    );
  });

  it("calls query() with resume option when resume=true and no pool entry", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc-def", "Hi", "/tmp", "claude-sonnet-4-6", true, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenCalledOnce();
    expect(sdkQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: "abc-def",
          model: "claude-sonnet-4-6",
        }),
      }),
    );
  });

  it("reuses existing session for second message (push to queue, no re-create)", async () => {
    const q = createMockQuery(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);

    // First message
    client.sendMessage("mcode-live", "msg1", "/tmp", "claude-sonnet-4-6", false, "default");
    await waitForEvent(events, "session.turnComplete");

    // Second message - session is in pool, should NOT call query() again
    client.sendMessage("mcode-live", "msg2", "/tmp", "claude-sonnet-4-6", false, "default");
    await new Promise((r) => setTimeout(r, 20));

    expect(sdkQuery).toHaveBeenCalledOnce(); // not twice
  });

  it("calls setModel() on model change instead of recreating", async () => {
    const q = createMockQuery(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);

    // First message with sonnet
    client.sendMessage("mcode-switch", "msg1", "/tmp", "claude-sonnet-4-6", false, "default");
    await waitForEvent(events, "session.turnComplete");

    // Second message with different model - should call setModel(), not recreate
    client.sendMessage("mcode-switch", "msg2", "/tmp", "claude-opus-4-6", false, "default");
    await new Promise((r) => setTimeout(r, 20));

    expect(sdkQuery).toHaveBeenCalledOnce(); // NOT called twice
    expect(q.setModel).toHaveBeenCalledWith("claude-opus-4-6");
  });

  it("strips 'mcode-' prefix from sessionId for SDK uuid", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc-def", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ sessionId: "abc-def" }),
      }),
    );
  });

  it("uses captured SDK session ID for subsequent resume calls", async () => {
    // First turn: query with a system init that has session_id
    const q1 = createMockQuery([
      { type: "system", subtype: "init", session_id: "sdk-real-id-999" },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(sdkQuery).mockReturnValue(q1);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc-def", "msg1", "/tmp", "claude-sonnet-4-6", false, "default");
    await waitForEvent(events, "session.ended");

    // Second turn: stream ended, pool entry deleted, so resume path is taken.
    const q2 = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q2);

    events.length = 0;
    client.sendMessage("mcode-abc-def", "msg2", "/tmp", "claude-sonnet-4-6", true, "default");
    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: "sdk-real-id-999",
        }),
      }),
    );
  });

  it("falls back to fresh query() when resume fails with 'No conversation found'", async () => {
    // First query: resume attempt that fails
    const failedQ = createMockQuery([
      {
        type: "result",
        is_error: true,
        errors: ["No conversation found for session abc-def"],
        session_id: "stale-id",
      },
    ]);
    // Second query: fresh session succeeds
    const freshQ = createMockQuery([
      { type: "system", subtype: "init", session_id: "fresh-sdk-id" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      },
      { type: "result", stop_reason: "end_turn" },
    ]);
    vi.mocked(sdkQuery)
      .mockReturnValueOnce(failedQ)
      .mockReturnValueOnce(freshQ);

    const events = collectEvents(client);
    client.sendMessage("mcode-abc-def", "Hi", "/tmp", "claude-sonnet-4-6", true, "default");

    await waitForEvent(events, "session.turnComplete");

    // Should have called query() twice: first resume, then fresh
    expect(sdkQuery).toHaveBeenCalledTimes(2);

    // First call should have resume option
    expect(vi.mocked(sdkQuery).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({ resume: "abc-def" }),
      }),
    );

    // Second call should have sessionId (not resume)
    expect(vi.mocked(sdkQuery).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({ sessionId: "abc-def" }),
      }),
    );
    // Verify resume key is NOT in fresh options
    expect(vi.mocked(sdkQuery).mock.calls[1]?.[0]?.options).not.toHaveProperty("resume");

    // Should have emitted session_restarted system event
    const restartEvent = events.find(
      (e) => e.method === "session.system" && e.params.subtype === "session_restarted",
    );
    expect(restartEvent).toBeTruthy();

    // Should have emitted the successful message
    const msgEvent = events.find((e) => e.method === "session.message");
    expect(msgEvent).toBeTruthy();
    if (msgEvent?.method === "session.message") {
      expect(msgEvent.params.content).toBe("Hello");
    }
  });

  it("passes cwd as a direct option (no process.chdir hack)", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/my/workspace", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ cwd: "/my/workspace" }),
      }),
    );
  });

  it("passes settingSources to load CLAUDE.md files", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          settingSources: ["user", "project", "local"],
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Permission mode
  // -------------------------------------------------------------------------

  it("uses bypassPermissions with allowDangerouslySkipPermissions when permissionMode is 'full'", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "full");

    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  it("uses default permissionMode for non-full modes", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.turnComplete");

    expect(sdkQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ permissionMode: "default" }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  it("stopSession calls query.close()", async () => {
    const q = createMockQuery(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-stop", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");
    await waitForEvent(events, "session.turnComplete");

    client.stopSession("mcode-stop");
    expect(q.close).toHaveBeenCalled();
  });

  it("stream loop cleans up pool entry after stream ends", async () => {
    const q = createMockQuery([{ type: "result", stop_reason: "end_turn" }]);
    vi.mocked(sdkQuery).mockReturnValue(q);

    const events = collectEvents(client);
    client.sendMessage("mcode-cleanup", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(events, "session.ended");

    const sessions = (client as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has("mcode-cleanup")).toBe(false);
  });

  it("shutdown calls close() on all active queries", async () => {
    const q1 = createMockQuery(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );
    const q2 = createMockQuery(
      [{ type: "result", stop_reason: "end_turn" }],
      { liveAfter: true },
    );

    vi.mocked(sdkQuery)
      .mockReturnValueOnce(q1)
      .mockReturnValueOnce(q2);

    const e1 = collectEvents(client);
    client.sendMessage("mcode-a", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");
    const e2 = collectEvents(client);
    client.sendMessage("mcode-b", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    await waitForEvent(e1, "session.turnComplete");
    await waitForEvent(e2, "session.turnComplete");

    client.shutdown();

    expect(q1.close).toHaveBeenCalled();
    expect(q2.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idle eviction
  // -------------------------------------------------------------------------

  it("evicts idle sessions after TTL", async () => {
    vi.useFakeTimers();

    let closeResolve: (() => void) | undefined;
    let yielded = false;
    const q = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (!yielded) {
          yielded = true;
          return { value: { type: "result", stop_reason: "end_turn" }, done: false };
        }
        await new Promise<void>((r) => { closeResolve = r; });
        return { value: undefined, done: true };
      },
      async return() {
        closeResolve?.();
        return { value: undefined, done: true };
      },
      async throw() { return { value: undefined, done: true }; },
      close: vi.fn().mockImplementation(() => { closeResolve?.(); }),
      setModel: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      accountInfo: vi.fn().mockResolvedValue({}),
      rewindFiles: vi.fn().mockResolvedValue({}),
      reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
      toggleMcpServer: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi.fn().mockResolvedValue({}),
      streamInput: vi.fn().mockResolvedValue(undefined),
      stopTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as Query & { close: ReturnType<typeof vi.fn> };

    vi.mocked(sdkQuery).mockReturnValue(q);

    client.sendMessage("mcode-evict", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    // Flush the async send and stream startup
    await Promise.resolve();
    await Promise.resolve();

    // Advance time past idle TTL (10 min) + eviction interval (1 min)
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000 + 1000);

    expect(q.close).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
