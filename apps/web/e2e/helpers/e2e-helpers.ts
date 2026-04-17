import type { Page, WebSocketRoute } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Optional overrides for RPC responses. Keyed by method name.
 * The value is the result to return for that method.
 */
export type RpcOverrides = Record<string, unknown>;

/**
 * Controller returned by {@link mockWebSocketServer} to send server-initiated
 * push notifications to the client.
 */
export interface WsController {
  /** Send a JSON-RPC notification (no `id`) to the connected client. */
  sendNotification(method: string, params?: unknown): Promise<void>;
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

    ws.onMessage((data) => {
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
        ws.send(JSON.stringify({ id: msg.id, result: overrides[method] }));
        return;
      }
      // Default responses
      let result: unknown;
      if (method?.endsWith(".list") || method === "provider.listModels") result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      // Return canonical settings defaults so App can bootstrap correctly.
      // Using getDefaultSettings() ensures this stays in sync with schema changes.
      else if (method === "settings.get") result = getDefaultSettings();
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
