import type { WsMethodName } from "@mcode/contracts";
import type {
  ExternalThreadControlMcpRuntime,
  ExternalThreadControlPairingService,
  ThreadControlService,
} from "../index.js";

type ThreadControlMethod =
  | "thread.control.read"
  | "thread.control.send"
  | "thread.control.stop"
  | "threadControl.pairing.create"
  | "threadControl.pairing.revoke"
  | "threadControl.pairing.replace";

/** Defines the services required to route validated Thread Control RPC calls. */
export interface ThreadControlRouterDeps {
  threadControlService: ThreadControlService;
  externalThreadControlPairingService?: ExternalThreadControlPairingService;
  externalThreadControlMcpRuntime?: ExternalThreadControlMcpRuntime;
}

const threadControlHandlers: Record<
  ThreadControlMethod,
  (deps: ThreadControlRouterDeps, params: any) => Promise<unknown> | unknown
> = {
  "thread.control.read": (deps, params) => deps.threadControlService.threadControlRead(params),
  "thread.control.send": (deps, params) => deps.threadControlService.threadControlSend(params),
  "thread.control.stop": (deps, params) => deps.threadControlService.threadControlStop(params),
  "threadControl.pairing.create": (deps, params) => {
    const pairings = requirePairings(deps);
    const pairing = pairings.create(params);
    return {
      ...pairing,
      externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? pairing.externalMcpEndpoint,
    };
  },
  "threadControl.pairing.revoke": (deps, params) => {
    const pairings = requirePairings(deps);
    const pairing = pairings.revoke(params.pairingId);
    return {
      ...pairing,
      externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? "/mcp/external-thread-control",
    };
  },
  "threadControl.pairing.replace": (deps, params) => {
    const pairings = requirePairings(deps);
    const { pairingId, ...input } = params;
    const pairing = pairings.replace(pairingId, input);
    return {
      ...pairing,
      externalMcpEndpoint: deps.externalThreadControlMcpRuntime?.endpoint() ?? pairing.externalMcpEndpoint,
    };
  },
};

/** Checks whether a method belongs to the Thread Control RPC family. */
export function isThreadControlRpcMethod(method: WsMethodName): method is ThreadControlMethod {
  return Object.hasOwn(threadControlHandlers, method);
}

/** Routes validated Thread Control RPC parameters. */
export async function routeThreadControlRpc(
  method: WsMethodName,
  params: any,
  deps: ThreadControlRouterDeps,
): Promise<unknown> {
  if (!isThreadControlRpcMethod(method)) {
    throw new Error(`Unsupported Thread Control method: ${method}`);
  }
  return await threadControlHandlers[method](deps, params);
}

function requirePairings(deps: ThreadControlRouterDeps): ExternalThreadControlPairingService {
  if (!deps.externalThreadControlPairingService) {
    throw new Error("External thread-control pairing service unavailable");
  }
  return deps.externalThreadControlPairingService;
}
