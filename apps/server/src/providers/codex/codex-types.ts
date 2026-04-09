/**
 * JSON-RPC 2.0 protocol types for the `codex app-server` NDJSON interface.
 */

// JSON-RPC base shapes

/** A JSON-RPC 2.0 request message sent to the codex app-server. */
export interface JsonRpcRequest<T = unknown> { jsonrpc: "2.0"; id: number; method: string; params: T }
/** A JSON-RPC 2.0 response message received from the codex app-server. */
export interface JsonRpcResponse<T = unknown> { jsonrpc: "2.0"; id: number; result?: T; error?: { code: number; message: string; data?: unknown } }
/** A JSON-RPC 2.0 notification (no `id`) pushed by the codex app-server. */
export interface JsonRpcNotification<T = unknown> { jsonrpc: "2.0"; method: string; params: T }

// Initialize RPC

/** Parameters for the `initialize` RPC method. */
export interface InitializeParams { clientInfo: { name: string; version: string }; capabilities: { experimentalApi: boolean } }
/** Result returned by the `initialize` RPC method. */
export interface InitializeResult { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown> }

// Thread RPCs

/** Parameters for the `thread/start` RPC method. */
export interface ThreadStartParams { workingDirectory: string; model?: string; sandboxMode?: string; modelReasoningEffort?: string }
/** Result returned by the `thread/start` RPC method. */
export interface ThreadStartResult {
  /** Top-level threadId (some versions). */
  threadId?: string;
  /** Nested thread object (codex app-server >= 0.104.0). The session ID is at `thread.id`. */
  thread?: { id: string; [key: string]: unknown };
}
/** Parameters for the `thread/resume` RPC method. */
export interface ThreadResumeParams { threadId: string; workingDirectory?: string }
/** Result returned by the `thread/resume` RPC method. */
export interface ThreadResumeResult { threadId: string }

// Turn RPCs

/** A structured text or image input part for turn messages. */
export type TurnInputPart = { type: "text"; text: string } | { type: "local_image"; path: string };
/** Parameters for the `turn/start` RPC method. */
export interface TurnStartParams { threadId: string; input: string | TurnInputPart[]; config?: Record<string, unknown> }
/** Result returned by the `turn/start` RPC method. */
export interface TurnStartResult { turnId: string }
/** Parameters for the `turn/interrupt` RPC method. */
export interface TurnInterruptParams { threadId: string }
/** Result returned by the `turn/interrupt` RPC method. */
export interface TurnInterruptResult { success: boolean }

// Handshake RPCs

/** Result returned by the `model/list` RPC method. */
export interface ModelListResult { models: Array<{ id: string; name?: string }> }
/** Result returned by the `account/read` RPC method. */
export interface AccountReadResult { id?: string; email?: string; name?: string }

// Notification payloads - actual codex app-server >= 0.104.0 protocol
// Observed notification sequence: turn/started → item/started → item/completed
//   → account/rateLimits/updated → error (optional) → turn/completed

/**
 * A content part within a message item (OpenAI Responses API streaming format).
 * Known types: "output_text", "refusal". Future types are handled defensively.
 */
export interface ItemContentPart { type: string; text?: string }

/**
 * A completed output item from the agent.
 * Known types: "message" (assistant text), "function_call" (tool invocation).
 */
export interface CompletedItem {
  type: string;
  /** Present for `type === "message"` items. */
  role?: string;
  /** Content parts for `type === "message"` items. */
  content?: ItemContentPart[];
  /** Tool call identifier for `type === "function_call"` items. */
  id?: string;
  /** Function name for `type === "function_call"` items. */
  name?: string;
  /** JSON-encoded arguments for `type === "function_call"` items. */
  arguments?: string;
  /** Stringified output for completed `type === "function_call"` items. */
  output?: string;
  /** Allow additional protocol fields without breaking the type. */
  [key: string]: unknown;
}

/** Payload for the `item/completed` notification. */
export interface ItemCompletedPayload { item?: CompletedItem; [key: string]: unknown }
/** Payload for the `item/started` notification - silently consumed. */
export interface ItemStartedPayload { [key: string]: unknown }
/** Payload for the `item/agentMessage/delta` notification - streaming text token from the assistant. */
export interface AgentMessageDeltaPayload { threadId?: string; turnId?: string; itemId?: string; delta: string }
/** Payload for the `turn/started` notification - silently consumed. */
export interface TurnStartedPayload { [key: string]: unknown }

/** Error detail embedded in a failed turn result. */
export interface TurnErrorInfo { message?: string; codexErrorInfo?: string; additionalDetails?: unknown }

/** The `turn` object nested inside a `turn/completed` payload. */
export interface TurnResult {
  id?: string;
  items?: unknown[];
  /** `"completed"` on success, `"failed"` when the turn was rejected by the server. */
  status?: "completed" | "failed" | string;
  error?: TurnErrorInfo;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/** Payload for the `turn/completed` notification. */
export interface TurnCompletedPayload { threadId?: string; turn?: TurnResult; [key: string]: unknown }
/** Payload for the `error` notification (may precede `turn/completed`). */
export interface ErrorNotificationPayload { message?: string; code?: string; [key: string]: unknown }

/**
 * Discriminated union of all JSON-RPC notifications from `codex app-server`.
 *
 * Observed notification methods (codex app-server >= 0.104.0):
 *   turn/started, item/started, item/completed, account/rateLimits/updated,
 *   error, turn/completed
 *
 * `account/rateLimits/updated` is filtered by `LIFECYCLE_NOTIFICATION_PREFIXES`
 * in `CodexAppServer` and never reaches the mapper.
 */
export type CodexNotification =
  | (JsonRpcNotification<TurnStartedPayload> & { method: "turn/started" })
  | (JsonRpcNotification<ItemStartedPayload> & { method: "item/started" })
  | (JsonRpcNotification<AgentMessageDeltaPayload> & { method: "item/agentMessage/delta" })
  | (JsonRpcNotification<ItemCompletedPayload> & { method: "item/completed" })
  | (JsonRpcNotification<TurnCompletedPayload> & { method: "turn/completed" })
  | (JsonRpcNotification<ErrorNotificationPayload> & { method: "error" });
