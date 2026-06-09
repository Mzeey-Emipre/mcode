import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Open-in apps the fake desktop bridge reports as installed. The renderer reads
 * this through `window.desktopBridge.listOpenInApps()` (see ws-transport), so
 * injecting it before load drives the External Apps picker without Electron.
 */
const INSTALLED_APPS = [
  { id: "code", label: "VS Code", kind: "editor", iconKey: "vscode", detected: true },
  { id: "cursor", label: "Cursor", kind: "editor", iconKey: "cursor", detected: true },
  { id: "explorer", label: "File Explorer", kind: "fileManager", iconKey: "explorer", detected: true },
];

/** Inject a fake desktop bridge exposing the open-in registry before the page loads. */
async function setupBridge(page: Page, apps: unknown[]): Promise<void> {
  await page.addInitScript((injected: unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = {
      listOpenInApps: () => Promise.resolve(injected),
      openIn: () => Promise.resolve(),
    };
  }, apps);
}

/** Open Settings and navigate to the External Apps section. */
async function openExternalApps(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  const navBtn = page.getByRole("button", { name: "External Apps", exact: true });
  await expect(navBtn).toBeVisible();
  await navBtn.click();
  await expect(page.getByTestId("settings-default-open-in-trigger")).toBeVisible();
}

test.describe("Settings — External Apps default open-in", () => {
  test.setTimeout(30_000);

  test("selecting an app writes externalApps.defaultEditor; Auto clears it", async ({ page }) => {
    // Server-side settings the mock keeps in sync, so the trigger reflects writes.
    const settings = getDefaultSettings();
    const updateCalls: unknown[] = [];

    await setupBridge(page, INSTALLED_APPS);
    await mockWebSocketServer(page, {
      "settings.get": () => settings,
      "settings.update": (params) => {
        const partial = params as { externalApps?: { defaultEditor?: string } };
        if (partial?.externalApps?.defaultEditor !== undefined) {
          settings.externalApps.defaultEditor = partial.externalApps.defaultEditor;
        }
        updateCalls.push(params);
        return settings;
      },
    });

    await openExternalApps(page);

    const trigger = page.getByTestId("settings-default-open-in-trigger");
    // Tier-3 default: no global setting yet, so the control reads "Auto".
    await expect(trigger).toHaveText(/Auto/);

    // Pick VS Code from the combobox.
    await trigger.click();
    await page.getByTestId("settings-provider-option-code").click();

    await expect
      .poll(() => updateCalls.at(-1))
      .toEqual({ externalApps: { defaultEditor: "code" } });
    await expect(trigger).toHaveText(/VS Code/);

    // Clear back to auto-resolution via the Auto option.
    await trigger.click();
    await page.getByTestId("settings-provider-option-auto").click();

    await expect
      .poll(() => updateCalls.at(-1))
      .toEqual({ externalApps: { defaultEditor: "" } });
    await expect(trigger).toHaveText(/Auto/);
  });
});
