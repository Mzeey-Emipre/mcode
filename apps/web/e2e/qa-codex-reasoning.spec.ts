import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { fileURLToPath } from "url";
import path from "path";

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

/** Settings with Codex-aware fields. Mutable so the mock can reflect updates. */
let currentSettings = makeDefaultSettings("claude", "claude-sonnet-4-6", "high");

function makeDefaultSettings(provider: string, modelId: string, reasoning: string) {
  return {
    appearance: { theme: "dark" },
    agent: { maxConcurrent: 3, defaults: { mode: "chat", permission: "supervised" } },
    model: {
      defaults: { provider, id: modelId, fallbackId: "claude-sonnet-4-6", reasoning },
    },
    terminal: { scrollback: 1000 },
    notifications: { enabled: false },
    worktree: { naming: { mode: "auto", aiConfirmation: true } },
    server: { memory: { heapMb: 96 } },
    provider: { cli: { codex: "", claude: "", copilot: "" } },
    prDraft: { provider: "", model: "" },
  };
}

test.describe("Codex reasoning selector QA", () => {
  test.beforeEach(async ({ page }) => {
    currentSettings = makeDefaultSettings("claude", "claude-sonnet-4-6", "high");

    // Mock WS: settings.update merges the partial and returns updated settings
    await mockWebSocketServer(page, {
      "settings.get": currentSettings,
      get "settings.update"() {
        return currentSettings;
      },
    });

    // Override settings.update to actually apply the partial
    // We need a more dynamic mock. Re-route the WS to handle updates.
  });

  test.setTimeout(30000);

  test("Codex models show X-High reasoning, Claude shows Max", async ({ page }) => {
    // Override the WS mock to handle settings.update dynamically
    await page.routeWebSocket(/ws:\/\/localhost:\d+/, (ws) => {
      ws.onMessage((data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          ws.send(JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }));
          return;
        }
        const method = msg.method as string;
        const id = msg.id;

        if (method === "settings.get") {
          ws.send(JSON.stringify({ id, result: currentSettings }));
        } else if (method === "settings.update") {
          // Deep merge the partial into current settings
          const partial = (msg.params as Record<string, unknown>[])?.[0] ?? msg.params;
          deepMerge(currentSettings, partial);
          ws.send(JSON.stringify({ id, result: currentSettings }));
        } else if (method?.endsWith(".list")) {
          ws.send(JSON.stringify({ id, result: [] }));
        } else if (method === "git.currentBranch") {
          ws.send(JSON.stringify({ id, result: "main" }));
        } else if (method === "agent.activeCount") {
          ws.send(JSON.stringify({ id, result: 0 }));
        } else if (method === "app.version") {
          ws.send(JSON.stringify({ id, result: "0.0.1-test" }));
        } else if (method === "config.discover") {
          ws.send(JSON.stringify({ id, result: {} }));
        } else {
          ws.send(JSON.stringify({ id, error: { code: -32601, message: "Method not found" } }));
        }
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(2000);

    // Open settings
    const settingsBtn = page.getByRole("button", { name: "Settings" });
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
    await settingsBtn.click();
    await page.waitForTimeout(500);

    // Verify Claude default: reasoning shows Low, Medium, High, Max
    const reasoningGroup = () => page.locator('[role="radiogroup"]').nth(3);
    const claudeOptions = await reasoningGroup().locator('[role="radio"]').allInnerTexts();
    console.log(`Claude reasoning: ${claudeOptions.join(", ")}`);
    expect(claudeOptions).toContain("Max");
    expect(claudeOptions).not.toContain("X-High");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "qa-01-claude-reasoning.png") });

    // Switch to Codex provider
    const codexRadio = page.getByRole("radio", { name: "Codex" });
    await codexRadio.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "qa-02-codex-selected.png") });

    // Verify model list changed to Codex models
    const modelGroup = page.locator('[role="radiogroup"]').nth(1);
    const modelTexts = await modelGroup.locator('[role="radio"]').allInnerTexts();
    console.log(`Codex models: ${modelTexts.join(", ")}`);
    expect(modelTexts.some((t: string) => t.includes("GPT"))).toBeTruthy();

    // Verify reasoning options now show X-High instead of Max
    const codexOptions = await reasoningGroup().locator('[role="radio"]').allInnerTexts();
    console.log(`Codex reasoning: ${codexOptions.join(", ")}`);
    expect(codexOptions).toContain("X-High");
    expect(codexOptions).not.toContain("Max");
    expect(codexOptions).toContain("Low");
    expect(codexOptions).toContain("Medium");
    expect(codexOptions).toContain("High");

    // Verify hint text is Codex-aware
    const codexHint = page.locator("text=Reasoning effort for Codex");
    await expect(codexHint).toBeVisible();

    // Click X-High and verify it's checked
    const xhighRadio = page.getByRole("radio", { name: "X-High" });
    await xhighRadio.click();
    await page.waitForTimeout(300);
    await expect(xhighRadio).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "qa-03-xhigh-selected.png") });

    // Switch back to Claude (scoped to the first Provider radiogroup to avoid
    // ambiguity with the PR Draft provider row which also contains "Claude")
    const claudeRadio = page.locator('[role="radiogroup"]').first().getByRole("radio", { name: "Claude" });
    await claudeRadio.click();
    await page.waitForTimeout(1000);

    // Verify Max is back and X-High is gone
    const restoredOptions = await reasoningGroup().locator('[role="radio"]').allInnerTexts();
    console.log(`Claude restored: ${restoredOptions.join(", ")}`);
    expect(restoredOptions).toContain("Max");
    expect(restoredOptions).not.toContain("X-High");

    // Verify Claude hint text restored
    const claudeHint = page.locator("text=Max requires Opus");
    await expect(claudeHint).toBeVisible();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "qa-04-claude-restored.png") });
  });
});

/** Deep-merge source into target (mutates target). */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (!source || typeof source !== "object") return;
  for (const key of Object.keys(source)) {
    if (
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object" &&
      target[key] !== null
    ) {
      deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = source[key];
    }
  }
}
