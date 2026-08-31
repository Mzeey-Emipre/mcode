import type { WsMethodName } from "@mcode/contracts";
import type { WebSocket } from "ws";
import type { CanonicalAgentBoundary } from "../../features/agents/index.js";
import {
  setClientThreadSubscriptions,
  subscribeClientToThread,
  unsubscribeClientFromThread,
} from "./push.js";

type PushSubscriptionMethod =
  | "push.subscribeThread"
  | "push.unsubscribeThread"
  | "push.setThreadSubscriptions";

/** Defines dependencies required to route connection-owned push subscription RPC calls. */
export interface PushSubscriptionRouterDeps {
  canonicalSink: CanonicalAgentBoundary;
}

const pushSubscriptionHandlers: Record<
  PushSubscriptionMethod,
  (deps: PushSubscriptionRouterDeps, params: any, client: WebSocket | undefined) => unknown
> = {
  "push.subscribeThread": (_deps, params, client) => {
    if (client) subscribeClientToThread(client, params.threadId);
  },
  "push.unsubscribeThread": (_deps, params, client) => {
    if (client) unsubscribeClientFromThread(client, params.threadId);
  },
  "push.setThreadSubscriptions": (deps, params, client) => {
    if (!client) return emptySubscriptionReplay();
    const replay = setClientThreadSubscriptions(client, params.threadIds, params.cursors);
    const canonicalRecoveries = params.revisions
      ? params.threadIds.flatMap((threadId: string) => {
          const revision = params.revisions?.[threadId];
          return revision ? [deps.canonicalSink.recoverThread(threadId, revision)] : [];
        })
      : [];
    return { ...replay, canonicalRecoveries };
  },
};

/** Checks whether a method belongs to the connection-owned push subscription RPC family. */
export function isPushSubscriptionRpcMethod(method: WsMethodName): method is PushSubscriptionMethod {
  return Object.hasOwn(pushSubscriptionHandlers, method);
}

/** Routes validated connection-owned push subscription RPC parameters. */
export function routePushSubscriptionRpc(
  method: WsMethodName,
  params: any,
  deps: PushSubscriptionRouterDeps,
  client: WebSocket | undefined,
): unknown {
  if (!isPushSubscriptionRpcMethod(method)) {
    throw new Error(`Unsupported push subscription method: ${method}`);
  }
  return pushSubscriptionHandlers[method](deps, params, client);
}

function emptySubscriptionReplay(): {
  hydrationRequiredThreadIds: string[];
  replayedThrough: Record<string, never>;
  canonicalRecoveries: unknown[];
} {
  return { hydrationRequiredThreadIds: [], replayedThrough: {}, canonicalRecoveries: [] };
}
