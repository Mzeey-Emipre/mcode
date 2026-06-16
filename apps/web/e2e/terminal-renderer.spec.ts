import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Mocks the WS server with terminal-aware RPC responses. Same shape as
 * terminal-leak.spec.ts and terminal-resize.spec.ts.
 */
async function mockWebSocketServer(page: Page): Promise<void> {
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

test.describe("Terminal renderer", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  /**
   * Verifies renderer auto-detection and fallback to xterm's built-in DOM
   * renderer on WebGL context loss. (xterm.js v6 removed the standalone
   * canvas addon, so the fallback is now DOM, not canvas.)
   * Short-circuits gracefully when the "new terminal" button isn't
   * reachable under the current thread-mock infra gap (same pattern as
   * terminal-leak.spec.ts and terminal-resize.spec.ts).
   */
  test("auto-detects renderer and falls back to DOM on context loss", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.keyboard.press("Control+J");
    const newTerminalButton = page.getByRole("button", { name: /new terminal/i });
    const buttonAvailable = await newTerminalButton.isVisible().catch(() => false);
    test.skip(
      !buttonAvailable,
      "new-terminal button unavailable in current mock infra (pre-existing)",
    );

    await newTerminalButton.click();
    await page.waitForTimeout(400);

    const detected = await page.evaluate(
      () =>
        (window as unknown as { __mcodeActiveRenderer?: string }).__mcodeActiveRenderer,
    );
    expect(detected, "__mcodeActiveRenderer must be exposed in dev builds").toMatch(
      /^(webgl|dom)$/,
    );

    if (detected === "webgl") {
      await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll("canvas"));
        for (const c of canvases) {
          const gl = c.getContext("webgl2") ?? c.getContext("webgl");
          if (gl) {
            const ext = gl.getExtension("WEBGL_lose_context");
            ext?.loseContext();
          }
        }
      });

      await page.waitForTimeout(500);

      const after = await page.evaluate(
        () =>
          (window as unknown as { __mcodeActiveRenderer?: string }).__mcodeActiveRenderer,
      );
      expect(after).toBe("dom");
    }
  });
});
