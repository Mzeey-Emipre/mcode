import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SidecarEvent } from "../sidecar/types.js";

// Helper: create a mock async iterable that yields events and has setModel.
// Returns typed as ReturnType<typeof query> to avoid repeated casts at call sites.
function createMockQuery(events: Array<Record<string, unknown>>) {
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    setModel: vi.fn().mockResolvedValue(undefined),
  };
  return iterable as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SidecarClient } from "../sidecar/client.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

/** Collect all events emitted by the client. */
function collectEvents(client: SidecarClient): SidecarEvent[] {
  const events: SidecarEvent[] = [];
  client.on("event", (e: SidecarEvent) => events.push(e));
  return events;
}

describe("SidecarClient", () => {
  let client: SidecarClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = SidecarClient.start();
  });

  afterEach(() => {
    client.shutdown();
  });

  it("isReady returns true immediately", () => {
    expect(client.isReady()).toBe(true);
  });

  it("emits session.message with accumulated text on result", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockReturnValue(
      createMockQuery([
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
      ]),
    );

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

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

    const endedEvent = events.find((e) => e.method === "session.ended");
    expect(endedEvent).toBeTruthy();
  });

  it("emits session.toolUse for tool_use blocks in assistant message", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tc1", name: "Read", input: { path: "/foo" } },
            ],
          },
        },
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "Read file", "/tmp", "claude-sonnet-4-6", false, "default");

    const toolEvent = events.find((e) => e.method === "session.toolUse");
    expect(toolEvent).toBeTruthy();
    if (toolEvent?.method === "session.toolUse") {
      expect(toolEvent.params.toolName).toBe("Read");
      expect(toolEvent.params.toolCallId).toBe("tc1");
      expect(toolEvent.params.toolInput).toEqual({ path: "/foo" });
    }
  });

  it("emits session.toolUse for top-level tool_use events", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        {
          type: "tool_use",
          id: "tc2",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        },
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "List files", "/tmp", "claude-sonnet-4-6", false, "default");

    const toolEvent = events.find((e) => e.method === "session.toolUse");
    expect(toolEvent).toBeTruthy();
    if (toolEvent?.method === "session.toolUse") {
      expect(toolEvent.params.toolName).toBe("Bash");
      expect(toolEvent.params.toolCallId).toBe("tc2");
      expect(toolEvent.params.toolInput).toEqual({ command: "ls" });
    }
  });

  it("emits session.toolResult for tool_result events", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        {
          type: "tool_result",
          tool_use_id: "tc1",
          content: "file contents here",
          is_error: false,
        },
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "Read file", "/tmp", "claude-sonnet-4-6", false, "default");

    const toolResult = events.find((e) => e.method === "session.toolResult");
    expect(toolResult).toBeTruthy();
    if (toolResult?.method === "session.toolResult") {
      expect(toolResult.params.toolCallId).toBe("tc1");
      expect(toolResult.params.output).toBe("file contents here");
      expect(toolResult.params.isError).toBe(false);
    }
  });

  it("emits session.toolResult with JSON stringified content when not a string", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        {
          type: "tool_result",
          tool_use_id: "tc1",
          content: { result: "data" },
          is_error: false,
        },
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "Op", "/tmp", "claude-sonnet-4-6", false, "default");

    const toolResult = events.find((e) => e.method === "session.toolResult");
    expect(toolResult).toBeTruthy();
    if (toolResult?.method === "session.toolResult") {
      expect(toolResult.params.output).toBe(JSON.stringify({ result: "data" }));
    }
  });

  it("emits session.system for system events", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        { type: "system", subtype: "init" },
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    const sysEvent = events.find((e) => e.method === "session.system");
    expect(sysEvent).toBeTruthy();
    if (sysEvent?.method === "session.system") {
      expect(sysEvent.params.subtype).toBe("init");
    }
  });

  it("emits session.error and session.ended on SDK throw", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockImplementation(() => {
      const iter = {
        async *[Symbol.asyncIterator]() {
          throw new Error("SDK crash");
        },
        setModel: vi.fn().mockResolvedValue(undefined),
      };
      return iter as unknown as ReturnType<typeof query>;
    });

    await client.sendMessage("mcode-456", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    const errorEvent = events.find((e) => e.method === "session.error");
    expect(errorEvent).toBeTruthy();
    if (errorEvent?.method === "session.error") {
      expect(errorEvent.params.error).toBe("SDK crash");
      expect(errorEvent.params.sessionId).toBe("mcode-456");
    }

    expect(events.some((e) => e.method === "session.ended")).toBe(true);
  });

  it("emits session.error with stringified message for non-Error throws", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockImplementation(() => {
      const iter = {
        async *[Symbol.asyncIterator]() {
          throw "string error";
        },
        setModel: vi.fn().mockResolvedValue(undefined),
      };
      return iter as unknown as ReturnType<typeof query>;
    });

    await client.sendMessage("mcode-789", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    const errorEvent = events.find((e) => e.method === "session.error");
    expect(errorEvent).toBeTruthy();
    if (errorEvent?.method === "session.error") {
      expect(errorEvent.params.error).toBe("string error");
    }
  });

  it("does not emit session.message when no text was accumulated", async () => {
    const events = collectEvents(client);

    vi.mocked(query).mockReturnValue(
      createMockQuery([
        {
          type: "assistant",
          message: { content: [] },
        },
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    const messageEvent = events.find((e) => e.method === "session.message");
    expect(messageEvent).toBeUndefined();

    // turnComplete should still be emitted
    const turnEvent = events.find((e) => e.method === "session.turnComplete");
    expect(turnEvent).toBeTruthy();
  });

  it("calls setModel when resuming a session", async () => {
    const mockIterable = createMockQuery([
      { type: "result", stop_reason: "end_turn" },
    ]);

    vi.mocked(query).mockReturnValue(mockIterable as unknown as ReturnType<typeof query>);

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", true, "default");

    expect(mockIterable.setModel).toHaveBeenCalledWith("claude-sonnet-4-6");
  });

  it("does not call setModel when not resuming", async () => {
    const mockIterable = createMockQuery([
      { type: "result", stop_reason: "end_turn" },
    ]);

    vi.mocked(query).mockReturnValue(mockIterable as unknown as ReturnType<typeof query>);

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    expect(mockIterable.setModel).not.toHaveBeenCalled();
  });

  it("shutdown clears sessions and keeps client usable", () => {
    const sessionsMap = (client as unknown as { sessions: Map<string, AbortController> }).sessions;
    // Manually add a session to verify it gets cleared
    sessionsMap.set("test-session", new AbortController());

    client.shutdown();

    expect(sessionsMap.size).toBe(0);
    expect(client.isReady()).toBe(true);
  });

  it("stopSession aborts a specific session", async () => {
    // Use event-driven synchronization instead of setTimeout
    let sessionRegistered: () => void;
    const sessionReady = new Promise<void>((r) => { sessionRegistered = r; });
    let resolveWait: (() => void) | undefined;

    vi.mocked(query).mockImplementation(() => {
      const iter = {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init" };
          // Signal that the session is registered and first event yielded
          sessionRegistered();
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        },
        setModel: vi.fn().mockResolvedValue(undefined),
      };
      return iter as unknown as ReturnType<typeof query>;
    });

    const sendPromise = client.sendMessage("mcode-stop", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    // Wait for the session to register deterministically
    await sessionReady;

    client.stopSession("mcode-stop");
    resolveWait?.();

    await sendPromise;
  });

  it("duplicate session ID aborts the previous session", async () => {
    let firstSessionReady: () => void;
    const firstReady = new Promise<void>((r) => { firstSessionReady = r; });
    let callCount = 0;

    vi.mocked(query).mockImplementation((args: unknown) => {
      const ac = (args as { options?: { abortController?: AbortController } })
        .options?.abortController;
      const currentCall = ++callCount;
      const iter = {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init" };
          if (currentCall === 1) firstSessionReady();
          // Wait until aborted - uses the abort signal for deterministic unblocking
          await new Promise<void>((resolve) => {
            if (ac?.signal.aborted) { resolve(); return; }
            ac?.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        setModel: vi.fn().mockResolvedValue(undefined),
      };
      return iter as unknown as ReturnType<typeof query>;
    });

    const p1 = client.sendMessage("mcode-dup", "msg1", "/tmp", "claude-sonnet-4-6", false, "default");

    // Wait for the first session to register deterministically
    await firstReady;

    const sessionsMap = (client as unknown as { sessions: Map<string, AbortController> }).sessions;
    const firstController = sessionsMap.get("mcode-dup");
    expect(firstController).toBeTruthy();

    const abortSpy = vi.spyOn(firstController!, "abort");

    // Start second session with same ID - should abort first
    const p2 = client.sendMessage("mcode-dup", "msg2", "/tmp", "claude-sonnet-4-6", false, "default");

    expect(abortSpy).toHaveBeenCalled();

    // Clean up: stop the second session and wait for both to settle
    client.stopSession("mcode-dup");
    await Promise.allSettled([p1, p2]);
  });

  it("strips 'mcode-' prefix from sessionId for SDK uuid", async () => {
    vi.mocked(query).mockReturnValue(
      createMockQuery([
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-abc-def", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hi",
        options: expect.objectContaining({
          sessionId: "abc-def",
        }),
      }),
    );
  });

  it("passes resume uuid instead of sessionId when resume=true", async () => {
    vi.mocked(query).mockReturnValue(
      createMockQuery([
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-abc-def", "Hi", "/tmp", "claude-sonnet-4-6", true, "default");

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hi",
        options: expect.objectContaining({
          resume: "abc-def",
        }),
      }),
    );

    // Should NOT have sessionId when resuming
    const callArgs = vi.mocked(query).mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(callArgs.options).not.toHaveProperty("sessionId");
  });

  it("uses bypassPermissions when permissionMode is 'full'", async () => {
    vi.mocked(query).mockReturnValue(
      createMockQuery([
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "full");

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  it("uses default permissionMode for non-full modes", async () => {
    vi.mocked(query).mockReturnValue(
      createMockQuery([
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-123", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "default",
        }),
      }),
    );

    const callArgs = vi.mocked(query).mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(callArgs.options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("session cleanup removes session from map in finally block", async () => {
    vi.mocked(query).mockReturnValue(
      createMockQuery([
        { type: "result", stop_reason: "end_turn" },
      ]),
    );

    await client.sendMessage("mcode-cleanup", "Hi", "/tmp", "claude-sonnet-4-6", false, "default");

    const sessionsMap = (client as unknown as { sessions: Map<string, AbortController> }).sessions;
    expect(sessionsMap.has("mcode-cleanup")).toBe(false);
  });
});
