import {
  ThreadCreateBatchInputSchema,
  ThreadCreateBatchResultSchema,
  ThreadGetInputSchema,
  ThreadGetResultSchema,
  ThreadSearchInputSchema,
  ThreadSearchResultSchema,
  ThreadWaitInputSchema,
  ThreadWaitResultSchema,
  WorkspaceSearchInputSchema,
  WorkspaceSearchResultSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
} from "@mcode/contracts";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InternalThreadControlMcpAuthority } from "./thread-control-mcp-authority.js";
import type { ThreadControlService } from "./thread-control-service.js";

const threadSearchToolInputSchema = z.object({
  workspaceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional(),
  query: z.string().trim().max(256).optional(),
  statuses: z.array(z.enum(["starting", "running", "idle", "completed", "failed", "stopped", "waiting_for_approval", "waiting_for_user"])).max(9).optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
const threadWaitToolInputSchema = z.object({
  threadIds: z.array(z.string().trim().min(1).max(128)).min(1).max(20),
  until: z.enum(["attention_or_terminal", "terminal"]).default("attention_or_terminal"),
  timeoutSeconds: z.number().int().min(1).max(1_800).default(300),
}).strict();

/** Incoming request context for the server-internal MCP transport. */
export interface InternalThreadControlMcpRequest {
  bearerCredential: string;
  requestId: string | number;
  toolName: string;
  arguments: unknown;
  signal?: AbortSignal;
}

/** Creates MCP servers and direct dispatchers for one server-owned thread-control authority. */
export interface InternalThreadControlMcpSession {
  /** Dispatches one authenticated internal MCP tool request without exposing authority in tool arguments. */
  dispatch(request: InternalThreadControlMcpRequest): Promise<Record<string, unknown>>;
  /** Creates an in-process MCP server for later Claude or Codex transport injection. */
  createServer(bearerCredential: string): McpServer;
}

/** Dependencies required by the server-internal MCP transport. */
export interface CreateInternalThreadControlMcpSessionOptions {
  authority: InternalThreadControlMcpAuthority;
  service: ThreadControlService;
}

/** Rejects a request whose transport context cannot establish active internal authority. */
export class InternalThreadControlMcpAuthorizationError extends Error {
  constructor() {
    super("Internal thread-control MCP request denied");
  }
}

/** Creates an in-process MCP session with only the internal discovery tool allowlist. */
export function createInternalThreadControlMcpSession(
  options: CreateInternalThreadControlMcpSessionOptions,
): InternalThreadControlMcpSession {
  const dispatch = async (request: InternalThreadControlMcpRequest): Promise<Record<string, unknown>> => {
    const sourceToolCallId = normalizeRequestId(request.requestId);
    const authority = sourceToolCallId === undefined
      ? undefined
      : options.authority.authorize(request.bearerCredential, sourceToolCallId);
    if (!authority) throw new InternalThreadControlMcpAuthorizationError();
    const leaseSignal = options.authority.signal(request.bearerCredential);
    const signal = combineAbortSignals([leaseSignal, request.signal]);

    switch (request.toolName) {
      case "workspace_search": {
        const input = WorkspaceSearchInputSchema().parse(request.arguments);
        return WorkspaceSearchResultSchema().parse(options.service.workspaceSearch(authority, input));
      }
      case "worktree_list": {
        const input = WorktreeListInputSchema().parse(request.arguments);
        return WorktreeListResultSchema().parse(await options.service.worktreeList(authority, input));
      }
      case "thread_create_batch": {
        const input = ThreadCreateBatchInputSchema().parse(request.arguments);
        return ThreadCreateBatchResultSchema().parse(
          await options.service.threadCreateBatch(authority, input),
        );
      }
      case "thread_search": {
        const input = ThreadSearchInputSchema().parse(request.arguments);
        return ThreadSearchResultSchema().parse(options.service.threadSearch(authority, input));
      }
      case "thread_get": {
        const input = ThreadGetInputSchema().parse(request.arguments);
        return ThreadGetResultSchema().parse(options.service.threadGet(authority, input));
      }
      case "thread_wait": {
        const input = ThreadWaitInputSchema().parse(request.arguments);
        return ThreadWaitResultSchema().parse(await options.service.threadWait(authority, input, signal));
      }
      default:
        throw new InternalThreadControlMcpAuthorizationError();
    }
  };

  return {
    dispatch,
    createServer(bearerCredential) {
      const server = new McpServer({ name: "mcode-internal-thread-control", version: "0.1.0" });
      server.registerTool("workspace_search", {
        description: "Search registered Mcode workspaces.",
        inputSchema: WorkspaceSearchInputSchema(),
        outputSchema: WorkspaceSearchResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "workspace_search",
        arguments: arguments_,
      })));
      server.registerTool("worktree_list", {
        description: "List tracked worktrees for one registered Mcode workspace.",
        inputSchema: WorktreeListInputSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "worktree_list",
        arguments: arguments_,
      })));
      server.registerTool("thread_create_batch", {
        description: "Create and start one to twenty normal Mcode threads in registered Projects.",
        inputSchema: ThreadCreateBatchInputSchema(),
        outputSchema: ThreadCreateBatchResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_create_batch",
        arguments: arguments_,
      })));
      server.registerTool("thread_search", {
        description: "Search readable threads across registered Mcode Projects.",
        inputSchema: threadSearchToolInputSchema,
        outputSchema: ThreadSearchResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_search",
        arguments: arguments_,
        signal: extra.signal,
      })));
      server.registerTool("thread_get", {
        description: "Read one bounded thread transcript.",
        inputSchema: ThreadGetInputSchema(),
        outputSchema: ThreadGetResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_get",
        arguments: arguments_,
        signal: extra.signal,
      })));
      server.registerTool("thread_wait", {
        description: "Wait for exact readable threads to require attention or finish.",
        inputSchema: threadWaitToolInputSchema,
        outputSchema: ThreadWaitResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_wait",
        arguments: arguments_,
        signal: extra.signal,
      })));
      return server;
    },
  };
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.some((signal) => signal.aborted)) return AbortSignal.abort();
  return AbortSignal.any(active);
}

function normalizeRequestId(requestId: string | number): string | undefined {
  if (typeof requestId === "number") {
    return Number.isSafeInteger(requestId) ? String(requestId) : undefined;
  }
  return requestId.length > 0 && requestId.length <= 128 ? requestId : undefined;
}

function createToolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}
