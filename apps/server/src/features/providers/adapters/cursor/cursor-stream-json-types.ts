/**
 * Type definitions for cursor-agent's `--output-format stream-json` event
 * stream, as produced by `cursor-agent --print --output-format stream-json
 * --stream-partial-output`.
 *
 * Sources:
 *   - https://cursor.com/docs/cli/reference/output-format
 *   - https://tarq.net/posts/cursor-agent-stream-format/
 *
 * The shapes are intentionally permissive on optional fields — cursor-agent
 * version drift may add or omit attributes, and the parser/mapper treat
 * unknown fields as additive.
 */

/** First event in the stream. Carries the persistent chat id (`session_id`). */
export interface CursorStreamSystemInit {
  type: "system";
  subtype: "init";
  /** Persistent Cursor chat id. Reuse with `--resume <id>` to continue. */
  session_id: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  apiKeySource?: string;
  [key: string]: unknown;
}

/** A single content block inside an `assistant` message. */
export interface CursorStreamContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Streaming assistant message. Per-token deltas carry `timestamp_ms`;
 * the final completed message arrives without it.
 */
export interface CursorStreamAssistant {
  type: "assistant";
  message: {
    role: "assistant";
    content?: CursorStreamContentBlock[];
    [key: string]: unknown;
  };
  timestamp_ms?: number;
  model_call_id?: string;
  session_id?: string;
}

/** Started/completed envelope around an actual `<X>ToolCall` payload. */
export interface CursorStreamToolCallStarted {
  type: "tool_call";
  subtype: "started";
  tool_call: Record<string, unknown>;
  call_id: string;
  session_id?: string;
  /** When set, nested tools belong to this parent call id (Cursor subagents / delegation). */
  parent_call_id?: string;
}

/** Result body of a completed tool call. */
export interface CursorStreamToolCallResult {
  success?: unknown;
  rejected?: unknown;
  failure?: unknown;
  [key: string]: unknown;
}

export interface CursorStreamToolCallCompleted {
  type: "tool_call";
  subtype: "completed";
  tool_call: Record<string, unknown> & { result?: CursorStreamToolCallResult };
  call_id: string;
  session_id?: string;
  parent_call_id?: string;
}

/** Terminal event marking turn completion. */
export interface CursorStreamResult {
  type: "result";
  subtype: "success" | "error" | string;
  duration_ms?: number;
  session_id?: string;
  [key: string]: unknown;
}

/** Echo of the user message submitted to the agent. We currently ignore these. */
export interface CursorStreamUser {
  type: "user";
  message?: Record<string, unknown>;
  session_id?: string;
}

/**
 * Discriminated union of cursor stream-json events the parser yields.
 * Unknown event shapes still surface through the `type` discriminator so the
 * mapper can ignore-and-log them without crashing.
 */
export type CursorStreamEvent =
  | CursorStreamSystemInit
  | CursorStreamAssistant
  | CursorStreamToolCallStarted
  | CursorStreamToolCallCompleted
  | CursorStreamResult
  | CursorStreamUser
  | { type: string; [key: string]: unknown };
