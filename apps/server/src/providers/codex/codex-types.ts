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

/** Parameters for the `thread.start` RPC method. */
export interface ThreadStartParams { workingDirectory: string; model?: string; sandboxMode?: string; modelReasoningEffort?: string }
/** Result returned by the `thread.start` RPC method. */
export interface ThreadStartResult { threadId: string }
/** Parameters for the `thread.resume` RPC method. */
export interface ThreadResumeParams { threadId: string; workingDirectory?: string }
/** Result returned by the `thread.resume` RPC method. */
export interface ThreadResumeResult { threadId: string }

// Turn RPCs

/** A structured text or image input part for turn messages. */
export type TurnInputPart = { type: "text"; text: string } | { type: "local_image"; path: string };
/** Parameters for the `turn.start` RPC method. */
export interface TurnStartParams { threadId: string; input: string | TurnInputPart[]; config?: Record<string, unknown> }
/** Result returned by the `turn.start` RPC method. */
export interface TurnStartResult { turnId: string }
/** Parameters for the `turn.interrupt` RPC method. */
export interface TurnInterruptParams { threadId: string }
/** Result returned by the `turn.interrupt` RPC method. */
export interface TurnInterruptResult { success: boolean }

// Handshake RPCs

/** Result returned by the `model.list` RPC method. */
export interface ModelListResult { models: Array<{ id: string; name?: string }> }
/** Result returned by the `account.read` RPC method. */
export interface AccountReadResult { id?: string; email?: string; name?: string }

// Notification payloads - turn.event discriminated union

/** Agent produced a text message. */
export interface AgentMessageEventPayload { type: "agent_message"; text: string }
/** A shell command was executed by the agent. */
export interface CommandExecutionEventPayload { type: "command_execution"; id: string; command: string; aggregated_output: string; exit_code: number }
/** One or more files were created or modified by the agent. */
export interface FileChangeEventPayload { type: "file_change"; id: string; changes: Array<{ path: string; kind: string }> }
/** An MCP tool was called by the agent. */
export interface McpToolCallEventPayload { type: "mcp_tool_call"; id: string; server: string; tool: string; arguments: Record<string, unknown>; result?: string; error?: string }
/** Internal reasoning step - silently consumed. */
export interface ReasoningEventPayload { type: "reasoning" }
/** Web search step - silently consumed. */
export interface WebSearchEventPayload { type: "web_search" }
/** Todo list update step - silently consumed. */
export interface TodoListEventPayload { type: "todo_list" }
/** An error occurred during the turn. */
export interface ErrorEventPayload { type: "error"; message: string; willRetry?: boolean }

/** Discriminated union of all `turn.event` notification payloads. */
export type TurnEventPayload =
  | AgentMessageEventPayload
  | CommandExecutionEventPayload
  | FileChangeEventPayload
  | McpToolCallEventPayload
  | ReasoningEventPayload
  | WebSearchEventPayload
  | TodoListEventPayload
  | ErrorEventPayload;

// Notification payloads - turn.completed / turn.failed

/** Payload for the `turn.completed` notification. */
export interface TurnCompletedPayload { threadId: string; turnId?: string; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } }
/** Payload for the `turn.failed` notification. */
export interface TurnFailedPayload { threadId: string; turnId?: string; error: { message: string; code?: string } }

/** Discriminated union of all notifications pushed by the codex app-server. */
export type CodexNotification =
  | (JsonRpcNotification<TurnEventPayload> & { method: "turn.event" })
  | (JsonRpcNotification<TurnCompletedPayload> & { method: "turn.completed" })
  | (JsonRpcNotification<TurnFailedPayload> & { method: "turn.failed" });
