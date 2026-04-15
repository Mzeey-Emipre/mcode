import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { fileURLToPath } from "url";
import path from "path";

const SCREENSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");

// Default settings matching the schema
const DEFAULT_SETTINGS = {
  appearance: { theme: "dark" },
  agent: { maxConcurrent: 3, defaults: { mode: "chat", permission: "supervised" } },
  model: {
    defaults: {
      provider: "claude",
      id: "claude-sonnet-4-6",
      fallbackId: "claude-sonnet-4-6",
      reasoning: "high",
    },
  },
  provider: { cli: { codex: "", claude: "", copilot: "" } },
  prDraft: { provider: "", model: "" },
  terminal: { scrollback: 1000 },
  notifications: { enabled: false },
  worktree: { naming: { mode: "auto", aiConfirmation: true } },
  server: { memory: { heapMb: 96 } },
};

const SECTIONS = ["Model", "Agent", "Worktrees", "Appearance", "Notifications", "Terminal", "Server"];

test.describe("Settings visual review", () => {
  test.beforeEach(async ({ page }) => {
    // Mock WS before navigating
    await mockWebSocketServer(page, {
      "settings.get": DEFAULT_SETTINGS,
      "settings.update": DEFAULT_SETTINGS,
    });
  });

  // Use longer timeout for static builds
  test.setTimeout(30000);

  test("screenshot all settings sections", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(1000);

    // Click the Settings button in sidebar footer
    const settingsBtn = page.getByRole("button", { name: "Settings" });
    await expect(settingsBtn).toBeVisible();
    await settingsBtn.click();
    await page.waitForTimeout(1000);

    // Debug: capture state after clicking Settings
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-debug.png"),
      fullPage: false,
    });

    // Screenshot each section
    for (const section of SECTIONS) {
      const navBtn = page.getByRole("button", { name: section, exact: true });
      await navBtn.click();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `settings-${section.toLowerCase()}.png`),
        fullPage: false,
      });
    }

    // Hover over a "Coming soon" provider to capture tooltip
    const modelNav = page.getByRole("button", { name: "Model", exact: true });
    await modelNav.click();
    await page.waitForTimeout(300);
    const codexBtn = page.getByRole("radio", { name: /Codex/ });
    await codexBtn.hover();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-provider-tooltip.png"),
      fullPage: false,
    });

    // Narrow viewport to test responsive wrapping
    await page.setViewportSize({ width: 768, height: 900 });
    await page.waitForTimeout(300);
    await modelNav.click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-model-narrow.png"),
      fullPage: false,
    });

    // Worktrees at narrow to verify disabled switch
    const worktreeNav = page.getByRole("button", { name: "Worktrees", exact: true });
    await worktreeNav.click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-worktrees-narrow.png"),
      fullPage: false,
    });

    // Wide viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(300);
    await modelNav.click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "settings-model-wide.png"),
      fullPage: false,
    });
  });
});
