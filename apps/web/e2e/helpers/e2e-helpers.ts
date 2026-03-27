import type { Page } from "@playwright/test";

/**
 * Optional overrides for RPC responses. Keyed by method name.
 * The value is the result to return for that method.
 */
export type RpcOverrides = Record<string, unknown>;

/**
 * Mock the WebSocket server so the WS transport connects and RPC calls
 * resolve instead of hanging forever. Returns proper JSON-RPC error
 * responses for parse failures and unknown methods.
 */
export async function mockWebSocketServer(
  page: Page,
  overrides: RpcOverrides = {},
): Promise<void> {
  await page.routeWebSocket(/ws:\/\/localhost:3100/, (ws) => {
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
      if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
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
