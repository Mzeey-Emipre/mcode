import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * E2E tests for the Plan Question Wizard (composer-takeover pattern).
 *
 * These verify:
 * 1. Wizard renders with correct ARIA structure when plan questions arrive
 * 2. Keyboard navigation selects options and advances questions
 * 3. Wizard hides when no plan questions exist
 * 4. AcceptRecommended appears for all-recommended batches
 *
 * Strategy: Mock WS, intercept Zustand stores, inject a workspace/thread
 * into the workspace store, then inject plan questions into the thread store.
 */

const WORKSPACE = {
  id: "ws-plan-1",
  name: "Plan Test",
  path: "/tmp/plan-test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-plan-1",
  workspace_id: "ws-plan-1",
  title: "Plan mode test",
  branch_name: "main",
  branch_ref: "main",
  worktree_path: null,
  worktree_managed: false,
  sdk_session_id: null,
  status: "idle",
  model: "claude-sonnet-4-20250514",
  provider: "claude",
  goal: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MOCK_QUESTIONS = [
  {
    id: "q1",
    category: "ARCHITECTURE",
    question: "Which database should we use?",
    options: [
      { id: "o1", title: "PostgreSQL", description: "Relational, battle-tested", recommended: true },
      { id: "o2", title: "MongoDB", description: "Document store, flexible schema" },
      { id: "o3", title: "SQLite", description: "Embedded, zero config" },
    ],
  },
  {
    id: "q2",
    category: "AUTH",
    question: "Authentication strategy?",
    options: [
      { id: "o4", title: "JWT", description: "Stateless tokens", recommended: true },
      { id: "o5", title: "Session cookies", description: "Server-side sessions" },
    ],
  },
];

/** Set up workspace + thread in the workspace store so ChatView renders. */
async function setupWorkspace(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspace, thread }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const wsStore = stores.find((s) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: thread.id,
        loading: false,
        error: null,
      });
    },
    { workspace: WORKSPACE, thread: THREAD },
  );
}

/** Inject plan questions into the thread store. */
async function injectPlanQuestions(
  page: Page,
  threadId: string,
  questions: typeof MOCK_QUESTIONS,
): Promise<void> {
  await page.evaluate(
    ({ tid, qs }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const threadStore = stores.find((s) => {
        const st = s.getState();
        return "records" in st && "setPlanQuestions" in st;
      });
      if (!threadStore) throw new Error("[E2E] thread store not found");
      threadStore.getState().setPlanQuestions(tid, qs);
    },
    { tid: threadId, qs: questions },
  );
}

/** Mark a thread as running so the submit gate engages. */
async function setThreadRunning(
  page: Page,
  threadId: string,
  running: boolean,
): Promise<void> {
  await page.evaluate(
    ({ tid, on }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const threadStore = stores.find((s) => {
        const st = s.getState();
        return "runningThreadIds" in st && "records" in st;
      });
      if (!threadStore) throw new Error("[E2E] thread store not found");
      threadStore.setState((s: { runningThreadIds: Set<string> }) => {
        const next = new Set(s.runningThreadIds);
        if (on) next.add(tid);
        else next.delete(tid);
        return { runningThreadIds: next };
      });
    },
    { tid: threadId, on: running },
  );
}

test.describe("Plan Question Wizard", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await setupWorkspace(page);
  });

  test("wizard is not visible when no plan questions exist", async ({ page }) => {
    // Give React a tick to render, then verify no wizard
    await page.waitForTimeout(500);
    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toHaveCount(0);
  });

  test("wizard renders with correct ARIA roles when questions are injected", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Radiogroup with options
    const radiogroup = wizard.locator("[role='radiogroup']");
    await expect(radiogroup).toBeVisible();

    // 3 question options + 1 "Other" = 4 radio tiles
    const radios = wizard.locator("[role='radio']");
    await expect(radios).toHaveCount(4);

    // All radios start unchecked
    for (let i = 0; i < 4; i++) {
      await expect(radios.nth(i)).toHaveAttribute("aria-checked", "false");
    }

    // The tile entrance animation runs for ~140ms + 40ms*index + 180ms
    // duration. Let it settle so the documentation screenshot captures
    // the resting visual instead of the staggered fade.
    await page.waitForFunction(() => {
      const tiles = document.querySelectorAll("[role='radio']");
      if (tiles.length === 0) return false;
      for (const t of Array.from(tiles)) {
        const el = t as HTMLElement;
        if (parseFloat(window.getComputedStyle(el).opacity) < 0.99) return false;
      }
      return true;
    });

    await page.screenshot({
      path: "e2e/screenshots/plan-wizard-active.png",
      fullPage: true,
    });
  });

  test("displays question category and text", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Category renders lowercased in the mono header
    await expect(wizard.getByText("architecture", { exact: true })).toBeVisible();
    await expect(wizard.locator("text=Which database should we use?")).toBeVisible();

    // Mono step counter shows "step 01 of 02"
    await expect(wizard.getByText(/01\s+of\s+02/)).toBeVisible();
  });

  test("shows inline 'recommended' annotation on recommended options", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // PostgreSQL row carries the editorial annotation
    const recommendedTile = wizard
      .locator("[role='radio']")
      .filter({ hasText: "recommended" })
      .first();
    await expect(recommendedTile).toBeVisible();
    await expect(recommendedTile).toContainText("PostgreSQL");
  });

  test("keyboard number key selects an option", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Explicit focus before key press — `page.keyboard.press` dispatches
    // to whatever element currently holds focus, so without focusing a
    // wizard radio the keystroke could be consumed by the Composer
    // textarea and the test would flake.
    const firstRadio = wizard.locator("[role='radio']").first();
    await firstRadio.focus();
    await firstRadio.press("1");

    await expect(firstRadio).toHaveAttribute("aria-checked", "true");
  });

  test("Enter advances to next question", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    const firstRadio = wizard.locator("[role='radio']").first();
    await firstRadio.focus();
    await firstRadio.press("1");
    await firstRadio.press("Enter");

    // Question 2 now visible, mono counter advanced
    await expect(wizard.getByText("auth", { exact: true })).toBeVisible();
    await expect(wizard.getByText("Authentication strategy?")).toBeVisible();
    await expect(wizard.getByText(/02\s+of\s+02/)).toBeVisible();
  });

  test("accept-all link is visible when all questions have recommended", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    await expect(wizard.getByTestId("plan-accept-recommended")).toBeVisible();
  });

  test("cancel action dismisses the wizard", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    await wizard.locator("button", { hasText: "cancel" }).first().click();

    await expect(wizard).not.toBeVisible({ timeout: 2000 });
  });

  test("cancel fires the dismissPlanQuestions RPC so the wizard stays dismissed across reloads", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Capture RPC calls so we can assert the durable dismiss fired.
    // The mocked WebSocket from mockWebSocketServer doesn't echo RPCs back to
    // page-side observers, so trace them via window patching instead.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.__dismissCalls = [];
      const original = w.WebSocket;
      // The transport is already constructed; intercept at the prototype level
      // for any messages that go out after this point.
      const origSend = original.prototype.send;
      original.prototype.send = function (data: string) {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.method === "agent.dismissPlanQuestions") {
            w.__dismissCalls.push(parsed.params);
          }
        } catch {
          // Non-JSON frames are fine to ignore for this trace.
        }
        return origSend.call(this, data);
      };
    });

    await wizard.locator("button", { hasText: "cancel" }).first().click();
    await expect(wizard).not.toBeVisible({ timeout: 2000 });

    const calls = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__dismissCalls as Array<{ threadId: string }>,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].threadId).toBe(THREAD.id);
  });

  test("single question batch still shows the mono counter (one of one)", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, [MOCK_QUESTIONS[0]]);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // The dotted indicator is gone; the mono counter is the only progress signal
    await expect(wizard.getByText(/01\s+of\s+01/)).toBeVisible();
  });

  test("submit is disabled and hint shows while thread is still running", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, [MOCK_QUESTIONS[0]]);
    await setThreadRunning(page, THREAD.id, true);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    await expect(wizard.getByText(/model is still working/)).toBeVisible();

    const submit = wizard.locator("button", { hasText: "submit" });
    await expect(submit).toBeDisabled();

    const accept = wizard.getByTestId("plan-accept-recommended");
    await expect(accept).toBeDisabled();

    await setThreadRunning(page, THREAD.id, false);
    await expect(wizard.getByText(/model is still working/)).not.toBeVisible();
    await expect(submit).toBeEnabled();
    await expect(accept).toBeEnabled();
  });

  test("pressing ? toggles a keyboard legend overlay", async ({ page }) => {
    await injectPlanQuestions(page, THREAD.id, MOCK_QUESTIONS);

    const wizard = page.locator("[role='form'][aria-label='Plan questions']");
    await expect(wizard).toBeVisible({ timeout: 3000 });

    // Ensure no input is focused so the `?` reaches the wizard handler
    // rather than getting consumed by the Composer textarea.
    await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
      ) {
        active.blur();
      }
    });

    const legend = wizard.locator("[role='note'][aria-label='Keyboard shortcuts']");
    await expect(legend).toHaveCount(0);

    // Dispatch the literal `?` keydown via JS — the platform layout-aware
    // shortcut Shift+/ doesn't reliably emit a "?" key in headless modes
    // across operating systems.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
    });
    await expect(legend).toBeVisible();
    await expect(legend).toContainText("select");
    await expect(legend).toContainText("navigate");
    await expect(legend).toContainText("advance");
    await expect(legend).toContainText("cancel");

    // Any other key dismisses the legend.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await expect(legend).toHaveCount(0);
  });
});
