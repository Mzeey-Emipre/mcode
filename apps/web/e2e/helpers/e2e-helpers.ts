import type { Page, WebSocketRoute } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Optional overrides for RPC responses. Keyed by method name.
 * The value is either:
 * - a static result that will be returned verbatim, or
 * - a function called with the request params at invocation time. The return
 *   value (or its resolved value) is sent as the result. Functional handlers
 *   let tests record calls or shape responses based on params.
 */
export type RpcOverrides = Record<
  string,
  unknown | ((params?: unknown) => unknown | Promise<unknown>)
>;

/**
 * Controller returned by {@link mockWebSocketServer} to send server-initiated
 * push notifications to the client.
 */
export interface WsController {
  /** Send a JSON-RPC notification (no `id`) to the connected client. */
  sendNotification(method: string, params?: unknown): Promise<void>;
  /**
   * Send a server-initiated push event using the transport's
   * `{ type: "push", channel, data }` wire shape so that `pushEmitter`
   * listeners in ws-events.ts receive the event correctly.
   */
  sendPush(channel: string, data: unknown): Promise<void>;
}

/**
 * Mock the WebSocket server so the WS transport connects and RPC calls
 * resolve instead of hanging forever. Returns proper JSON-RPC error
 * responses for parse failures and unknown methods.
 *
 * Returns a {@link WsController} that can push server-initiated notifications.
 */
export async function mockWebSocketServer(
  page: Page,
  overrides: RpcOverrides = {},
): Promise<WsController> {
  let resolveWs: (ws: WebSocketRoute) => void;
  const wsReady = new Promise<WebSocketRoute>((r) => {
    resolveWs = r;
  });

  // Match 5-digit ports (19400-19800 mcode range) to avoid intercepting Vite's
  // HMR socket at port 5173 (4 digits), which would trigger a page reload.
  await page.routeWebSocket(/ws:\/\/localhost:\d{5}/, (ws) => {
    resolveWs(ws);

    ws.onMessage(async (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(
          JSON.stringify({
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }
      const method = msg.method as string;
      // Check overrides first
      if (method in overrides) {
        const handler = overrides[method];
        // If the override is a function, call it now with the request's params
        // so the test can observe the call timing/args. Static values are sent
        // verbatim. The try/catch ensures a thrown handler returns a JSON-RPC
        // error response — without it the RPC stays unresolved and the test
        // hangs until Playwright's outer timeout fires.
        try {
          const result =
            typeof handler === "function"
              ? await (handler as (params?: unknown) => unknown | Promise<unknown>)(msg.params)
              : handler;
          ws.send(JSON.stringify({ id: msg.id, result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: {
                code: -32000,
                message: err instanceof Error ? err.message : "Override handler failed",
              },
            }),
          );
        }
        return;
      }
      if (method === "conversation.page" && "message.list" in overrides) {
        const handler = overrides["message.list"];
        try {
          const messageResult =
            typeof handler === "function"
              ? await (handler as (params?: unknown) => unknown | Promise<unknown>)(msg.params)
              : handler;
          const paginated = Array.isArray(messageResult)
            ? { messages: messageResult, hasMore: false, answeredPlanMessageIds: [] }
            : messageResult as { messages?: unknown[]; hasMore?: boolean; answeredPlanMessageIds?: unknown[] };
          ws.send(JSON.stringify({
            id: msg.id,
            result: {
              messages: paginated.messages ?? [],
              hasMore: paginated.hasMore ?? false,
              answeredPlanMessageIds: paginated.answeredPlanMessageIds ?? [],
              narrativeByMessage: {},
            },
          }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: {
                code: -32000,
                message: err instanceof Error ? err.message : "Override handler failed",
              },
            }),
          );
        }
        return;
      }
      // Default responses
      let result: unknown;
      // `message.list` matches the generic *.list branch below but must return a
      // paginated shape; returning [] leaves loadMessages in an error state.
      if (method === "message.list") {
        result = { messages: [], hasMore: false, answeredPlanMessageIds: [] };
      } else if (method === "conversation.page") {
        result = {
          messages: [],
          hasMore: false,
          answeredPlanMessageIds: [],
          narrativeByMessage: {},
        };
      } else if (method === "permission.listPending") {
        result = [];
      } else if (method === "thread.getTasks") {
        result = [];
      } else if (method === "snapshot.listByThread") {
        result = [];
      } else if (method === "providers.listAvailability") {
        result = [];
      } else if (method?.endsWith(".list") || method === "provider.listModels") result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "agent.listRunning") result = [];
      else if (method === "push.subscribeThread" || method === "push.unsubscribeThread") result = undefined;
      else if (method === "agent.dismissPlanQuestions") result = undefined;
      else if (method === "plan.list") result = [];
      else if (method === "thread.syncPrs") result = [];
      else if (method === "workspace.enrich") result = { items: [] };
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      // Return canonical settings defaults so App can bootstrap correctly.
      // Using getDefaultSettings() ensures this stays in sync with schema changes.
      else if (method === "settings.get") result = getDefaultSettings();
      else if (method === "workspace.reorder") result = { ok: true };
      else {
        ws.send(
          JSON.stringify({
            id: msg.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  return {
    async sendNotification(method: string, params?: unknown): Promise<void> {
      const ws = await wsReady;
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    async sendPush(channel: string, data: unknown): Promise<void> {
      const ws = await wsReady;
      ws.send(JSON.stringify({ type: "push", channel, data }));
    },
  };
}

/**
 * Intercept the Vite-bundled zustand.js to inject a store registry on
 * `window.__mcodeStores`. Uses a regex to locate the
 * `const api = { ... subscribe ... };` block so the patch survives
 * formatting or whitespace changes.
 */
export async function interceptZustandStores(page: Page): Promise<void> {
  await page.route("**/zustand.js*", async (route) => {
    const response = await route.fetch();
    const originalBody = await response.text();

    const apiBlockPattern = /const api\s*=\s*\{[\s\S]*?subscribe[\s\S]*?\};/m;
    const match = apiBlockPattern.exec(originalBody);
    if (!match) {
      throw new Error(
        "[E2E] Could not find zustand `const api = { ... subscribe ... }` block to patch",
      );
    }

    const injection = `\n\tif (typeof window !== "undefined") {
\t\twindow.__mcodeStores = window.__mcodeStores || [];
\t\twindow.__mcodeStores.push(api);
\t}`;

    const patchedBody =
      originalBody.slice(0, match.index + match[0].length) +
      injection +
      originalBody.slice(match.index + match[0].length);

    await route.fulfill({
      status: response.status(),
      headers: Object.fromEntries(
        response.headersArray().map((h) => [h.name, h.value]),
      ),
      body: patchedBody,
    });
  });
}
