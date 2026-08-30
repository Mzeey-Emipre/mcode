import type {
  BrowserAutomationHostConnectionAuthorization,
  BrowserAutomationBroker,
} from "../index.js";
import type { WsMethodName } from "@mcode/contracts";
import type { WebSocket } from "ws";

type BrowserAutomationMethod =
  | "browserAutomation.host.register"
  | "browserAutomation.host.updateTargets"
  | "browserAutomation.host.respond"
  | "browserAutomation.host.heartbeat"
  | "browserAutomation.host.cancel";

/** Defines the dependencies required to route Browser Automation host RPC calls. */
export interface BrowserAutomationRouterDeps {
  browserAutomationBroker?: BrowserAutomationBroker;
}

const browserAutomationHandlers: Record<
  BrowserAutomationMethod,
  (
    deps: BrowserAutomationRouterDeps,
    params: any,
    client: WebSocket | undefined,
    authorization: BrowserAutomationHostConnectionAuthorization | null | undefined,
  ) => Promise<unknown> | unknown
> = {
  "browserAutomation.host.register": (deps, params, client, authorization) => {
    const connection = requireBrowserAutomationConnection(deps, client, "registration");
    return connection.broker.registerHost(
      connection.client,
      params.registration,
      authorization ?? null,
    );
  },
  "browserAutomation.host.updateTargets": (deps, params, client) => {
    const connection = requireBrowserAutomationConnection(deps, client, "target update");
    connection.broker.updateTargets(
      connection.client,
      params.hostId,
      params.generation,
      params.targets,
    );
  },
  "browserAutomation.host.respond": (deps, params, client) => {
    const connection = requireBrowserAutomationConnection(deps, client, "response");
    connection.broker.respond(
      connection.client,
      params.hostId,
      params.generation,
      params.response,
      params.target,
    );
  },
  "browserAutomation.host.heartbeat": (deps, params, client) => {
    const connection = requireBrowserAutomationConnection(deps, client, "heartbeat");
    connection.broker.heartbeat(connection.client, params.hostId, params.generation);
  },
  "browserAutomation.host.cancel": (deps, params, client) => {
    const connection = requireBrowserAutomationConnection(deps, client, "cancellation");
    connection.broker.cancelFromHost(
      connection.client,
      params.hostId,
      params.generation,
      params.requestId,
      params.sequence,
      params.reason,
    );
  },
};

/** Checks whether a method belongs to the Browser Automation host RPC family. */
export function isBrowserAutomationRpcMethod(method: WsMethodName): method is BrowserAutomationMethod {
  return Object.hasOwn(browserAutomationHandlers, method);
}

/** Routes validated Browser Automation host RPC parameters. */
export async function routeBrowserAutomationRpc(
  method: WsMethodName,
  params: any,
  deps: BrowserAutomationRouterDeps,
  client: WebSocket | undefined,
  authorization: BrowserAutomationHostConnectionAuthorization | null | undefined,
): Promise<unknown> {
  if (!isBrowserAutomationRpcMethod(method)) {
    throw new Error(`Unsupported Browser automation method: ${method}`);
  }
  return await browserAutomationHandlers[method](deps, params, client, authorization);
}

function requireBrowserAutomationConnection(
  deps: BrowserAutomationRouterDeps,
  client: WebSocket | undefined,
  operation: string,
): { broker: BrowserAutomationBroker; client: WebSocket } {
  if (!client || !deps.browserAutomationBroker) {
    throw new Error(`Browser automation host ${operation} is unavailable`);
  }
  return { broker: deps.browserAutomationBroker, client };
}
