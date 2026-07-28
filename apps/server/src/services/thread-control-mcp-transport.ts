import {
  ThreadCreateBatchInputSchema,
  ThreadCreateBatchResultSchema,
  WorkspaceSearchInputSchema,
  WorkspaceSearchResultSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
} from "@mcode/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InternalThreadControlMcpAuthority } from "./thread-control-mcp-authority.js";
import type { ThreadControlService } from "./thread-control-service.js";

/** Incoming request context for the server-internal MCP transport. */
export interface InternalThreadControlMcpRequest {
  bearerCredential: string;
  requestId: string | number;
  toolName: string;
  arguments: unknown;
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
      return server;
    },
  };
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
