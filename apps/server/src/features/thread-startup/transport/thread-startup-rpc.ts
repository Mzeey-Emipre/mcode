import type {
  ThreadStartupCancelInput,
  ThreadStartupGetInput,
  ThreadStartupListInput,
  WsMethodName,
} from "@mcode/contracts";
import type { ThreadStartupService } from "../thread-startup-service.js";

type ThreadStartupRpcMethod =
  | "thread.startup.get"
  | "thread.startup.list"
  | "thread.startup.cancel";

type ThreadStartupParamsByMethod = {
  "thread.startup.get": ThreadStartupGetInput;
  "thread.startup.list": ThreadStartupListInput;
  "thread.startup.cancel": ThreadStartupCancelInput;
};

/** Dependencies required to route thread startup lifecycle RPC calls. */
export interface ThreadStartupRouterDeps {
  threadStartupService: Pick<ThreadStartupService, "get" | "list" | "cancel">;
}

type ThreadStartupHandlerMap = {
  [Method in ThreadStartupRpcMethod]: (
    deps: ThreadStartupRouterDeps,
    params: ThreadStartupParamsByMethod[Method],
  ) => unknown;
};

const threadStartupHandlers: ThreadStartupHandlerMap = {
  "thread.startup.get": (deps, params) => deps.threadStartupService.get(params.startupId),
  "thread.startup.list": (deps, params) => ({ records: deps.threadStartupService.list(params.workspaceId) }),
  "thread.startup.cancel": (deps, params) => deps.threadStartupService.cancel(params.startupId),
};

/** Checks whether a method belongs to the thread startup lifecycle RPC family. */
export function isThreadStartupRpcMethod(method: WsMethodName): method is ThreadStartupRpcMethod {
  return Object.hasOwn(threadStartupHandlers, method);
}

/** Routes validated thread startup lifecycle RPC parameters. */
export function routeThreadStartupRpc<Method extends ThreadStartupRpcMethod>(
  method: Method,
  params: ThreadStartupParamsByMethod[Method],
  deps: ThreadStartupRouterDeps,
): unknown {
  return threadStartupHandlers[method](deps, params);
}
