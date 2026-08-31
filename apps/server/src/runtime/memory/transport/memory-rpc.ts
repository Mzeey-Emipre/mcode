import { WS_METHODS, type WsMethodName } from "@mcode/contracts";
import type { z } from "zod";
import type { MemoryPressureService } from "../memory-pressure-service.js";

type MemoryRpcMethod = "memory.setBackground";

type MemoryRpcParamsByMethod = {
  [Method in MemoryRpcMethod]: z.input<ReturnType<typeof WS_METHODS>[Method]["params"]>;
};

/** Defines the services required to route validated memory RPC calls. */
export interface MemoryRouterDeps {
  memoryPressureService: Pick<MemoryPressureService, "markBackground" | "markForeground">;
}

type MemoryHandlerMap = {
  [Method in MemoryRpcMethod]: (
    deps: MemoryRouterDeps,
    params: MemoryRpcParamsByMethod[Method],
  ) => void;
};

const memoryHandlers: MemoryHandlerMap = {
  "memory.setBackground": (deps, params) => {
    if (params.background) {
      deps.memoryPressureService.markBackground();
      return;
    }
    deps.memoryPressureService.markForeground();
  },
};

/** Checks whether a method belongs to the memory RPC family. */
export function isMemoryRpcMethod(method: WsMethodName): method is MemoryRpcMethod {
  return Object.hasOwn(memoryHandlers, method);
}

/** Routes validated memory RPC parameters to the pressure controller. */
export async function routeMemoryRpc<Method extends MemoryRpcMethod>(
  method: Method,
  params: MemoryRpcParamsByMethod[Method],
  deps: MemoryRouterDeps,
): Promise<void> {
  memoryHandlers[method](deps, params);
}
