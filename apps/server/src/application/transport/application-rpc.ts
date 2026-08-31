import type { WsMethodName } from "@mcode/contracts";

type ApplicationRpcMethod = "app.version";

const applicationHandlers = {
  "app.version": () => process.env.MCODE_VERSION ?? "0.0.1",
} satisfies Record<ApplicationRpcMethod, () => string>;

/** Checks whether a method belongs to the application-owned RPC family. */
export function isApplicationRpcMethod(method: WsMethodName): method is ApplicationRpcMethod {
  return Object.hasOwn(applicationHandlers, method);
}

/** Routes validated application-owned RPC parameters. */
export function routeApplicationRpc(method: ApplicationRpcMethod): string {
  return applicationHandlers[method]();
}
