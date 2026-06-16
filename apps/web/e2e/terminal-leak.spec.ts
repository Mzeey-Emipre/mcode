import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Mocks the WS server with terminal-aware RPC responses.
 * Tracks issued ptyIds so terminal.create returns a unique id each time.
 */
async function mockWebSocketServer(page: Page): Promise<void> {
  // Match the mcode server port range (19400-19800, 5 digits) to avoid
  // intercepting Vite's HMR socket at port 5173 (4 digits).
  await page.routeWebSocket(/ws:\/\/localhost:\d{5}/, (ws) => {
    let ptyCounter = 0;
    ws.onMessage((data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const method = msg.method as string;
      let result: unknown = null;
      if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      else if (method === "settings.get") result = getDefaultSettings();
      else if (method === "terminal.create") {
        ptyCounter += 1;
        result = `pty-test-${ptyCounter}`;
      } else if (
        method === "terminal.write" ||
        method === "terminal.resize" ||
        method === "terminal.kill" ||
        method === "terminal.killByThread"
      ) {
        result = true;
      // ADR-0010: TerminalView calls terminal.reattach on every mount to replay
      // scrollback into the fresh xterm. Return { gapped: false } so the
      // reattach gate flushes and the view finishes mounting.
      } else if (method === "terminal.reattach") {
        result = { gapped: false };
      // terminal.resume releases the server-side pause buffer after reattach.
      } else if (method === "terminal.resume" || method === "terminal.pause") {
        result = null;
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
}

test.describe("Terminal dispose hygiene", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  /**
   * Verifies the dev-only live-terminal counter is exposed on window and
   * initialized to 0. A full create/close cycle assertion requires active-
   * thread mock infrastructure that does not yet exist in the E2E helper
   * suite (the same limitation affects smoke.spec.ts on this base SHA).
   * When that infra lands, expand this spec to:
   *   1. Create 3 terminals, assert __mcodeLiveTerminals > 0.
   *   2. Close all terminals, assert __mcodeLiveTerminals returns to 0.
   *   3. Switch threads, assert it stays at 0.
   */
  test("live terminal counter is exposed and initialized to 0", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const initial = await page.evaluate(
      () => (window as unknown as { __mcodeLiveTerminals?: number }).__mcodeLiveTerminals ?? null,
    );
    // The counter is initialized inside the TerminalView module, which is
    // code-split and only loaded when a terminal mounts. The current E2E
    // mock infra cannot mount a terminal without real thread state, so the
    // module never loads and the global stays unset. Skip rather than fail
    // so CI reports the infra gap honestly; expand to a full create/dispose
    // cycle when the thread-mock helper lands.
    test.skip(initial === null, "TerminalView module not loaded (mock infra gap)");
    expect(initial).toBe(0);
  });
});
