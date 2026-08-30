import { WS_METHODS, type WsMethodName } from "@mcode/contracts";
import type { z } from "zod";
import type { FileService } from "../file-service.js";

type FileRpcMethod = Extract<WsMethodName, `file.${string}`>;

type FileRpcParamsByMethod = {
  [Method in FileRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

/** Defines the services required to route validated file RPC calls. */
export interface FileRouterDeps {
  fileService: Pick<FileService, "list" | "read">;
}

type FileHandlerMap = {
  [Method in FileRpcMethod]: (
    deps: FileRouterDeps,
    params: FileRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const fileHandlers: FileHandlerMap = {
  "file.list": (deps, params) => deps.fileService.list(params.workspaceId, params.threadId),
  "file.read": (deps, params) => deps.fileService.read(
    params.workspaceId,
    params.relativePath,
    params.threadId,
  ),
};

/** Checks whether a method belongs to the file RPC family. */
export function isFileRpcMethod(method: WsMethodName): method is FileRpcMethod {
  return Object.hasOwn(fileHandlers, method);
}

/** Routes validated file RPC parameters to feature services. */
export async function routeFileRpc<Method extends FileRpcMethod>(
  method: Method,
  params: FileRpcParamsByMethod[Method],
  deps: FileRouterDeps,
): Promise<unknown> {
  return await fileHandlers[method](deps, params);
}
