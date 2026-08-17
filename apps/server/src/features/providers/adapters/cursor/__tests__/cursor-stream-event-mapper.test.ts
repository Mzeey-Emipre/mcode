/**
 * Tests for the cursor stream-json event mapper.
 *
 * The mapper converts {@link CursorStreamEvent} objects (produced by
 * {@link CursorStreamJsonParser} from cursor-agent --print --output-format
 * stream-json output) into the {@link AgentEvent} stream the rest of mcode
 * consumes.
 *
 * Behavior parity targets — every guarantee the prior ACP mapper offered must
 * carry over so the UI is unaffected by the transport swap:
 *   - streaming text rendered as TextDelta deltas
 *   - tool_call started → ToolUse, with call_id used as toolCallId
 *   - tool_call completed → ToolResult, with isError set from result.rejected
 *     / result.failure
 *   - updateTodosToolCall is synthesized as a TodoWrite ToolUse + ToolResult
 *     pair, honoring the snapshot's `merge:true` reconciliation semantics
 *   - system/init captures the persistent chat id so the runner can resume
 *     the chat across restarts, and emits a `sdk_session_id:<id>` System event
 *     so the existing UI session-id pill keeps lighting up
 *   - result success/error events are terminal — the mapper returns [] (the
 *     runner consumes them out-of-band to resolve its turn promise)
 */

import { describe, it, expect } from "vitest";
import {
  mapCursorStreamEvent,
  createCursorStreamAccumulator,
  resolveCursorAssistantMessageContent,
  type CursorStreamAccumulator,
} from "../cursor-stream-event-mapper.js";
import { createCursorTodoSnapshot, type CursorTodoSnapshot } from "../cursor-todo-snapshot.js";
import type { CursorStreamEvent } from "../cursor-stream-json-types.js";

function freshAcc(): CursorStreamAccumulator {
  return createCursorStreamAccumulator();
}

function freshSnapshot(): CursorTodoSnapshot {
  return createCursorTodoSnapshot();
}

describe("mapCursorStreamEvent", () => {
  describe("system/init", () => {
    it("captures session_id as chatId and emits a sdk_session_id System event", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "system",
          subtype: "init",
          session_id: "chat-abc",
          model: "sonnet-4",
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(acc.chatId).toBe("chat-abc");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "system",
        threadId: "t1",
        subtype: "sdk_session_id:chat-abc",
      });
    });

    it("ignores non-init system events (no session_id capture, no emission)", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "system",
          subtype: "diagnostic",
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(acc.chatId).toBeNull();
      expect(events).toEqual([]);
    });
  });

  describe("assistant (streaming text)", () => {
    it("emits TextDelta for a chunk carrying timestamp_ms", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
          timestamp_ms: 1234,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "textDelta", threadId: "t1", delta: "hello" });
      expect(acc.assistantText).toBe("hello");
    });

    it("concatenates multiple text content blocks in a single chunk", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "foo " },
              { type: "text", text: "bar" },
            ],
          },
          timestamp_ms: 1,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ delta: "foo bar" });
      expect(acc.assistantText).toBe("foo bar");
    });

    it("ignores non-text content blocks without leaking them as deltas", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "image", data: "..." }],
          },
          timestamp_ms: 1,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
      expect(acc.assistantText).toBe("");
    });

    it("suppresses the terminal full-message echo when deltas already accumulated", () => {
      const acc = freshAcc();
      // Simulate two streaming deltas first.
      mapCursorStreamEvent(
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "He" }] },
          timestamp_ms: 1,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      mapCursorStreamEvent(
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "llo" }] },
          timestamp_ms: 2,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      // Now the terminal full message arrives without timestamp_ms.
      const events = mapCursorStreamEvent(
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
      expect(acc.assistantText).toBe("Hello");
    });

    it("accumulates assistantFinalText only after tools complete (post-tool reply)", () => {
      const acc = freshAcc();
      mapCursorStreamEvent(
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Prep " }] },
          timestamp_ms: 1,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(acc.assistantFinalText).toBe("");
      mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tc1",
          tool_call: { readToolCall: { args: { path: "/x" } } },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "tc1",
          tool_call: {
            readToolCall: {
              args: { path: "/x" },
              result: { success: {} },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      mapCursorStreamEvent(
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
          timestamp_ms: 2,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(acc.assistantText).toBe("Prep Done");
      expect(acc.assistantFinalText).toBe("Done");
      expect(resolveCursorAssistantMessageContent(acc)).toBe("Done");
    });

    it("emits the full message as a single delta when it arrives without prior deltas", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "fallback" }] },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "textDelta", delta: "fallback" });
      expect(acc.assistantText).toBe("fallback");
    });

    it("returns [] when content is missing entirely", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "assistant",
          message: { role: "assistant" },
          timestamp_ms: 1,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });
  });

  describe("user (echo)", () => {
    it("ignores user echoes (UI already has them)", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });
  });

  describe("tool_call started", () => {
    it("maps readToolCall to a ToolUse with toolName=Read and args as input", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tu_1",
          tool_call: {
            readToolCall: { args: { path: "/tmp/file.txt" } },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolUse",
        threadId: "t1",
        toolCallId: "tu_1",
        toolName: "Read",
        toolInput: { path: "/tmp/file.txt" },
      });
      expect(acc.toolStartTimes.has("tu_1")).toBe(true);
    });

    it("maps exploreWorkspaceToolCall to Agent and forwards parent_call_id", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "deleg_1",
          parent_call_id: "root_9",
          tool_call: {
            exploreWorkspaceToolCall: {
              args: { goal: "list top-level dirs" },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolUse",
        toolCallId: "deleg_1",
        toolName: "Agent",
        parentToolCallId: "root_9",
      });
      expect((events[0] as { toolInput: Record<string, unknown> }).toolInput.goal).toBe(
        "list top-level dirs",
      );
    });

    it("maps shellToolCall to a ToolUse with toolName=Bash", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tu_2",
          tool_call: {
            shellToolCall: { args: { command: "ls -la" } },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events[0]).toMatchObject({ toolName: "Bash", toolInput: { command: "ls -la" } });
    });

    it("maps editToolCall, writeToolCall, grepToolCall, globToolCall, lsToolCall, deleteToolCall to friendly names", () => {
      const cases: Array<[string, string]> = [
        ["editToolCall", "Edit"],
        ["writeToolCall", "Write"],
        ["grepToolCall", "Grep"],
        ["globToolCall", "Glob"],
        ["lsToolCall", "LS"],
        ["deleteToolCall", "Delete"],
      ];
      for (const [discriminator, expectedName] of cases) {
        const acc = freshAcc();
        const events = mapCursorStreamEvent(
          {
            type: "tool_call",
            subtype: "started",
            call_id: `id-${discriminator}`,
            tool_call: { [discriminator]: { args: {} } },
          } as CursorStreamEvent,
          "t1",
          acc,
        );
        expect(events[0]).toMatchObject({ toolName: expectedName, toolCallId: `id-${discriminator}` });
      }
    });

    it("falls back to a generic toolName for unknown discriminators (and still emits ToolUse)", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tu_x",
          tool_call: {
            futureUnknownToolCall: { args: { foo: 1 } },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolUse",
        toolCallId: "tu_x",
        toolInput: { foo: 1 },
      });
      // Tool name is the discriminator key so the UI has *something* to show.
      expect((events[0] as { toolName: string }).toolName).toBe("futureUnknownToolCall");
    });

    it("returns [] when call_id is missing", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          tool_call: { readToolCall: { args: {} } },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });

    describe("updateTodosToolCall", () => {
      it("synthesizes TodoWrite ToolUse from todos with merge:false replacing the snapshot", () => {
        const acc = freshAcc();
        const snapshot = freshSnapshot();
        // Pre-populate snapshot to verify merge:false replaces it.
        snapshot.todos.set("old", {
          id: "old",
          content: "stale",
          status: "completed",
        });
        const events = mapCursorStreamEvent(
          {
            type: "tool_call",
            subtype: "started",
            call_id: "todos_1",
            tool_call: {
              updateTodosToolCall: {
                args: {
                  merge: false,
                  todos: [
                    { id: "1", content: "first", status: "pending" },
                    { id: "2", content: "second", status: "in_progress" },
                  ],
                },
              },
            },
          } as CursorStreamEvent,
          "t1",
          acc,
          snapshot,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "toolUse",
          toolName: "TodoWrite",
          toolInput: {
            todos: [
              { id: "1", content: "first", status: "pending" },
              { id: "2", content: "second", status: "in_progress" },
            ],
          },
        });
        expect(snapshot.todos.has("old")).toBe(false);
        expect(snapshot.todos.size).toBe(2);
      });

      it("synthesizes TodoWrite ToolUse with merge:true patching existing snapshot entries by id", () => {
        const acc = freshAcc();
        const snapshot = freshSnapshot();
        snapshot.todos.set("1", { id: "1", content: "first", status: "pending" });
        snapshot.todos.set("2", { id: "2", content: "second", status: "pending" });
        const events = mapCursorStreamEvent(
          {
            type: "tool_call",
            subtype: "started",
            call_id: "todos_merge",
            tool_call: {
              updateTodosToolCall: {
                args: {
                  merge: true,
                  todos: [{ id: "1", content: "first", status: "completed" }],
                },
              },
            },
          } as CursorStreamEvent,
          "t1",
          acc,
          snapshot,
        );
        expect(events).toHaveLength(1);
        const todos = (
          events[0] as unknown as { toolInput: { todos: Array<{ id: string; status: string }> } }
        ).toolInput.todos;
        // Both entries survive; only id=1 status is patched.
        expect(todos).toHaveLength(2);
        expect(todos.find((t) => t.id === "1")?.status).toBe("completed");
        expect(todos.find((t) => t.id === "2")?.status).toBe("pending");
      });

      it("returns [] when updateTodosToolCall has no extractable entries (placeholder)", () => {
        const acc = freshAcc();
        const events = mapCursorStreamEvent(
          {
            type: "tool_call",
            subtype: "started",
            call_id: "todos_empty",
            tool_call: {
              updateTodosToolCall: { args: {} },
            },
          } as CursorStreamEvent,
          "t1",
          acc,
          freshSnapshot(),
        );
        expect(events).toEqual([]);
      });
    });
  });

  describe("tool_call completed", () => {
    it("emits ToolResult with isError=false for result.success", () => {
      const acc = freshAcc();
      // Prior started event so the toolCallId is known.
      mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tu_3",
          tool_call: { readToolCall: { args: { path: "/x" } } },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "tu_3",
          tool_call: {
            readToolCall: {
              args: { path: "/x" },
              result: { success: { contents: "hello" } },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolResult",
        threadId: "t1",
        toolCallId: "tu_3",
        isError: false,
      });
      expect((events[0] as { output: string }).output).toContain("hello");
      expect(acc.toolStartTimes.has("tu_3")).toBe(false);
    });

    it("emits ToolResult with isError=true for result.rejected (cancelled in default mode)", () => {
      const acc = freshAcc();
      mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tu_rej",
          tool_call: { shellToolCall: { args: { command: "rm -rf /" } } },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "tu_rej",
          tool_call: {
            shellToolCall: {
              result: { rejected: { reason: "user denied" } },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolResult",
        toolCallId: "tu_rej",
        isError: true,
      });
    });

    it("emits ToolResult with isError=true for result.failure", () => {
      const acc = freshAcc();
      mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "tu_fail",
          tool_call: { writeToolCall: { args: { path: "/x" } } },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "tu_fail",
          tool_call: {
            writeToolCall: {
              result: { failure: { message: "EACCES" } },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events[0]).toMatchObject({ type: "toolResult", isError: true });
      expect((events[0] as { output: string }).output).toContain("EACCES");
    });

    it("synthesizes a ToolUse when completed arrives for an unknown toolCallId (orphan recovery)", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "orphan",
          tool_call: {
            readToolCall: {
              args: { path: "/x" },
              result: { success: { contents: "ok" } },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "toolUse", toolCallId: "orphan", toolName: "Read" });
      expect(events[1]).toMatchObject({ type: "toolResult", toolCallId: "orphan", isError: false });
    });

    it("emits a ToolResult for updateTodosToolCall on completed (paired with the prior ToolUse)", () => {
      const acc = freshAcc();
      const snapshot = freshSnapshot();
      mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "todos_done",
          tool_call: {
            updateTodosToolCall: {
              args: {
                merge: false,
                todos: [{ id: "1", content: "x", status: "pending" }],
              },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
        snapshot,
      );
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "todos_done",
          tool_call: {
            updateTodosToolCall: {
              result: { success: {} },
            },
          },
        } as CursorStreamEvent,
        "t1",
        acc,
        snapshot,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "toolResult",
        toolCallId: "todos_done",
        isError: false,
      });
    });

    it("returns [] when call_id is missing on completed", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "tool_call",
          subtype: "completed",
          tool_call: { readToolCall: { result: { success: {} } } },
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });
  });

  describe("result", () => {
    it("returns [] for result success (terminal — runner consumes out of band)", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "result",
          subtype: "success",
          duration_ms: 1234,
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });

    it("returns [] for result error (runner inspects subtype itself)", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        {
          type: "result",
          subtype: "error",
        } as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });
  });

  describe("unknown event types", () => {
    it("returns [] without throwing for unknown discriminators", () => {
      const acc = freshAcc();
      const events = mapCursorStreamEvent(
        { type: "future_event_type", foo: "bar" } as unknown as CursorStreamEvent,
        "t1",
        acc,
      );
      expect(events).toEqual([]);
    });
  });
});
