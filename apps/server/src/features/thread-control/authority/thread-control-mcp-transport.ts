import {
  ThreadCreateBatchInputSchema,
  ThreadCreateBatchResultSchema,
  ThreadGetInputSchema,
  ThreadGetResultSchema,
  ThreadSearchInputSchema,
  ThreadSearchResultSchema,
  ThreadSendInputSchema,
  ThreadSendResultSchema,
  ThreadStopInputSchema,
  ThreadStopResultSchema,
  ThreadWaitInputSchema,
  ThreadWaitResultSchema,
  WorkspaceSearchInputSchema,
  WorkspaceSearchResultSchema,
  WorktreeListInputSchema,
  WorktreeListResultSchema,
  ThreadTargetListInputSchema,
  ThreadTargetListResultSchema,
} from "@mcode/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InternalThreadControlMcpAuthority } from "./thread-control-mcp-authority.js";
import type { ThreadControlService } from "./thread-control-service.js";
import { getMcodeBrowserGuide, getThreadControlGuide } from "./capability-guides/mcode-capability-guide.js";

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
    return dispatchInternalTool(options.service, authority, request.toolName, request.arguments, signal);
  };

  return {
    dispatch,
    createServer(bearerCredential) {
      const server = new McpServer({ name: "mcode-internal-thread-control", version: "0.1.0" });
      server.registerTool("mcode_browser_guide", {
        description: "Read the Mcode Browser operating guide.",
      }, async (extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "mcode_browser_guide",
        arguments: undefined,
        signal: extra.signal,
      })));
      server.registerTool("thread_control_guide", {
        description: "Read the Mcode thread-control operating guide.",
      }, async (extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_control_guide",
        arguments: undefined,
        signal: extra.signal,
      })));
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
        description: "Create and start one to twenty normal Mcode threads in registered Projects. providerId/modelId select the provider and model; discover named options with thread_target_list first.",
        inputSchema: ThreadCreateBatchInputSchema(),
        outputSchema: ThreadCreateBatchResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_create_batch",
        arguments: arguments_,
      })));
      server.registerTool("thread_target_list", {
        description: "List provider and model targets currently usable for new Mcode threads.",
        inputSchema: ThreadTargetListInputSchema(),
        outputSchema: ThreadTargetListResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_target_list",
        arguments: arguments_,
      })));
      server.registerTool("thread_search", {
        description: "Search readable threads across registered Mcode Projects.",
        inputSchema: ThreadSearchInputSchema(),
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
      server.registerTool("thread_send", {
        description: "Send a message to another normal Mcode thread.",
        inputSchema: ThreadSendInputSchema(),
        outputSchema: ThreadSendResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_send",
        arguments: arguments_,
        signal: extra.signal,
      })));
      server.registerTool("thread_stop", {
        description: "Stop another normal Mcode thread.",
        inputSchema: ThreadStopInputSchema(),
        outputSchema: ThreadStopResultSchema(),
      }, async (arguments_, extra) => createToolResult(await dispatch({
        bearerCredential,
        requestId: extra.requestId,
        toolName: "thread_stop",
        arguments: arguments_,
        signal: extra.signal,
      })));
      server.registerTool("thread_wait", {
        description: "Wait for exact readable threads to require attention or finish.",
        inputSchema: ThreadWaitInputSchema(),
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

type InternalToolHandler = (arguments_: unknown) => Promise<Record<string, unknown>>;

function dispatchInternalTool(
  service: ThreadControlService,
  authority: NonNullable<ReturnType<InternalThreadControlMcpAuthority["authorize"]>>,
  toolName: string,
  arguments_: unknown,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const handler = createToolHandlers(service, authority, signal)[toolName];
  if (!handler) throw new InternalThreadControlMcpAuthorizationError();
  return handler(arguments_);
}

function createToolHandlers(
  service: ThreadControlService,
  authority: NonNullable<ReturnType<InternalThreadControlMcpAuthority["authorize"]>>,
  signal: AbortSignal | undefined,
): Record<string, InternalToolHandler> {
  return {
    workspace_search: async (arguments_) => {
      const input = WorkspaceSearchInputSchema().parse(arguments_);
      return WorkspaceSearchResultSchema().parse(service.workspaceSearch(authority, input));
    },
    worktree_list: async (arguments_) => {
      const input = WorktreeListInputSchema().parse(arguments_);
      return WorktreeListResultSchema().parse(await service.worktreeList(authority, input));
    },
    thread_create_batch: async (arguments_) => {
      const input = ThreadCreateBatchInputSchema().parse(arguments_);
      return ThreadCreateBatchResultSchema().parse(await service.threadCreateBatch(authority, input));
    },
    thread_target_list: async (arguments_) => {
      ThreadTargetListInputSchema().parse(arguments_);
      return ThreadTargetListResultSchema().parse(await service.threadTargetList(authority));
    },
    thread_search: async (arguments_) => {
      const input = ThreadSearchInputSchema().parse(arguments_);
      return ThreadSearchResultSchema().parse(service.threadSearch(authority, input));
    },
    thread_get: async (arguments_) => {
      const input = ThreadGetInputSchema().parse(arguments_);
      return ThreadGetResultSchema().parse(service.threadGet(authority, input));
    },
    thread_send: async (arguments_) => {
      const input = ThreadSendInputSchema().parse(arguments_);
      return ThreadSendResultSchema().parse(await service.threadSend(authority, input));
    },
    thread_stop: async (arguments_) => {
      const input = ThreadStopInputSchema().parse(arguments_);
      return ThreadStopResultSchema().parse(await service.threadStop(authority, input));
    },
    thread_wait: async (arguments_) => {
      const input = ThreadWaitInputSchema().parse(arguments_);
      return ThreadWaitResultSchema().parse(await service.threadWait(authority, input, signal));
    },
    mcode_browser_guide: async (arguments_) => {
      if (!isEmptyArguments(arguments_)) throw new Error("mcode_browser_guide accepts no arguments");
      return getMcodeBrowserGuide();
    },
    thread_control_guide: async (arguments_) => {
      if (!isEmptyArguments(arguments_)) throw new Error("thread_control_guide accepts no arguments");
      return getThreadControlGuide();
    },
  };
}

function isEmptyArguments(arguments_: unknown): boolean {
  if (arguments_ === undefined || arguments_ === null) return true;
  if (typeof arguments_ !== "object" || Array.isArray(arguments_)) return false;
  return Object.keys(arguments_).length === 0;
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
