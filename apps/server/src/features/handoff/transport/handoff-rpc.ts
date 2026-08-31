import type { WsMethodName } from "@mcode/contracts";
import type { HandoffStorage } from "../index.js";

type HandoffMethod = "handoff.regenerate" | "handoff.readLatest";

/** Defines dependencies required to route validated Handoff RPC calls. */
export interface HandoffRouterDeps {
  handoffStorage: HandoffStorage;
}

const handoffHandlers: Record<
  HandoffMethod,
  (deps: HandoffRouterDeps, params: any) => Promise<unknown> | unknown
> = {
  "handoff.regenerate": () => ({ status: "not-implemented" as const }),
  "handoff.readLatest": (deps, params) => deps.handoffStorage.readLatest(params.threadId),
};

/** Checks whether a method belongs to the Handoff RPC family. */
export function isHandoffRpcMethod(method: WsMethodName): method is HandoffMethod {
  return Object.hasOwn(handoffHandlers, method);
}

/** Routes validated Handoff RPC parameters. */
export async function routeHandoffRpc(
  method: WsMethodName,
  params: any,
  deps: HandoffRouterDeps,
): Promise<unknown> {
  if (!isHandoffRpcMethod(method)) throw new Error(`Unsupported Handoff method: ${method}`);
  return await handoffHandlers[method](deps, params);
}
