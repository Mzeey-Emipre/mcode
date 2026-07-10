import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";
import type { ProviderAvailability } from "@mcode/contracts";

// ── Screenshot path ───────────────────────────────────────────────────────────

const SS = (name: string) => `e2e/screenshots/provider-toggle/${name}`;

// ── Provider availability fixture ────────────────────────────────────────────

/**
 * Default CLI info for a provider with a known binary path.
 * Overridden per-provider in the factory when needed.
 */
function defaultCli(): ProviderAvailability["cli"] {
  return { status: "found", resolvedPath: "/usr/local/bin/cli", configuredPath: "" };
}

/** Per-provider overrides applied on top of the defaults below. */
type ProviderOverride = Partial<Omit<ProviderAvailability, "id"> & { cli: Partial<ProviderAvailability["cli"]> }>;
type AvailabilityOverrides = Partial<Record<ProviderAvailability["id"], ProviderOverride>>;

/**
 * Build a full 6-provider availability list that matches PROVIDER_CATALOG order.
 * Pass per-provider overrides to change specific fields for a test scenario.
 */
function makeAvailabilityFixture(overrides: AvailabilityOverrides = {}): ProviderAvailability[] {
  function make(
    id: ProviderAvailability["id"],
    base: Omit<ProviderAvailability, "id">,
  ): ProviderAvailability {
    const o = overrides[id];
    if (!o) return { id, ...base };
    const cli = o.cli ? { ...base.cli, ...o.cli } : base.cli;
    return { id, ...base, ...o, cli } as ProviderAvailability;
  }

  return [
    make("claude",   { enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, cli: defaultCli() }),
    make("codex",    { enabled: true,  hasAdapter: true,  beta: false, comingSoon: false, cli: defaultCli() }),
    make("copilot",  { enabled: true,  hasAdapter: true,  beta: true,  comingSoon: false, cli: defaultCli() }),
    make("gemini",   { enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } }),
    make("cursor",   { enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } }),
    make("opencode", { enabled: false, hasAdapter: false, beta: false, comingSoon: true,  cli: { status: "unchecked", resolvedPath: null, configuredPath: "" } }),
  ];
}

// ── Thread fixture (used for test 6) ────────────────────────────────────────

const WORKSPACE_PT = {
  id: "ws-pt-1",
  name: "Provider Toggle Test",
  path: "/tmp/pt-test",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD_CLAUDE = {
  id: "thread-pt-1",
  workspace_id: "ws-pt-1",
  title: "Claude Thread",
  status: "active" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: "claude-sonnet-4-6",
  deleted_at: null,
  worktree_managed: false,
  sdk_session_id: null,
  provider: "claude",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

// ── Shared helper: navigate to Settings → Provider ───────────────────────────

/**
 * Click the Settings button then open the Model section, where the provider
 * controls now live. Assumes the app is already loaded and at networkidle.
 */
async function openProviderSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  // Provider controls are embedded in the Model section — there is no longer a
  // separate "Provider" nav entry.
  await page.getByRole("button", { name: "Model", exact: true }).click();
  // Wait for the ProviderSection heading to confirm the section rendered.
  await expect(page.getByRole("heading", { name: "Provider" })).toBeVisible();
}

/**
 * Inject workspace + thread state and activate the given thread.
 * Mirrors the pattern from architecture.spec.ts setupWorkspaceState.
 */
async function setupWorkspaceState(
  page: Page,
  opts: {
    workspaces: typeof WORKSPACE_PT[];
    threads: typeof THREAD_CLAUDE[];
    activeWorkspaceId: string;
    activeThreadId?: string | null;
  },
): Promise<void> {
  await page.evaluate(
    ({ workspaces, threads, activeWorkspaceId, activeThreadId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces,
        activeWorkspaceId,
        threads,
        activeThreadId: activeThreadId ?? null,
        loading: false,
        error: null,
      });
    },
    opts,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("provider toggle", () => {
  test.setTimeout(30000);

  // ── Test 1: six switches + key badges visible ──────────────────────────────

  test("renders six switches with badges", async ({ page }) => {
    const availability = makeAvailabilityFixture();

    await mockWebSocketServer(page, {
      "providers.listAvailability": availability,
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openProviderSettings(page);

    // Each provider should have a switch
    const switchIds: ProviderAvailability["id"][] = [
      "claude", "codex", "copilot", "gemini", "cursor", "opencode",
    ];
    for (const id of switchIds) {
      await expect(page.getByTestId(`provider-switch-${id}`)).toBeVisible();
    }

    // Claude switch should be present and visible (already checked above, but explicit)
    await expect(page.getByTestId("provider-switch-claude")).toBeVisible();

    // Copilot should have a Beta badge
    await expect(page.getByTestId("provider-badge-copilot-beta")).toBeVisible();

    // Gemini should have a Coming soon badge
    await expect(page.getByTestId("provider-badge-gemini-comingsoon")).toBeVisible();

    await page.screenshot({ path: SS("01-settings-default.png"), fullPage: false });
  });

  // ── Test 2: available provider configuration uses disclosures ─────────────

  test("discloses stable configuration and keeps disabled Beta configuration editable", async ({ page }) => {
    const availability = makeAvailabilityFixture({
      copilot: { enabled: false },
    });

    await mockWebSocketServer(page, {
      "providers.listAvailability": availability,
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openProviderSettings(page);

    // Stable providers stay compact until the user asks to edit their path.
    await expect(page.getByTestId("provider-cli-path-claude")).not.toBeVisible();
    await page.getByTestId("provider-config-trigger-claude").click();
    await expect(page.getByTestId("provider-cli-path-claude")).toBeVisible();

    // Beta paths remain visible and editable even before the provider is enabled.
    const copilotPath = page.getByTestId("provider-cli-path-copilot");
    await expect(copilotPath).toBeVisible();
    await expect(copilotPath).toBeEditable();

    // Coming-soon providers remain static until they become available.
    await expect(page.getByTestId("provider-config-trigger-gemini")).toHaveCount(0);

    await page.screenshot({ path: SS("02-provider-disclosures.png"), fullPage: false });
  });

  // ── Test 3: toggle non-default provider off — no dialog ───────────────────

  test("toggling a non-default provider off does not show a dialog", async ({ page }) => {
    const availability = makeAvailabilityFixture();
    const settings = getDefaultSettings(); // default provider is "claude"

    await mockWebSocketServer(page, {
      "providers.listAvailability": availability,
      "settings.get": settings,
      "settings.update": settings,
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openProviderSettings(page);

    // Copilot is enabled but NOT the default provider (claude is).
    // Clicking its switch should toggle off without showing a confirm dialog.
    const copilotSwitch = page.getByTestId("provider-switch-copilot");
    await expect(copilotSwitch).toBeVisible();
    await expect(copilotSwitch).not.toBeDisabled();
    await copilotSwitch.click();

    // No dialog should appear
    await expect(page.getByRole("dialog")).not.toBeVisible();

    await page.screenshot({ path: SS("02-toggle-non-default.png"), fullPage: false });
  });

  // ── Test 3: toggling the default provider shows the confirm dialog ─────────

  test("toggling the default provider off shows the confirm dialog", async ({ page }) => {
    const availability = makeAvailabilityFixture();
    // Override default provider to "codex" so clicking codex triggers the dialog.
    const settings = {
      ...getDefaultSettings(),
      model: {
        ...getDefaultSettings().model,
        defaults: {
          ...getDefaultSettings().model.defaults,
          provider: "codex" as const,
        },
      },
    };

    await mockWebSocketServer(page, {
      "providers.listAvailability": availability,
      "settings.get": settings,
      "settings.update": settings,
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openProviderSettings(page);

    // Click codex switch (it is the current default provider)
    const codexSwitch = page.getByTestId("provider-switch-codex");
    await expect(codexSwitch).toBeVisible();
    await expect(codexSwitch).not.toBeDisabled();
    await codexSwitch.click();

    // Confirm dialog should appear
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Dialog title should mention "Disable Codex"
    await expect(dialog.getByRole("heading", { name: /Disable Codex/i })).toBeVisible();

    // Dialog body should mention the replacement (Claude, first in catalog)
    await expect(dialog.getByText(/Claude/i)).toBeVisible();

    await page.screenshot({ path: SS("03-confirm-dialog.png"), fullPage: false });
  });

  // ── Test 4: CLI missing shows the red badge ───────────────────────────────

  test("CLI missing shows the red badge", async ({ page }) => {
    const availability = makeAvailabilityFixture({
      codex: { cli: { status: "not_found", resolvedPath: null, configuredPath: "" } },
    });

    await mockWebSocketServer(page, {
      "providers.listAvailability": availability,
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openProviderSettings(page);

    // The CLI missing badge for codex should be visible
    await expect(page.getByTestId("provider-badge-codex-cli-missing")).toBeVisible();

    await page.screenshot({ path: SS("04-cli-missing-badge.png"), fullPage: false });
  });

  // ── Test 5: coming-soon provider switch is disabled ───────────────────────

  test("coming-soon provider switch is disabled", async ({ page }) => {
    const availability = makeAvailabilityFixture();

    await mockWebSocketServer(page, {
      "providers.listAvailability": availability,
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await openProviderSettings(page);

    // gemini is comingSoon=true, so its switch must be disabled
    const geminiSwitch = page.getByTestId("provider-switch-gemini");
    await expect(geminiSwitch).toBeVisible();
    await expect(geminiSwitch).toBeDisabled();

    await page.screenshot({ path: SS("05-coming-soon-disabled.png"), fullPage: false });
  });

  // ── Test 6: composer banner when thread provider is disabled ──────────────

  test("composer shows unavailable banner when thread provider is disabled", async ({ page }) => {
    // Start with claude enabled so the app boots cleanly.
    const initialAvailability = makeAvailabilityFixture();

    const controller = await mockWebSocketServer(page, {
      "providers.listAvailability": initialAvailability,
      // Return empty list so loadMessages resolves immediately. Shape must match
      // PaginatedMessagesSchema: { messages, hasMore }.
      "message.list": { messages: [], hasMore: false },
    });

    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Inject workspace + thread into the store, then activate the thread.
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_PT],
      threads: [THREAD_CLAUDE],
      activeWorkspaceId: WORKSPACE_PT.id,
      activeThreadId: THREAD_CLAUDE.id,
    });

    // Wait for the composer to appear (confirms the thread is active).
    await expect(page.locator('[contenteditable="true"]')).toBeVisible({ timeout: 5000 });

    // Push an availability update with claude disabled.
    await controller.sendPush("providers.availability", makeAvailabilityFixture({
      claude: { enabled: false },
    }));

    // The unavailable banner should appear.
    await expect(page.getByTestId("provider-unavailable-banner")).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: SS("06-composer-banner.png"), fullPage: false });
  });
});
