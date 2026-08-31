import type { WsMethodName } from "@mcode/contracts";
import type { SettingsService } from "../settings-service.js";

type SettingsMethod = "settings.get" | "settings.update";

/** Defines dependencies required to route validated Settings RPC calls. */
export interface SettingsRouterDeps {
  settingsService: SettingsService;
}

const settingsHandlers: Record<
  SettingsMethod,
  (deps: SettingsRouterDeps, params: any) => Promise<unknown> | unknown
> = {
  "settings.get": (deps) => deps.settingsService.get(),
  "settings.update": (deps, params) => deps.settingsService.update(params),
};

/** Checks whether a method belongs to the Settings RPC family. */
export function isSettingsRpcMethod(method: WsMethodName): method is SettingsMethod {
  return Object.hasOwn(settingsHandlers, method);
}

/** Routes validated Settings RPC parameters. */
export async function routeSettingsRpc(
  method: WsMethodName,
  params: any,
  deps: SettingsRouterDeps,
): Promise<unknown> {
  if (!isSettingsRpcMethod(method)) throw new Error(`Unsupported Settings method: ${method}`);
  return await settingsHandlers[method](deps, params);
}
