import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import type { ThreadControlService } from "../authority/thread-control-service.js";
import {
  ExternalThreadControlPairingError,
  ExternalThreadControlPairingService,
} from "./external-thread-control-pairing-service.js";

/** Context propagated from the loopback HTTP request into MCP tool callbacks. */
export interface ExternalThreadControlMcpContext {
  bearerCredential: string;
  pairingId?: string;
  authorityEpoch?: number;
  deliveryId?: string;
}

/** Incoming external MCP request used by direct tests and the HTTP adapter. */
export interface ExternalThreadControlMcpRequest extends ExternalThreadControlMcpContext {
  requestId: string | number;
  toolName: string;
  arguments: unknown;
  signal?: AbortSignal;
}

/** Session exposing exactly the nine public thread-control tools. */
export interface ExternalThreadControlMcpSession {
  dispatch(request: ExternalThreadControlMcpRequest): Promise<Record<string, unknown>>;
  createServer(credential?: string): McpServer;
  contextStorage: AsyncLocalStorage<ExternalThreadControlMcpContext>;
}

/** Creates an authenticated, replay-safe external MCP adapter. */
export function createExternalThreadControlMcpSession(options: {
  pairingService: ExternalThreadControlPairingService;
  service: ThreadControlService;
}): ExternalThreadControlMcpSession {
  const contextStorage = new AsyncLocalStorage<ExternalThreadControlMcpContext>();
  const inFlight = new Map<string, Promise<Record<string, unknown>>>();

  const dispatch = async (request: ExternalThreadControlMcpRequest): Promise<Record<string, unknown>> => {
    const pairing = options.pairingService.authenticate(
      request.bearerCredential,
      request.pairingId,
      request.authorityEpoch,
    );
    const deliveryId = request.deliveryId ?? normalizeRequestId(request.requestId);
    if (!deliveryId) throw new ExternalThreadControlPairingError("conflict", "External delivery id is required");
    const fingerprint = requestFingerprint(request.toolName, request.arguments);
    const reservation = options.pairingService.beginDelivery(pairing, deliveryId, fingerprint);
    if (reservation.status === "replayed") return reservation.result ?? {};
    if (reservation.status === "joined") {
      const existing = inFlight.get(reservation.key);
      if (existing) return existing;
      throw new ExternalThreadControlPairingError("conflict", "External delivery is already being reconciled");
    }
    const execution = executeTool(options.service, pairing.authority, request);
    inFlight.set(reservation.key, execution);
    try {
      const result = await execution;
      options.pairingService.finalizeDelivery(pairing, deliveryId, result);
      return result;
    } catch (error) {
      const replayResult = {
        status: "rejected",
        error: {
          code: "internal_error",
          message: "External thread-control delivery failed",
          retryable: true,
        },
      } as Record<string, unknown>;
      options.pairingService.finalizeDelivery(pairing, deliveryId, replayResult);
      throw error;
    } finally {
      inFlight.delete(reservation.key);
    }
  };

  return {
    dispatch,
    contextStorage,
    createServer(credential) {
      const server = new McpServer({ name: "mcode-external-thread-control", version: "0.1.0" });
      registerTools(server, async (toolName, arguments_, extra) => {
        const context = contextStorage.getStore();
        return dispatch({
          bearerCredential: context?.bearerCredential ?? credential ?? "",
          pairingId: context?.pairingId,
          authorityEpoch: context?.authorityEpoch,
          deliveryId: context?.deliveryId,
          requestId: extra.requestId,
          toolName,
          arguments: arguments_,
          signal: extra.signal,
        });
      });
      return server;
    },
  };
}

async function executeTool(
  service: ThreadControlService,
  authority: Parameters<ThreadControlService["threadSearch"]>[0],
  request: ExternalThreadControlMcpRequest,
): Promise<Record<string, unknown>> {
  switch (request.toolName) {
    case "workspace_search":
      return WorkspaceSearchResultSchema().parse(service.workspaceSearch(authority, WorkspaceSearchInputSchema().parse(request.arguments)));
    case "worktree_list":
      return WorktreeListResultSchema().parse(await service.worktreeList(authority, WorktreeListInputSchema().parse(request.arguments)));
    case "thread_create_batch":
      return ThreadCreateBatchResultSchema().parse(await service.threadCreateBatch(authority, ThreadCreateBatchInputSchema().parse(request.arguments)));
    case "thread_target_list":
      ThreadTargetListInputSchema().parse(request.arguments);
      return ThreadTargetListResultSchema().parse(await service.threadTargetList(authority));
    case "thread_search":
      return ThreadSearchResultSchema().parse(service.threadSearch(authority, ThreadSearchInputSchema().parse(request.arguments)));
    case "thread_get":
      return ThreadGetResultSchema().parse(service.threadGet(authority, ThreadGetInputSchema().parse(request.arguments)));
    case "thread_send":
      return ThreadSendResultSchema().parse(await service.threadSend(authority, ThreadSendInputSchema().parse(request.arguments)));
    case "thread_stop":
      return ThreadStopResultSchema().parse(await service.threadStop(authority, ThreadStopInputSchema().parse(request.arguments)));
    case "thread_wait":
      return ThreadWaitResultSchema().parse(await service.threadWait(authority, ThreadWaitInputSchema().parse(request.arguments), request.signal));
    default:
      throw new ExternalThreadControlPairingError("unauthorized", "External thread-control tool denied");
  }
}

function registerTools(
  server: McpServer,
  dispatch: (toolName: string, arguments_: unknown, extra: { requestId: string | number; signal?: AbortSignal }) => Promise<Record<string, unknown>>,
): void {
  const register = (toolName: string, description: string, inputSchema: object, outputSchema: object | undefined) => {
    server.registerTool(toolName, {
      description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
    } as never, (async (arguments_: unknown, extra: { requestId: string | number; signal?: AbortSignal }) =>
      createToolResult(await dispatch(toolName, arguments_, extra))) as never);
  };
  register("workspace_search", "Search selected Mcode Projects.", WorkspaceSearchInputSchema(), WorkspaceSearchResultSchema());
  register("worktree_list", "List opaque worktrees in one selected Project.", WorktreeListInputSchema(), WorktreeListResultSchema());
  register("thread_create_batch", "Create one to twenty Mcode threads. providerId/modelId select the provider and model; discover named options with thread_target_list first.", ThreadCreateBatchInputSchema(), ThreadCreateBatchResultSchema());
  register("thread_target_list", "List provider and model targets currently usable for new Mcode threads.", ThreadTargetListInputSchema(), ThreadTargetListResultSchema());
  register("thread_search", "Search readable Mcode threads.", ThreadSearchInputSchema(), ThreadSearchResultSchema());
  register("thread_get", "Read one bounded Mcode thread transcript.", ThreadGetInputSchema(), ThreadGetResultSchema());
  register("thread_send", "Send a message to one readable Mcode thread.", ThreadSendInputSchema(), ThreadSendResultSchema());
  register("thread_stop", "Stop one mutable Mcode thread.", ThreadStopInputSchema(), ThreadStopResultSchema());
  register("thread_wait", "Wait for readable Mcode threads.", ThreadWaitInputSchema(), ThreadWaitResultSchema());
}

function createToolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/** Stable request fingerprint used to reject same-delivery payload changes. */
export function requestFingerprint(toolName: string, arguments_: unknown): string {
  return createHash("sha256").update(stableStringify({ toolName, arguments: arguments_ }), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function normalizeRequestId(requestId: string | number): string | undefined {
  if (typeof requestId === "number") return Number.isSafeInteger(requestId) ? String(requestId) : undefined;
  return requestId.length > 0 && requestId.length <= 256 ? requestId : undefined;
}
