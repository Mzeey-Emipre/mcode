import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, type RpcOverrides } from "./helpers/e2e-helpers";

/**
 * E2E coverage for the slash-command popup. Verifies the four user-visible
 * behaviors introduced by the slash-command loading-fixes work:
 *  - the popup renders the full mixed command list (built-ins + skills + commands)
 *  - typing further filters the list
 *  - a server-side error surfaces an ErrorRow with a Retry button
 *  - a Refresh button is rendered in the popup footer
 *
 * Each test captures a full-page screenshot to
 * `apps/web/e2e/screenshots/slash-command/` for visual verification.
 */

const NOW = new Date().toISOString();

const WORKSPACE = {
  id: "ws-1",
  name: "Test Workspace",
  path: "/test/path",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: NOW,
  updated_at: NOW,
};

const THREAD = {
  id: "thread-1",
  workspace_id: "ws-1",
  title: "Slash Command Test Thread",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: NOW,
  updated_at: NOW,
  model: "claude-3-5-sonnet",
  provider: "claude",
  deleted_at: null,
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

/** Cursor-backed thread — `skill.list` must receive `providerId: "cursor"`. */
const THREAD_CURSOR = {
  ...THREAD,
  provider: "cursor" as const,
  model: "cursor-auto",
};

/** Codex-backed thread — prompt commands must be scoped to Codex. */
const THREAD_CODEX = {
  ...THREAD,
  provider: "codex" as const,
  model: "gpt-5.2-codex",
};

/** Varied skills payload covering multiple kinds and sources. */
const FIXTURE_SKILLS = [
  { name: "superpowers:brainstorming", description: "Generate ideas creatively", kind: "skill", source: "user" },
  { name: "superpowers:writing-plans", description: "Plan implementations carefully", kind: "skill", source: "user" },
  { name: "superpowers:executing-plans", description: "Execute multi-step plans", kind: "skill", source: "user" },
  { name: "writing-clearly-and-concisely", description: "Polish prose for humans", kind: "command", source: "project" },
  { name: "review-pr", description: "Review a pull request end-to-end", kind: "command", source: "project" },
  { name: "hookify:hookify", description: "Configure hookify rules", kind: "skill", source: "plugin" },
  { name: "claude-code-setup:claude-automation-recommender", description: "Recommend automations", kind: "skill", source: "plugin" },
  { name: "tdd-workflow", description: "Follow strict TDD discipline", kind: "skill", source: "agent" },
];

/** Plugin-style payload large enough to cover the slash popup's long-list path. */
const LONG_PLUGIN_SKILLS = Array.from({ length: 25 }, (_, i) => ({
  name: `example-plugin:skill-${i.toString().padStart(2, "0")}`,
  description: `Example plugin skill ${i}`,
  kind: "skill" as const,
  source: "plugin" as const,
}));

/** Boot the app with one workspace + one thread, plus caller-supplied overrides. */
async function bootApp(page: Page, extra: RpcOverrides = {}): Promise<void> {
  await mockWebSocketServer(page, {
    "workspace.list": [WORKSPACE],
    "thread.list": [THREAD],
    "message.list": [],
    ...extra,
  });
}

/** Activate the thread and focus the lexical editor; type prefix; await popup. */
async function openPopup(page: Page, prefix: string): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // Projects and their thread lists have independent controls in the sidebar.
  await page.getByRole("button", { name: "Toggle threads for Test Workspace", exact: true }).click();
  await page.waitForSelector("[data-testid='thread-item']");
  await page.locator("[data-testid='thread-item']").first().click();

  const editor = page.locator("[contenteditable='true']").first();
  await editor.waitFor({ state: "visible" });
  await editor.click();
  await page.keyboard.type(prefix);

  await page.waitForSelector("[data-slash-popup]");
}

test.describe("Slash command popup", () => {
  test("01 - popup open shows the full mixed command list", async ({ page }) => {
    await bootApp(page, { "skill.list": FIXTURE_SKILLS });
    await openPopup(page, "/");

    const popup = page.locator("[data-slash-popup]");
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("data-composer-autocomplete", "true");
    const [popupBox, composerBox] = await Promise.all([
      popup.boundingBox(),
      page.getByTestId("composer-surface").boundingBox(),
    ]);
    expect(popupBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(popupBox?.x).toBeCloseTo((composerBox?.x ?? 0) + 14, 0);
    expect(popupBox?.width).toBeCloseTo((composerBox?.width ?? 0) - 28, 0);
    expect(
      Math.abs((popupBox?.y ?? 0) + (popupBox?.height ?? 0) - (composerBox?.y ?? 0)),
    ).toBeLessThanOrEqual(2);
    await expect(popup.getByText("/compact")).toBeVisible();
    await expect(popup.getByText("/superpowers:brainstorming")).toBeVisible();
    await expect(popup.getByText("/hookify:hookify")).toBeVisible();
    await expect(popup.getByTestId("slash-command-group-mcode")).toContainText("Mcode");
    await expect(popup.getByTestId("slash-command-group-plugin")).toContainText("Plugins");

    await page.screenshot({
      path: "e2e/screenshots/slash-command/01-popup-open.png",
      fullPage: true,
    });
  });

  test("02 - popup filters as the user keeps typing", async ({ page }) => {
    await bootApp(page, { "skill.list": FIXTURE_SKILLS });
    await openPopup(page, "/sup");

    const popup = page.locator("[data-slash-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.getByText("/superpowers:brainstorming")).toBeVisible();
    await expect(popup.getByText("/superpowers:writing-plans")).toBeVisible();
    await expect(popup.getByText("/compact")).toHaveCount(0);

    await page.screenshot({
      path: "e2e/screenshots/slash-command/02-popup-filtered.png",
      fullPage: true,
    });
  });

  test("popup stays above the composer text", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 400 });
    await bootApp(page, { "skill.list": LONG_PLUGIN_SKILLS });
    await openPopup(page, "/");

    const popup = page.locator("[data-slash-popup]");
    const editor = page.locator("[contenteditable='true']").first();
    const [popupBox, editorBox] = await Promise.all([
      popup.boundingBox(),
      editor.boundingBox(),
    ]);

    expect(popupBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(editorBox!.y);

    await page.screenshot({
      path: "e2e/screenshots/slash-command/02b-popup-small-viewport.png",
      fullPage: true,
    });
  });

  test("03 - error response surfaces ErrorRow with Retry button", async ({ page }) => {
    // Mirror the shared helper's defaults but force `skill.list` to return a
    // JSON-RPC error. The shared mock helper only supports successful result
    // overrides, so we register a self-contained route that uses
    // `getDefaultSettings()` for bootstrap parity.
    // Match any host:port (localhost, 127.0.0.1, custom ports) so this test
    // doesn't break if the dev server's launch shape changes.
    await page.routeWebSocket(/ws:\/\/[^/]+/, (ws) => {
      ws.onMessage((data) => {
        const msg = JSON.parse(data.toString()) as { id?: string | number; method?: string };
        const method = msg.method;
        if (method === "skill.list") {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: "Failed to enumerate skills directory" },
            }),
          );
          return;
        }
        let result: unknown;
        if (method === "workspace.list") result = [WORKSPACE];
        else if (method === "thread.list") result = [THREAD];
        else if (method?.endsWith(".list") || method === "provider.listModels") result = [];
        else if (method === "git.currentBranch") result = "main";
        else if (method === "agent.activeCount") result = 0;
        else if (method === "app.version") result = "0.0.1-test";
        else if (method === "config.discover") result = {};
        else if (method === "settings.get") result = getDefaultSettings();
        else {
          ws.send(
            JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found" } }),
          );
          return;
        }
        ws.send(JSON.stringify({ id: msg.id, result }));
      });
    });
    await openPopup(page, "/");

    const popup = page.locator("[data-slash-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.locator("[role='alert']")).toBeVisible();
    await expect(popup.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(popup).toContainText("Couldn't load commands");

    await page.screenshot({
      path: "e2e/screenshots/slash-command/03-error-row.png",
      fullPage: true,
    });
  });

  test("04 - footer renders the Refresh button", async ({ page }) => {
    await bootApp(page, { "skill.list": FIXTURE_SKILLS });
    await openPopup(page, "/");

    const popup = page.locator("[data-slash-popup]");
    await expect(popup).toBeVisible();
    const refresh = popup.getByRole("button", { name: "Refresh commands" });
    await expect(refresh).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/slash-command/04-refresh-button.png",
      fullPage: true,
    });
  });

  test("05 - cursor provider thread scopes skill.list to providerId cursor", async ({ page }) => {
    let listParams: { cwd?: string; providerId?: string } | undefined;
    const cursorSkills = [
      {
        name: "cursor-plugin:deploy",
        description: "Example Cursor-only skill entry",
        kind: "skill" as const,
        source: "plugin" as const,
        providers: ["cursor"],
      },
    ];

    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD_CURSOR],
      "message.list": [],
      "skill.list": (params) => {
        listParams = params as { cwd?: string; providerId?: string };
        return cursorSkills;
      },
    });

    await openPopup(page, "/cursor");

    expect(listParams?.providerId).toBe("cursor");

    const popup = page.locator("[data-slash-popup]");
    await expect(popup.getByText("/cursor-plugin:deploy")).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/slash-command/05-cursor-provider-skills.png",
      fullPage: true,
    });
  });

  test("06 - codex provider thread shows prompt commands in completion", async ({ page }) => {
    let listParams: { cwd?: string; providerId?: string } | undefined;
    const codexPrompts = [
      {
        name: "prompts:draftpr",
        description: "Draft a pull request",
        kind: "command" as const,
        source: "user" as const,
        providers: ["codex"],
        nativeName: "draftpr",
      },
    ];

    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD_CODEX],
      "message.list": [],
      "skill.list": (params) => {
        listParams = params as { cwd?: string; providerId?: string };
        return codexPrompts;
      },
    });

    await openPopup(page, "/prompts");

    expect(listParams?.providerId).toBe("codex");

    const popup = page.locator("[data-slash-popup]");
    await expect(popup.getByText("/prompts:draftpr")).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/slash-command/06-codex-prompt-command.png",
      fullPage: true,
    });
  });

  test("07 - long plugin skill list opens without React flushSync warning", async ({ page }) => {
    const flushSyncWarnings: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("flushSync was called")) flushSyncWarnings.push(text);
    });

    await bootApp(page, { "skill.list": LONG_PLUGIN_SKILLS });
    await openPopup(page, "/example-plugin");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("[role='option']")).toHaveCount(25);
    await page.waitForTimeout(100);

    expect(flushSyncWarnings).toEqual([]);
  });
});
