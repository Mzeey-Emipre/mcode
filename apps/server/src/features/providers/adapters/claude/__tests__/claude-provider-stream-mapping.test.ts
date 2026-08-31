import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEventType, type ProviderRuntimeEvent } from "@mcode/contracts";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcode/shared")>()),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ClaudeProvider } from "../claude-provider.js";
import { stubEnvService } from "../../../../../runtime/environment/__tests__/stub-env-service.js";
import { stubJobObject } from "../../../../../runtime/process/containment/__tests__/stub-job-object.js";
import { mockProviderHost, queryMethodStubs } from "./helpers/mock-sdk-query.js";

function sdkStream(messages: Array<Record<string, unknown>>) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const prompts = prompt[Symbol.asyncIterator]();
    let index = 0;
    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (index++ === 0) await prompts.next();
        return index <= messages.length
          ? { value: messages[index - 1]!, done: false }
          : { value: undefined as never, done: true };
      },
      async return() {
        return { value: undefined as never, done: true };
      },
      async throw(error: unknown) {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return Object.assign(generator, { ...queryMethodStubs(), close: vi.fn() });
  };
}

function failingStream(message: string) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const prompts = prompt[Symbol.asyncIterator]();
    let initialized = false;
    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (!initialized) {
          initialized = true;
          await prompts.next();
          return {
            value: {
              type: "system",
              subtype: "init",
              session_id: "sdk-stream",
            },
            done: false,
          };
        }
        throw new Error(message);
      },
      async return() {
        return { value: undefined as never, done: true };
      },
      async throw(error: unknown) {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return Object.assign(generator, { ...queryMethodStubs(), close: vi.fn() });
  };
}

async function send(
  provider: ClaudeProvider,
  sessionId: string,
  resumeFrom?: string,
): Promise<void> {
  await provider.sendTurn({
    turnExecutionId: "execution",
    sessionId,
    threadId: sessionId.slice(6),
    message: "go",
    cwd: "/tmp",
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    interactionMode: "build",
    providerOptions: {},
    ...(resumeFrom ? { resumeFrom } : {}),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("ClaudeProvider stream mapping", () => {
  let provider: ClaudeProvider | undefined;

  afterEach(() => provider?.shutdown());

  it("preserves parent_tool_use_id for assistant blocks and standalone tool messages", async () => {
    mockQuery.mockImplementation(
      sdkStream([
        { type: "system", subtype: "init", session_id: "sdk-parent" },
        {
          type: "assistant",
          parent_tool_use_id: "agent-one",
          message: {
            content: [
              { type: "tool_use", id: "child-one", name: "Read", input: {} },
            ],
          },
        },
        {
          type: "tool_use",
          parent_tool_use_id: "agent-two",
          id: "child-two",
          tool_name: "Bash",
          tool_input: {},
        },
        { type: "result", is_error: false, usage: {}, modelUsage: {} },
      ]),
    );
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await send(provider, "mcode-parent-ids");

    expect(
      events
        .filter((event) => event.event.type === AgentEventType.ToolUse)
        .map((event) => [event.event.toolCallId, event.event.parentToolCallId]),
    ).toEqual([
      ["child-one", "agent-one"],
      ["child-two", "agent-two"],
    ]);
  });

  it.each([
    "stream disconnected",
    "process exited with code 1",
    "stream timeout",
  ])("publishes Error before Ended after %s", async (failure) => {
    mockQuery.mockImplementation(failingStream(failure));
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await send(provider, `mcode-${failure.replaceAll(" ", "-")}`);

    const errorIndex = events.findIndex(
      (event) => event.event.type === AgentEventType.Error,
    );
    const endedIndex = events.findIndex(
      (event) => event.event.type === AgentEventType.Ended,
    );
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(endedIndex).toBeGreaterThan(errorIndex);
  });

  it.each(["__proto__", "constructor", "toString"])(
    "keeps exactly one terminal sequence after unsafe native dispatch %s",
    async (unsafeValue) => {
      mockQuery.mockImplementation(
        sdkStream([
          { type: "system", subtype: "init", session_id: "sdk-safe" },
          { type: unsafeValue },
          { type: "system", subtype: unsafeValue },
          { type: "result", is_error: false, usage: {}, modelUsage: {} },
        ]),
      );
      const events: ProviderRuntimeEvent[] = [];
      provider = new ClaudeProvider(
        stubEnvService(),
        stubJobObject(),
        undefined,
        undefined,
        undefined,
        mockProviderHost((event) => events.push(event)),
      );

      await send(provider, `mcode-unsafe-${unsafeValue}`);

      expect(
        events.filter((event) => event.event.type === AgentEventType.Error),
      ).toHaveLength(0);
      expect(
        events.filter((event) => event.event.type === AgentEventType.TurnComplete),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event.type === AgentEventType.Ended),
      ).toHaveLength(1);
    },
  );

  it("emits synthetic TurnStarted before the No conversation resume recovery", async () => {
    mockQuery
      .mockImplementationOnce(
        sdkStream([
          {
            type: "result",
            is_error: true,
            errors: ["No conversation found with session ID: previous-sdk"],
          },
        ]),
      )
      .mockImplementationOnce(
        sdkStream([
          { type: "system", subtype: "init", session_id: "fresh-sdk" },
          { type: "result", is_error: false, usage: {}, modelUsage: {} },
        ]),
      );
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const priorQueryCalls = mockQuery.mock.calls.length;

    await send(provider, "mcode-resume-order", "previous-sdk");
    await vi.waitFor(() =>
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(
        priorQueryCalls + 2,
      ),
    );

    const startedIndex = events.findIndex(
      (event) => event.event.type === AgentEventType.TurnStarted,
    );
    const restartedIndex = events.findIndex(
      (event) =>
        event.event.type === AgentEventType.System &&
        event.event.subtype === "session_restarted",
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(restartedIndex).toBeGreaterThan(startedIndex);
  });
});
