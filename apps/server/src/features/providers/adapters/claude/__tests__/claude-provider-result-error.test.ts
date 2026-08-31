import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

import { ClaudeProvider } from "../claude-provider.js";
import { stubEnvService } from "../../../../../runtime/environment/__tests__/stub-env-service.js";
import { stubJobObject } from "../../../../../runtime/process/containment/__tests__/stub-job-object.js";
import { queryMethodStubs } from "./helpers/mock-sdk-query.js";
import { AgentEventType, type ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderEventBatch, ProviderHostPorts } from "@mcode/providers";

/** Build a minimal mock Query that yields one non-result message (so sessionInitialized=true), then the requested result. */
function mockSdkStream(results: Array<Record<string, unknown>>) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const iterator = prompt[Symbol.asyncIterator]();
    const queue = [
      { type: "system", subtype: "init", session_id: "sdk-abc" },
      ...results,
    ];
    let i = 0;
    const gen: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (i === 0) await iterator.next(); // consume first user message
        if (i < queue.length) return { value: queue[i++], done: false };
        return { value: undefined as never, done: true };
      },
      async return() { return { value: undefined as never, done: true }; },
      async throw(e: unknown) { throw e; },
      [Symbol.asyncIterator]() { return this; },
    };
    return Object.assign(gen, {
      ...queryMethodStubs(),
      close: vi.fn(),
    });
  };
}

describe("ClaudeProvider result is_error handling (#293)", () => {
  let provider: ClaudeProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
  });

  afterEach(() => {
    provider.shutdown();
  });

  it("emits Error event and NO TurnComplete when result.is_error is true", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: true, errors: ["rate_limit_exceeded"] },
    ]));

    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent));

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-1",
      threadId: "thread-1",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });

    // Allow the stream loop microtasks to drain
    await new Promise((r) => setTimeout(r, 10));

    const errorEvents = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error);
    const turnComplete = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TurnComplete);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.event.error).toContain("rate_limit_exceeded");
    expect(turnComplete).toHaveLength(0);
    const ended = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended);
    expect(ended).toHaveLength(1);
  });

  it("serializes the full result message when an error result has no result field", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: true },
    ]));
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent));

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-error-without-result",
      threadId: "thread-error-without-result",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const error = events.find((event) => event.event.type === AgentEventType.Error);
    expect(error?.event.error).toContain('"is_error":true');
    expect(events.filter((event) => event.event.type === AgentEventType.Ended)).toHaveLength(1);
  });

  it("serializes the full result message when an error result is null", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: true, result: null },
    ]));
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent));

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-null-result",
      threadId: "thread-null-result",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const error = events.find((event) => event.event.type === AgentEventType.Error);
    expect(error?.event.error).toContain('"result":null');
    expect(events.filter((event) => event.event.type === AgentEventType.Ended)).toHaveLength(1);
  });

  it("uses the generic fallback when an error result is an empty string", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: true, errors: [], result: "" },
    ]));
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent));

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-empty-result",
      threadId: "thread-empty-result",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const error = events.find((event) => event.event.type === AgentEventType.Error);
    expect(error?.event.error).toBe("Claude SDK returned an error result");
    expect(events.filter((event) => event.event.type === AgentEventType.Ended)).toHaveLength(1);
  });

  it("uses the result-error fallback when serializing the SDK message throws", async () => {
    const circular: Record<string, unknown> = { type: "result", is_error: true };
    circular.result = circular;
    mockQuery.mockImplementation(mockSdkStream([circular]));
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent));

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-circular-result",
      threadId: "thread-circular-result",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const errors = events.filter((event) => event.event.type === AgentEventType.Error);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event.error).toBe("Claude SDK returned an error result");
    expect(events.some((event) => event.event.type === AgentEventType.TurnComplete)).toBe(false);
    expect(events.filter((event) => event.event.type === AgentEventType.Ended)).toHaveLength(1);
  });

  it("emits TurnComplete (not Error) for a successful result", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: false, result: "ok", usage: {}, modelUsage: {} },
    ]));

    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent));

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-2",
      threadId: "thread-2",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(false);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TurnComplete)).toBe(true);
  });

  it("emits Error (not Message/TurnComplete) when is_error arrives after assistant text", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "assistant", message: { content: [{ type: "text", text: "partial thought" }] } },
      { type: "result", is_error: true, errors: ["api_overload"] },
    ]));

    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent));

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-3",
      threadId: "thread-3",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(true);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.TurnComplete)).toBe(false);
    // Partial assistant text is dropped because the result errored out
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Message)).toBe(false);
  });

  it("submits Claude terminal evidence through the canonical host without direct EventEmitter delivery", async () => {
    const submit = vi.fn<(batch: ProviderEventBatch) => Promise<void>>().mockResolvedValue(undefined);
    provider = new ClaudeProvider(
      stubEnvService(),
      stubJobObject(),
      undefined,
      undefined,
      undefined,
      {
        runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
        events: { submit },
      } as ProviderHostPorts,
    );
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: true, errors: ["rate_limit_exceeded"] },
    ]));
    const directEvents = vi.fn();
    provider.on("event", directEvents);

    await provider.sendTurn({
      turnId: "turn-4",
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-4",
      workspaceId: "workspace-1",
      threadId: "thread-4",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });

    await vi.waitFor(() => expect(submit.mock.calls.flatMap(([batch]) => batch.events)
      .some((event) => event.payload.type === "item.recorded"
        && event.payload.item.payload.runtimeEvent.event.type === AgentEventType.Error)).toBe(true));
    const submittedEvents = submit.mock.calls.flatMap(([batch]) => batch.events)
      .map((event) => event.payload.type === "item.recorded" ? event.payload.item.payload.runtimeEvent.event : undefined);

    expect(directEvents).not.toHaveBeenCalled();
    expect(submittedEvents).toContainEqual(expect.objectContaining({
      type: AgentEventType.Error,
      error: "rate_limit_exceeded",
      turnExecutionId: "test-execution",
    }));
    expect(submittedEvents).not.toContainEqual(expect.objectContaining({ type: AgentEventType.TurnComplete }));
  });
});
