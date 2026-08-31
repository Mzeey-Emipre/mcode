/**
 * @internal
 * Shared cursor TodoWrite reconciliation primitives.
 *
 * Cursor's `updateTodos` payloads arrive in heterogeneous shapes — through
 * the legacy ACP `cursor/update_todos` server request, through inline
 * `tool_call` notifications carrying the entries on `rawInput`, and through
 * the new stream-json `updateTodosToolCall` event. They all share the same
 * spec semantics (`merge: true` patches by id, `merge: false` replaces),
 * so the per-thread snapshot lives here and both transports import from
 * one source of truth.
 */

import * as NodeCrypto from "node:crypto";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";

/** Normalized todo shape, matching threadStore's TodoWrite interception contract. */
export interface NormalizedCursorTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: string;
}

/**
 * Per-thread todo snapshot, persisted across prompts so cursor's
 * `merge: true` invocations can patch by id without losing items the
 * agent omitted from the partial list.
 *
 * Insertion order is preserved through `Map` iteration, so the on-screen
 * task order remains stable across patches.
 */
export interface CursorTodoSnapshot {
  todos: Map<string, NormalizedCursorTodo>;
}

/** Factory for a fresh per-thread todo snapshot. */
export function createCursorTodoSnapshot(): CursorTodoSnapshot {
  return { todos: new Map() };
}

/** Coerce an arbitrary status field to a TodoWrite-compatible status. */
export function coercePlanStatus(
  s: unknown,
): "pending" | "in_progress" | "completed" | "cancelled" {
  if (s === "in_progress" || s === "inProgress" || s === "in-progress") return "in_progress";
  if (s === "completed") return "completed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "pending";
}

/** Keys we have observed cursor-agent using to ship the todo collection. */
const TODO_COLLECTION_KEYS = ["todos", "items", "entries", "list", "tasks"] as const;

/** Wrapper keys cursor-agent occasionally nests the real arguments under. */
const TODO_NESTED_WRAPPERS = ["_params", "params", "args", "input", "arguments"] as const;

/** Safely extract a string field from an untyped record. */
function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Extracts a todo-collection array from a raw cursor `updateTodos` payload.
 *
 * The actual entries can land under several keys (`todos`, `items`, …) and
 * may be nested one level deep under `_params` / `args`. We probe both
 * layers and return the first array found whose entries are objects (so
 * we don't mis-pick a keyword list).
 */
export function extractCursorTodoEntries(
  rawInput: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | null {
  if (!rawInput) return null;

  const probe = (obj: Record<string, unknown>): Array<Record<string, unknown>> | null => {
    for (const key of TODO_COLLECTION_KEYS) {
      const v = obj[key];
      if (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => typeof x === "object" && x !== null && !Array.isArray(x))
      ) {
        return v as Array<Record<string, unknown>>;
      }
    }
    return null;
  };

  const top = probe(rawInput);
  if (top) return top;

  for (const wrapper of TODO_NESTED_WRAPPERS) {
    const inner = rawInput[wrapper];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const nested = probe(inner as Record<string, unknown>);
      if (nested) return nested;
    }
  }

  return null;
}

/**
 * Normalizes a heterogeneous cursor todo entry into the shape that
 * threadStore's TodoWrite interception expects.
 */
export function normalizeCursorTodoEntry(
  entry: Record<string, unknown>,
  index: number,
): NormalizedCursorTodo {
  const todo: NormalizedCursorTodo = {
    id: stringField(entry, "id") ?? String(index + 1),
    content:
      stringField(entry, "content") ??
      stringField(entry, "title") ??
      stringField(entry, "text") ??
      stringField(entry, "step") ??
      stringField(entry, "description") ??
      "",
    status: coercePlanStatus(entry.status),
  };
  const priority = stringField(entry, "priority");
  if (priority) todo.priority = priority;
  return todo;
}

/**
 * True when a cursor `tool_call` looks like the internal `updateTodos` tool.
 *
 * Cursor wraps it as `rawInput._toolName === "updateTodos"`; we also accept
 * a fuzzy title match (`Update TODOs`) as a fallback in case the wrapper
 * field is renamed in a future cursor-agent release.
 */
export function isCursorUpdateTodosTool(
  rawInput: Record<string, unknown> | undefined,
  title: string,
  kind: string,
): boolean {
  if (rawInput && typeof rawInput._toolName === "string" && rawInput._toolName === "updateTodos") {
    return true;
  }
  if (kind === "updateTodos") return true;
  if (/^update\s*todos$/i.test(title.trim())) return true;
  return false;
}

/**
 * Reconciles an incoming `updateTodos` payload against the per-thread
 * snapshot, honoring the `merge` flag.
 *
 * - `merge: false` (or absent) → snapshot is replaced by `incoming`.
 * - `merge: true` → existing entries are patched (status/content/priority
 *   from `incoming` win when provided), new ids are appended in order, and
 *   ids absent from `incoming` are left untouched.
 *
 * If no snapshot is supplied (legacy callers, tests), behavior degrades
 * gracefully to "always replace" by returning `incoming` as-is.
 */
export function reconcileCursorTodos(
  incoming: NormalizedCursorTodo[],
  merge: boolean,
  snapshot: CursorTodoSnapshot | undefined,
): NormalizedCursorTodo[] {
  if (!snapshot) return incoming;

  if (!merge) {
    snapshot.todos.clear();
    for (const t of incoming) snapshot.todos.set(t.id, t);
    return Array.from(snapshot.todos.values());
  }

  for (const t of incoming) {
    const existing = snapshot.todos.get(t.id);
    if (existing) {
      const merged: NormalizedCursorTodo = {
        id: existing.id,
        content: t.content || existing.content,
        status: t.status,
      };
      const priority = t.priority ?? existing.priority;
      if (priority) merged.priority = priority;
      snapshot.todos.set(t.id, merged);
    } else {
      snapshot.todos.set(t.id, t);
    }
  }
  return Array.from(snapshot.todos.values());
}

/**
 * Builds {@link AgentEvent} values from an ACP notification `cursor/update_todos`.
 *
 * Parallel to streaming `tool_call` with `updateTodosToolCall`; some Cursor builds emit
 * only this notification channel, so swallowing it left the tasks panel stale.
 *
 * @param threadId - Mcode thread id.
 * @param notification - JSON-RPC notification params (`toolCallId`, `todos`, `merge`).
 * @param snapshot - Per-connection todo snapshot for merge semantics.
 */
export function cursorUpdateTodosExtNotificationToAgentEvents(
  threadId: string,
  notification: Record<string, unknown>,
  snapshot: CursorTodoSnapshot | undefined,
): AgentEvent[] {
  const rawTodos = notification.todos;
  if (!Array.isArray(rawTodos) || rawTodos.length === 0) return [];

  const toolCallId =
    typeof notification.toolCallId === "string" && notification.toolCallId.length > 0
      ? notification.toolCallId
      : `cursor-todos-${NodeCrypto.randomUUID()}`;

  const merge = notification.merge === true;
  const asRecords = rawTodos.filter(
    (t): t is Record<string, unknown> =>
      t != null && typeof t === "object" && !Array.isArray(t),
  );
  if (asRecords.length === 0) return [];

  const incoming = asRecords.map((e, i) => normalizeCursorTodoEntry(e, i));
  const todos = reconcileCursorTodos(incoming, merge, snapshot);

  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId,
      toolName: "TodoWrite",
      toolInput: { todos },
    },
    {
      type: AgentEventType.ToolResult,
      threadId,
      toolCallId,
      output: `Updated ${todos.length} todo(s)`,
      isError: false,
    },
  ];
}

/**
 * Synthesizes a paired TodoWrite `ToolUse` + `ToolResult` from an already-
 * reconciled todo list. Caller is responsible for merge/replace semantics
 * via {@link reconcileCursorTodos}; this just constructs the events.
 *
 * The `toolCallId` carries a `cursor-todos-` prefix so it is easy to grep
 * out of agent traces.
 */
export function buildTodoWriteEvents(
  todos: NormalizedCursorTodo[],
  threadId: string,
): AgentEvent[] {
  const toolCallId = `cursor-todos-${NodeCrypto.randomUUID()}`;
  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId,
      toolName: "TodoWrite",
      toolInput: { todos },
    },
    {
      type: AgentEventType.ToolResult,
      threadId,
      toolCallId,
      output: `Updated ${todos.length} todo(s)`,
      isError: false,
    },
  ];
}
