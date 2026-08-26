/**
 * Package-private Provider regression coverage.
 * Tests for the shared cursor todo snapshot module.
 *
 * The module is consumed by both the legacy ACP mapper (during transition)
 * and the new stream-json mapper, so we test the public API surface in
 * isolation rather than through either transport.
 */

import { describe, it, expect } from "vitest";
import {
  coercePlanStatus,
  createCursorTodoSnapshot,
  reconcileCursorTodos,
  extractCursorTodoEntries,
  normalizeCursorTodoEntry,
  isCursorUpdateTodosTool,
  buildTodoWriteEvents,
  cursorUpdateTodosExtNotificationToAgentEvents,
} from "../cursor-todo-snapshot.js";
import type { NormalizedCursorTodo } from "../cursor-todo-snapshot.js";
import { AgentEventType } from "@mcode/contracts";

describe("coercePlanStatus", () => {
  it("returns the canonical status for known values", () => {
    expect(coercePlanStatus("pending")).toBe("pending");
    expect(coercePlanStatus("in_progress")).toBe("in_progress");
    expect(coercePlanStatus("inProgress")).toBe("in_progress");
    expect(coercePlanStatus("in-progress")).toBe("in_progress");
    expect(coercePlanStatus("completed")).toBe("completed");
    expect(coercePlanStatus("cancelled")).toBe("cancelled");
  });

  it("normalizes the American 'canceled' spelling to 'cancelled'", () => {
    expect(coercePlanStatus("canceled")).toBe("cancelled");
  });

  it("falls back to 'pending' for unknown or non-string input", () => {
    expect(coercePlanStatus(undefined)).toBe("pending");
    expect(coercePlanStatus(null)).toBe("pending");
    expect(coercePlanStatus(42)).toBe("pending");
    expect(coercePlanStatus("done")).toBe("pending");
  });
});

describe("createCursorTodoSnapshot", () => {
  it("returns a fresh snapshot with an empty Map", () => {
    const snap = createCursorTodoSnapshot();
    expect(snap.todos).toBeInstanceOf(Map);
    expect(snap.todos.size).toBe(0);
  });

  it("returns a distinct Map per call (snapshots do not share state)", () => {
    const a = createCursorTodoSnapshot();
    const b = createCursorTodoSnapshot();
    a.todos.set("1", { id: "1", content: "x", status: "pending" });
    expect(b.todos.size).toBe(0);
  });
});

describe("reconcileCursorTodos", () => {
  const todo = (id: string, status: NormalizedCursorTodo["status"], content = id): NormalizedCursorTodo => ({
    id,
    content,
    status,
  });

  it("replaces the snapshot entirely when merge=false", () => {
    const snap = createCursorTodoSnapshot();
    snap.todos.set("a", todo("a", "completed"));
    const result = reconcileCursorTodos([todo("b", "pending")], false, snap);
    expect(result).toEqual([todo("b", "pending")]);
    expect(snap.todos.size).toBe(1);
    expect(snap.todos.get("a")).toBeUndefined();
  });

  it("patches existing entries by id when merge=true and preserves the rest", () => {
    const snap = createCursorTodoSnapshot();
    snap.todos.set("a", todo("a", "pending", "first"));
    snap.todos.set("b", todo("b", "pending", "second"));
    const result = reconcileCursorTodos([todo("a", "completed", "first")], true, snap);
    expect(result).toEqual([
      { id: "a", content: "first", status: "completed" },
      { id: "b", content: "second", status: "pending" },
    ]);
  });

  it("appends new ids in the order they arrive when merge=true", () => {
    const snap = createCursorTodoSnapshot();
    snap.todos.set("a", todo("a", "pending"));
    const result = reconcileCursorTodos([todo("b", "pending"), todo("c", "pending")], true, snap);
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("treats missing snapshot as 'always replace'", () => {
    const incoming = [todo("a", "pending")];
    const result = reconcileCursorTodos(incoming, true, undefined);
    expect(result).toEqual(incoming);
  });
});

describe("extractCursorTodoEntries", () => {
  it("returns the array under any known collection key", () => {
    const entries = [{ id: "1", content: "x", status: "pending" }];
    expect(extractCursorTodoEntries({ todos: entries })).toEqual(entries);
    expect(extractCursorTodoEntries({ items: entries })).toEqual(entries);
    expect(extractCursorTodoEntries({ tasks: entries })).toEqual(entries);
  });

  it("descends into known wrapper keys", () => {
    const entries = [{ id: "1", content: "x", status: "pending" }];
    expect(extractCursorTodoEntries({ _params: { todos: entries } })).toEqual(entries);
    expect(extractCursorTodoEntries({ args: { items: entries } })).toEqual(entries);
  });

  it("returns null for empty arrays, non-object entries, or absent collection", () => {
    expect(extractCursorTodoEntries({ todos: [] })).toBeNull();
    expect(extractCursorTodoEntries({ todos: ["foo", "bar"] })).toBeNull();
    expect(extractCursorTodoEntries({ unrelated: 42 })).toBeNull();
    expect(extractCursorTodoEntries(undefined)).toBeNull();
  });
});

describe("normalizeCursorTodoEntry", () => {
  it("uses id when present, falls back to 1-indexed position otherwise", () => {
    expect(normalizeCursorTodoEntry({ content: "x", status: "pending" }, 0).id).toBe("1");
    expect(normalizeCursorTodoEntry({ id: "abc", content: "x", status: "pending" }, 0).id).toBe("abc");
  });

  it("prefers content, then title, then text, then step, then description for the body field", () => {
    expect(normalizeCursorTodoEntry({ id: "1", content: "c" }, 0).content).toBe("c");
    expect(normalizeCursorTodoEntry({ id: "1", title: "t" }, 0).content).toBe("t");
    expect(normalizeCursorTodoEntry({ id: "1", text: "x" }, 0).content).toBe("x");
    expect(normalizeCursorTodoEntry({ id: "1", step: "s" }, 0).content).toBe("s");
    expect(normalizeCursorTodoEntry({ id: "1", description: "d" }, 0).content).toBe("d");
    expect(normalizeCursorTodoEntry({ id: "1" }, 0).content).toBe("");
  });

  it("forwards priority when present, omits it otherwise", () => {
    const withPriority = normalizeCursorTodoEntry({ id: "1", content: "c", priority: "high" }, 0);
    expect(withPriority.priority).toBe("high");
    const withoutPriority = normalizeCursorTodoEntry({ id: "1", content: "c" }, 0);
    expect(withoutPriority.priority).toBeUndefined();
  });
});

describe("isCursorUpdateTodosTool", () => {
  it("matches when rawInput._toolName is 'updateTodos'", () => {
    expect(isCursorUpdateTodosTool({ _toolName: "updateTodos" }, "anything", "")).toBe(true);
  });

  it("matches when kind is 'updateTodos'", () => {
    expect(isCursorUpdateTodosTool(undefined, "anything", "updateTodos")).toBe(true);
  });

  it("matches when title is fuzzy-equivalent to 'update todos'", () => {
    expect(isCursorUpdateTodosTool(undefined, "Update TODOs", "")).toBe(true);
    expect(isCursorUpdateTodosTool(undefined, " update todos ", "")).toBe(true);
  });

  it("does not match unrelated tools", () => {
    expect(isCursorUpdateTodosTool({ _toolName: "shell" }, "Run command", "shell")).toBe(false);
    expect(isCursorUpdateTodosTool(undefined, "Read file", "read")).toBe(false);
  });
});

describe("buildTodoWriteEvents", () => {
  it("emits a paired ToolUse + ToolResult with the exact todo list", () => {
    const todos: NormalizedCursorTodo[] = [
      { id: "1", content: "first", status: "pending" },
      { id: "2", content: "second", status: "completed" },
    ];
    const events = buildTodoWriteEvents(todos, "thread-abc");
    expect(events).toHaveLength(2);

    const [use, result] = events;
    expect(use.type).toBe(AgentEventType.ToolUse);
    if (use.type !== AgentEventType.ToolUse) throw new Error("unreachable");
    expect(use.threadId).toBe("thread-abc");
    expect(use.toolName).toBe("TodoWrite");
    expect(use.toolInput).toEqual({ todos });

    expect(result.type).toBe(AgentEventType.ToolResult);
    if (result.type !== AgentEventType.ToolResult) throw new Error("unreachable");
    expect(result.threadId).toBe("thread-abc");
    expect(result.toolCallId).toBe(use.toolCallId);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("2");
  });

  it("uses a deterministic prefix for the toolCallId so it can be correlated in logs", () => {
    const events = buildTodoWriteEvents([{ id: "1", content: "x", status: "pending" }], "t");
    if (events[0].type !== AgentEventType.ToolUse) throw new Error("unreachable");
    expect(events[0].toolCallId.startsWith("cursor-todos-")).toBe(true);
  });
});

describe("cursorUpdateTodosExtNotificationToAgentEvents", () => {
  it("emits TodoWrite + ToolResult and applies merge semantics to snapshot", () => {
    const snap = createCursorTodoSnapshot();
    snap.todos.set("a", { id: "a", content: "old", status: "pending" });
    const events = cursorUpdateTodosExtNotificationToAgentEvents(
      "t1",
      {
        toolCallId: "todo-ext-1",
        merge: true,
        todos: [{ id: "a", content: "new", status: "completed" }],
      },
      snap,
    );
    expect(events).toHaveLength(2);
    const use = events[0];
    expect(use?.type).toBe(AgentEventType.ToolUse);
    if (!use || use.type !== AgentEventType.ToolUse) throw new Error("unreachable");
    expect(use.toolName).toBe("TodoWrite");
    expect(use.toolCallId).toBe("todo-ext-1");
    expect(use.toolInput).toMatchObject({
      todos: [{ id: "a", content: "new", status: "completed" }],
    });
    expect(events[1]?.type).toBe(AgentEventType.ToolResult);
  });

  it("returns empty array when todos missing", () => {
    expect(
      cursorUpdateTodosExtNotificationToAgentEvents(
        "t",
        { toolCallId: "x", merge: false, todos: [] },
        createCursorTodoSnapshot(),
      ).length,
    ).toBe(0);
  });
});
