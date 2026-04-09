/**
 * JSON-RPC 2.0 protocol types for the `codex app-server` NDJSON interface.
 *
 * Source of truth: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
 * in https://github.com/openai/codex
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

// ---------------------------------------------------------------------------
// Notification payloads
// Source: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
// ---------------------------------------------------------------------------

// Silently-consumed lifecycle payloads (no data needed)
/** Payload for notifications silently consumed as lifecycle events. */
export interface LifecyclePayload { [key: string]: unknown }

// Streaming delta payloads

/** Payload for `item/agentMessage/delta` - streaming assistant text token. */
export interface AgentMessageDeltaPayload { threadId?: string; turnId?: string; itemId?: string; delta: string }
/** Payload for `item/commandExecution/outputDelta` - streaming shell output token. */
export interface CommandExecOutputDeltaPayload { threadId?: string; turnId?: string; itemId?: string; delta: string }

// item/completed payload

/**
 * A completed `ThreadItem` from the agent. Discriminated on `type`.
 *
 * Known types (from codex-rs/app-server-protocol):
 *   userMessage, agentMessage, commandExecution, fileChange, mcpToolCall,
 *   dynamicToolCall, collabAgentToolCall, reasoning, webSearch, plan,
 *   imageView, imageGeneration, contextCompaction, enteredReviewMode, exitedReviewMode
 */
export interface CompletedItem {
  type: string;
  id?: string;

  // agentMessage
  role?: string;
  content?: Array<{ type: string; text?: string }>;

  // commandExecution
  command?: string;
  output?: string | null;
  exitCode?: number | null;

  // fileChange
  changes?: Array<{ path: string; kind: string }>;

  // mcpToolCall / dynamicToolCall
  server?: string;
  tool?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  result?: string | null;
  error?: string | null;

  // function_call (OpenAI Responses API shape, may appear in some versions)
  [key: string]: unknown;
}

/** Payload for the `item/started` notification. */
export interface ItemStartedPayload { threadId?: string; turnId?: string; item?: CompletedItem }
/** Payload for the `item/completed` notification. */
export interface ItemCompletedPayload { threadId?: string; turnId?: string; item?: CompletedItem }

// turn/completed payload

/** Error detail from a failed turn or error notification. */
export interface TurnErrorInfo { message?: string; codexErrorInfo?: string; additionalDetails?: unknown }

/** The `turn` object nested inside a `turn/completed` payload. */
export interface TurnResult {
  id?: string;
  items?: unknown[];
  /** `"completed"` on success, `"failed"` or `"interrupted"` otherwise. */
  status?: "completed" | "failed" | "interrupted" | "inProgress" | string;
  error?: TurnErrorInfo;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/** Payload for the `turn/completed` notification. */
export interface TurnCompletedPayload { threadId?: string; turn?: TurnResult; [key: string]: unknown }

/**
 * Payload for the `error` notification.
 * Fired for transient mid-turn errors; `willRetry` indicates the agent will retry.
 * Terminal failures arrive via `turn/completed` with `turn.status === "failed"`.
 */
export interface ErrorNotificationPayload {
  threadId?: string;
  turnId?: string;
  error?: TurnErrorInfo;
  willRetry?: boolean;
  [key: string]: unknown;
}

/**
 * Discriminated union of all JSON-RPC notifications from `codex app-server`
 * that reach the mapper (lifecycle notifications are filtered upstream).
 *
 * Full protocol: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
 * Filtered upstream by LIFECYCLE_NOTIFICATION_PREFIXES in CodexAppServer:
 *   thread/*, account/*, hook/*, item/reasoning/*, item/plan/*, item/fileChange/*,
 *   rawResponseItem/*, serverRequest/*, turn/diff/*, turn/plan/*
 */
export type CodexNotification =
  | (JsonRpcNotification<LifecyclePayload> & { method: "turn/started" })
  | (JsonRpcNotification<ItemStartedPayload> & { method: "item/started" })
  | (JsonRpcNotification<AgentMessageDeltaPayload> & { method: "item/agentMessage/delta" })
  | (JsonRpcNotification<CommandExecOutputDeltaPayload> & { method: "item/commandExecution/outputDelta" })
  | (JsonRpcNotification<ItemCompletedPayload> & { method: "item/completed" })
  | (JsonRpcNotification<TurnCompletedPayload> & { method: "turn/completed" })
  | (JsonRpcNotification<ErrorNotificationPayload> & { method: "error" });
