import { test, expect, type Page } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const WORKSPACE = {
  id: "ws-1",
  name: "Test Workspace",
  path: "/test/path",
  provider_config: {},
  created_at: now,
  updated_at: now,
};

const THREAD = {
  id: "thread-1",
  workspace_id: "ws-1",
  title: "Test Thread",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: now,
  updated_at: now,
  model: "claude-sonnet-4-6",
  provider: "claude",
  deleted_at: null,
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  copilot_agent: null,
  parent_thread_id: null,
  forked_from_message_id: null,
  last_compact_summary: null,
};

/**
 * Inject a mock `window.desktopBridge.spellcheck` before the page loads so the
 * component picks it up on mount. Also exposes `window.__spellcheckMock` for
 * test-side control (trigger IPC events, read recorded calls).
 */
async function injectSpellcheckBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let storedCallback: ((data: unknown) => void) | null = null;
    const calls: { replace: string[]; addToDictionary: string[] } = {
      replace: [],
      addToDictionary: [],
    };

    const bridge = {
      onContextMenu(cb: (data: unknown) => void): (data: unknown) => void {
        storedCallback = cb;
        return cb;
      },
      offContextMenu(_listener: unknown): void {
        storedCallback = null;
      },
      replaceMisspelling(word: string): Promise<void> {
        calls.replace.push(word);
        return Promise.resolve();
      },
      addToDictionary(word: string): Promise<void> {
        calls.addToDictionary.push(word);
        return Promise.resolve();
      },
      paste(): Promise<void> {
        return Promise.resolve();
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = { spellcheck: bridge };

    // Test-side handle: trigger the stored callback and read recorded calls.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__spellcheckMock = {
      trigger: (data: unknown): void => storedCallback?.(data),
      calls,
    };
  });
}

/**
 * Navigate to the app with a mock workspace+thread so the Composer renders.
 * Uses a 5-digit port regex (\d{5}) to target only the mcode backend ports
 * (19400-19800 range) and avoid intercepting Vite's HMR socket at port 5173,
 * which would cause a page reload mid-test.
 */
async function openComposer(page: Page): Promise<void> {
  await mockWebSocketServer(page, {
    "workspace.list": [WORKSPACE],
    "thread.list": [THREAD],
    "message.list": [],
  });

  await page.goto("/");
  // Wait for the sidebar to render with the workspace.
  await page.waitForSelector("text=Test Workspace", { timeout: 15000 });
  // Click the workspace row to expand it and trigger thread.list.
  await page.locator("text=Test Workspace").click();
  await page.waitForSelector("[data-testid='thread-item']", { timeout: 10000 });
  await page.locator("[data-testid='thread-item']").first().click();
  // Wait for the Lexical contenteditable to appear.
  await page.waitForSelector('[contenteditable="true"]');
}

/**
 * Simulate a right-click on the Composer editor (sets `pendingPos`) then fire
 * the spellcheck IPC event from the main process.
 */
async function fireSpellcheckEvent(
  page: Page,
  data: {
    misspelledWord: string;
    suggestions: string[];
    isEditable?: boolean;
  },
): Promise<void> {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click({ button: "right" });

  await page.evaluate((payload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__spellcheckMock.trigger({
      x: 0,
      y: 0,
      misspelledWord: payload.misspelledWord,
      suggestions: payload.suggestions,
      selectionText: payload.misspelledWord,
      isEditable: payload.isEditable ?? true,
      editFlags: {
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    });
  }, data);
}

// ---------------------------------------------------------------------------
// Tests – browser with mocked desktopBridge (suggestions functionality)
// ---------------------------------------------------------------------------

test.describe("SpellcheckContextMenu – suggestions", () => {
  test.beforeEach(async ({ page }) => {
    await injectSpellcheckBridge(page);
    await openComposer(page);
  });

  test("shows spelling suggestions for a misspelled word", async ({ page }) => {
    await fireSpellcheckEvent(page, {
      misspelledWord: "teh",
      suggestions: ["the", "ten"],
    });

    await expect(page.getByRole("button", { name: "the", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "ten", exact: true })).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/spellcheck-suggestions.png" });
  });

  test("shows Add to dictionary for a misspelled word", async ({ page }) => {
    await fireSpellcheckEvent(page, {
      misspelledWord: "teh",
      suggestions: ["the"],
    });

    await expect(page.getByRole("button", { name: /add.*teh.*to dictionary/i })).toBeVisible();
  });

  test("clicking a suggestion calls replaceMisspelling with the correct word", async ({
    page,
  }) => {
    await fireSpellcheckEvent(page, {
      misspelledWord: "teh",
      suggestions: ["the", "ten"],
    });

    await page.getByRole("button", { name: "the", exact: true }).click();

    const calls = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__spellcheckMock.calls.replace,
    );
    expect(calls).toContain("the");
  });

  test("clicking Add to dictionary calls addToDictionary", async ({ page }) => {
    await fireSpellcheckEvent(page, {
      misspelledWord: "mcode",
      suggestions: [],
    });

    await page.getByRole("button", { name: /add.*mcode.*to dictionary/i }).click();

    const calls = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__spellcheckMock.calls.addToDictionary,
    );
    expect(calls).toContain("mcode");
  });

  test("shows standard edit items (Cut, Copy, Paste, Select All)", async ({ page }) => {
    await fireSpellcheckEvent(page, {
      misspelledWord: "",
      suggestions: [],
    });

    // isEditable=true so all edit flags are true - all four items should appear.
    await expect(page.getByRole("button", { name: "Cut" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select All" })).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/spellcheck-edit-items.png" });
  });

  test("menu closes after clicking a suggestion", async ({ page }) => {
    await fireSpellcheckEvent(page, {
      misspelledWord: "teh",
      suggestions: ["the"],
    });

    await page.getByRole("button", { name: "the", exact: true }).click();

    // The suggestion button should be gone once the menu closes.
    await expect(page.getByRole("button", { name: "the", exact: true })).not.toBeVisible();
  });

  test("no menu appears when IPC fires without a prior right-click on the editor", async ({
    page,
  }) => {
    // Fire the IPC without a preceding right-click - pendingPos stays null.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__spellcheckMock.trigger({
        x: 0,
        y: 0,
        misspelledWord: "teh",
        suggestions: ["the"],
        selectionText: "teh",
        isEditable: true,
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      });
    });

    await expect(page.getByRole("button", { name: "the", exact: true })).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests – browser without desktopBridge (graceful degradation)
// ---------------------------------------------------------------------------
// Diagnostic
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------

test.describe("SpellcheckContextMenu – no desktopBridge", () => {
  test("app loads without spellcheck console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const spellcheckErrors = consoleErrors.filter(
      (e) =>
        e.toLowerCase().includes("spellcheck") ||
        e.toLowerCase().includes("desktopbridge"),
    );
    expect(spellcheckErrors).toHaveLength(0);
  });

  test("right-click does not crash when desktopBridge is absent", async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bridge = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).desktopBridge,
    );
    expect(bridge).toBeUndefined();

    await page.locator("body").click({ button: "right" });
    await page.screenshot({ path: "e2e/screenshots/spellcheck-no-bridge.png" });
  });
});
