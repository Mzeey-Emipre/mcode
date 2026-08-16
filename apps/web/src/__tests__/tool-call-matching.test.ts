import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestThreadToolCalls,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Tool Call Matching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "thread-1" })] });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      records: new Map<string, ThreadRecord>([
        ["thread-1", createEmptyThreadRecord()],
      ]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tool result with matching ID completes the correct tool call", () => {
    // Set up two pending tool calls
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc2", output: "done", isError: true, exitCode: 1 } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].isComplete).toBe(false); // tc1 untouched
    expect(calls[1].isComplete).toBe(true);
    expect(calls[1].output).toBe("done");
    expect(calls[1].exitCode).toBe(1);
  });

  it("tool result with non-matching ID falls back to first incomplete", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "unknown-id", output: "result", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].isComplete).toBe(true);
    expect(calls[0].output).toBe("result");
    // Second incomplete call should be untouched
    expect(calls[1].isComplete).toBe(false);
    expect(calls[1].output).toBeNull();
  });

  it("multiple concurrent tool calls resolve independently by ID", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "tc3", toolName: "Bash", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    // Resolve out of order
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc3", output: "third", isError: false } satisfies AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc1", output: "first", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].output).toBe("first");
    expect(calls[1].isComplete).toBe(false);
    expect(calls[2].output).toBe("third");
  });

  it("all tool calls already complete: fallback does nothing", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: "done", isError: false, isComplete: true },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "unknown", output: "extra", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    // Original output preserved
    expect(calls[0].output).toBe("done");
  });

  it("out-of-order results don't overwrite completed calls", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "tc1", toolName: "Read", toolInput: {}, output: "first-result", isError: false, isComplete: true },
              { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "tc2", output: "second-result", isError: false } satisfies AgentEvent);
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls[0].output).toBe("first-result"); // preserved
    expect(calls[1].output).toBe("second-result"); // newly completed
  });

  it("tool result merges late metadata into the matching tool input", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              {
                id: "agent-1",
                toolName: "Agent",
                toolInput: {
                  codexCollabKind: "spawnAgent",
                  description: "Inspect mapper tests",
                },
                output: null,
                isError: false,
                isComplete: false,
              },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "toolResult", threadId: "thread-1", toolCallId: "agent-1",
        output: "done",
        isError: false,
        toolInput: {
          model: "gpt-5.5",
          reasoningEffort: "high",
        }, } satisfies AgentEvent);
    vi.runAllTimers();

    const [call] = getTestThreadToolCalls("thread-1");
    expect(call.isComplete).toBe(true);
    expect(call.output).toBe("done");
    expect(call.toolInput).toEqual({
      codexCollabKind: "spawnAgent",
      description: "Inspect mapper tests",
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
  });
});
