import { test, expect } from "@playwright/test";

test("diag3 - check page after WS mock", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.routeWebSocket(/ws:\/\/localhost:3100/, (ws) => {
    ws.onMessage((data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const method = msg.method as string;
      let result: unknown = null;
      if (method?.endsWith(".list")) result = [];
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  await page.goto("/");
  await page.waitForTimeout(3000);
  const rootHtml = await page.evaluate(() => document.getElementById("root")?.innerHTML ?? "");
  console.log("PAGE ERRORS:", JSON.stringify(errors));
  console.log("ROOT (first 200):", rootHtml.slice(0, 200));
  expect(rootHtml.length).toBeGreaterThan(10);
});
