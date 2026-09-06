import { WS_METHODS, type WsMethodName } from "@mcode/contracts";
import type { z } from "zod";
import type { WebSocket } from "ws";
import type { FileService } from "../file-service.js";
import type { WorkspaceInvalidationService } from "../workspace-invalidation-service.js";

type FileRpcMethod = Extract<WsMethodName, `file.${string}`>;

type FileRpcParamsByMethod = {
  [Method in FileRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

/** Defines the services required to route validated file RPC calls. */
export interface FileRouterDeps {
  fileService: Pick<FileService, "list" | "read" | "resolveWorkingDir">;
  workspaceInvalidations: Pick<WorkspaceInvalidationService, "watch">;
}

type FileHandlerMap = {
  [Method in FileRpcMethod]: (
    deps: FileRouterDeps,
    params: FileRpcParamsByMethod[Method],
    client?: WebSocket,
  ) => Promise<unknown> | unknown;
};

const fileHandlers: FileHandlerMap = {
  "file.list": (deps, params, client) =>
    readWithInvalidation(deps, params.workspaceId, params.threadId, client, () =>
      deps.fileService.list(params.workspaceId, params.threadId),
    ),
  "file.read": (deps, params, client) =>
    readWithInvalidation(deps, params.workspaceId, params.threadId, client, () =>
      deps.fileService.read(params.workspaceId, params.relativePath, params.threadId),
    ),
  "file.watch": (deps, params, client) => {
    if (client) startInvalidationWatch(deps, params.workspaceId, params.threadId, client);
  },
};

function readWithInvalidation<T>(
  deps: FileRouterDeps,
  workspaceId: string,
  threadId: string | undefined,
  client: WebSocket | undefined,
  read: () => T,
): T {
  const result = read();
  if (client) startInvalidationWatch(deps, workspaceId, threadId, client);
  return result;
}

function startInvalidationWatch(
  deps: FileRouterDeps,
  workspaceId: string,
  threadId: string | undefined,
  client: WebSocket,
): void {
  deps.workspaceInvalidations.watch(
    client,
    workspaceId,
    threadId,
    deps.fileService.resolveWorkingDir(workspaceId, threadId),
  );
}

/** Checks whether a method belongs to the file RPC family. */
export function isFileRpcMethod(method: WsMethodName): method is FileRpcMethod {
  return Object.hasOwn(fileHandlers, method);
}

/** Routes validated file RPC parameters to feature services. */
export async function routeFileRpc<Method extends FileRpcMethod>(
  method: Method,
  params: FileRpcParamsByMethod[Method],
  deps: FileRouterDeps,
  client?: WebSocket,
): Promise<unknown> {
  return await fileHandlers[method](deps, params, client);
}
