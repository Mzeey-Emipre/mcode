import { test, expect } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

// These tests verify the correct reasoning tier options appear in the Model
// Settings section for different Claude models without running a live agent session.
// Tests are not run against a live server — they mock the WebSocket transport.

/**
 * Builds a full settings object with the given Claude model pre-selected.
 * Spreads `getDefaultSettings()` so every required section (performance, preview,
 * etc.) is present — a partial object crashes App.tsx on first render.
 */
function makeSettings(modelId: string, reasoning = "high") {
  const defaults = getDefaultSettings();
  return {
    ...defaults,
    model: {
      ...defaults.model,
      defaults: {
        ...defaults.model.defaults,
        provider: "claude",
        id: modelId,
        fallbackId: "",
        reasoning,
      },
    },
  };
}

/** Navigate to the settings panel and open the Model section. */
async function openModelSettings(page: Parameters<typeof mockWebSocketServer>[0]) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const settingsBtn = page.getByRole("button", { name: "Settings" });
  await expect(settingsBtn).toBeVisible({ timeout: 10000 });
  await settingsBtn.click();

  const modelNav = page.getByRole("button", { name: "Model", exact: true });
  await expect(modelNav).toBeVisible();
  await modelNav.click();
  await page.waitForTimeout(300);
}

/**
 * Finds the reasoning SegControl by anchoring off the "Reasoning effort" label
 * text to avoid index-based selection that breaks when rows are added or removed.
 */
function reasoningRadioGroup(page: Parameters<typeof mockWebSocketServer>[0]) {
  // SettingRow renders the label as a <span> inside a wrapper div; we find the
  // nearest ancestor that also contains a radiogroup to stay scoped to this row.
  return page
    .locator("div")
    .filter({ hasText: /^Reasoning effort/ })
    .locator('[role="radiogroup"]')
    .first();
}

test.describe("Reasoning level picker in settings", () => {
  test.setTimeout(30000);

  test("Claude Opus 4.7 shows all 6 tiers in correct order", async ({ page }) => {
    const settings = makeSettings("claude-opus-4-7", "high");
    await mockWebSocketServer(page, {
      "settings.get": settings,
      "settings.update": settings,
    });

    await openModelSettings(page);

    const radioGroup = reasoningRadioGroup(page);
    const radios = radioGroup.locator('[role="radio"]');

    // All 6 tiers must appear in Low → Medium → High → X-High → Max → Ultrathink order
    await expect(radios).toHaveCount(6);
    const labels = await radios.allInnerTexts();
    expect(labels).toEqual(["Low", "Medium", "High", "X-High", "Max", "Ultrathink"]);

    // X-High and Max are both enabled for Opus 4.7
    const xhighBtn = radios.filter({ hasText: "X-High" });
    const maxBtn = radios.filter({ hasText: "Max" });
    await expect(xhighBtn).not.toHaveAttribute("aria-disabled", "true");
    await expect(maxBtn).not.toHaveAttribute("aria-disabled", "true");
  });

  test("Claude Opus 4.6 shows X-High disabled and Max enabled", async ({ page }) => {
    const settings = makeSettings("claude-opus-4-6", "high");
    await mockWebSocketServer(page, {
      "settings.get": settings,
      "settings.update": settings,
    });

    await openModelSettings(page);

    const radioGroup = reasoningRadioGroup(page);
    const radios = radioGroup.locator('[role="radio"]');

    await expect(radios).toHaveCount(6);
    const labels = await radios.allInnerTexts();
    expect(labels).toEqual(["Low", "Medium", "High", "X-High", "Max", "Ultrathink"]);

    // Opus 4.6 supports Max but not X-High
    const xhighBtn = radios.filter({ hasText: "X-High" });
    const maxBtn = radios.filter({ hasText: "Max" });
    await expect(xhighBtn).toHaveAttribute("aria-disabled", "true");
    await expect(maxBtn).not.toHaveAttribute("aria-disabled", "true");
  });

  test("Claude Sonnet 4.6 shows X-High disabled and Max enabled", async ({ page }) => {
    const settings = makeSettings("claude-sonnet-4-6", "high");
    await mockWebSocketServer(page, {
      "settings.get": settings,
      "settings.update": settings,
    });

    await openModelSettings(page);

    const radioGroup = reasoningRadioGroup(page);
    const radios = radioGroup.locator('[role="radio"]');

    await expect(radios).toHaveCount(6);
    const labels = await radios.allInnerTexts();
    expect(labels).toEqual(["Low", "Medium", "High", "X-High", "Max", "Ultrathink"]);

    // Sonnet 4.6 supports Max but not X-High
    const xhighBtn = radios.filter({ hasText: "X-High" });
    const maxBtn = radios.filter({ hasText: "Max" });
    await expect(xhighBtn).toHaveAttribute("aria-disabled", "true");
    await expect(maxBtn).not.toHaveAttribute("aria-disabled", "true");
  });

  test("Claude Haiku 4.5 hides the reasoning effort row entirely", async ({ page }) => {
    const settings = makeSettings("claude-haiku-4-5", "high");
    await mockWebSocketServer(page, {
      "settings.get": settings,
      "settings.update": settings,
    });

    await openModelSettings(page);

    // The entire SettingRow is conditionally unmounted for Haiku — the label
    // must not appear anywhere in the DOM, not just hidden from view.
    await expect(page.getByText("Reasoning effort")).not.toBeVisible();
  });
});
