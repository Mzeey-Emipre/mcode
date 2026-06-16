import { test, expect, type Page } from "@playwright/test";

/**
 * Shared mock plus a resize-call counter captured in closure so the test
 * can assert RPC frequency. Each request is resolved with `true` so the
 * frontend's `.catch(() => {})` never silently hides a real failure.
 *
 * Note: the terminal-resize assertion depends on the panel actually mounting
 * a terminal. If the active-thread mock infra is not yet in place, the drag
 * portion of this test may short-circuit; see terminal-leak.spec.ts for the
 * matching baseline-only pattern.
 */
async function mockWebSocketServerWithResizeCounter(
  page: Page,
  state: { resizeCalls: number },
): Promise<void> {
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
      else if (method === "settings.get") {
        // Minimal default shape; the frontend only reads
        // settings.terminal.scrollback on terminal mount.
        result = { terminal: { scrollback: 1000 } };
      } else if (method === "terminal.create") {
        ptyCounter += 1;
        result = `pty-test-${ptyCounter}`;
      } else if (method === "terminal.resize") {
        state.resizeCalls += 1;
        result = true;
      } else if (
        method === "terminal.write" ||
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

test.describe("Terminal resize debouncing", () => {
  test("continuous drag emits at most one terminal.resize RPC after release", async ({ page }) => {
    const state = { resizeCalls: 0 };
    await mockWebSocketServerWithResizeCounter(page, state);

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Try to open the panel and create a terminal. If the app has no active
    // thread under the current E2E mock, the "new terminal" button won't be
    // reachable — in that case we simply verify the test harness wiring is
    // intact and return; the real assertion runs when thread-mock infra lands.
    await page.keyboard.press("Control+J");
    const newTerminalButton = page.getByRole("button", { name: /new terminal/i });
    const buttonAvailable = await newTerminalButton.isVisible().catch(() => false);
    test.skip(
      !buttonAvailable,
      "new-terminal button unavailable in current mock infra (pre-existing)",
    );

    await newTerminalButton.click();
    await page.waitForTimeout(200);

    // The first mount may emit an initial resize RPC. Snapshot the count
    // AFTER the mount settles so we only measure the drag-induced delta.
    const baseline = state.resizeCalls;

    // Drag handle: 1px-high row-resize bar at the top of the panel.
    const handle = page.locator(".cursor-row-resize").first();
    const box = await handle.boundingBox();
    expect(box, "drag handle must be visible").not.toBeNull();

    // Continuous drag for ~500ms: 10 small steps upward, 50ms apart.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 0.5);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(
        box!.x + box!.width / 2,
        box!.y + 0.5 - i * 4,
        { steps: 2 },
      );
      await page.waitForTimeout(50);
    }
    await page.mouse.up();

    // 100ms debounce + 150ms safety margin
    await page.waitForTimeout(250);

    const delta = state.resizeCalls - baseline;
    expect(delta, `expected ≤1 resize RPC after drag, got ${delta}`).toBeLessThanOrEqual(1);
  });
});
