import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_SETTINGS = getDefaultSettings();

const WORKSPACE = {
  id: "ws-queue-list",
  name: "Queue List Test",
  path: "/tmp/queue-list",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD = {
  id: "thread-queue-list",
  workspace_id: WORKSPACE.id,
  title: "Active Thread",
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

async function setupChat(page: Page, opts?: { running?: boolean }): Promise<void> {
  await page.evaluate(
    ({ ws, th, running }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({
        workspaces: [ws],
        threads: [th],
        activeWorkspaceId: ws.id,
        activeThreadId: th.id,
        loading: false,
        error: null,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threadStore = stores.find((s: any) => {
        const st = s.getState();
        return "runningThreadIds" in st && "records" in st;
      });
      if (threadStore && running) {
        threadStore.setState({
          runningThreadIds: new Set([th.id]),
        });
      }
    },
    { ws: WORKSPACE, th: THREAD, running: opts?.running ?? false },
  );
}

async function seedQueue(
  page: Page,
  threadId: string,
  contents: string[],
): Promise<void> {
  await page.evaluate(
    ({ tid, items }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queueStore = stores.find((s: any) => {
        const st = s.getState();
        return "queues" in st && "enqueue" in st;
      });
      if (!queueStore) throw new Error("[E2E] queue store not found");
      const now = Date.now();
      const entries = items.map((content, i) => ({
        id: `q-${i}-${now}`,
        content,
        displayContent: content,
        attachments: [],
        model: "claude-sonnet-4-6",
        permissionMode: "FULL",
        provider: "claude",
        queuedAt: now + i,
      }));
      queueStore.setState({
        queues: { [tid]: entries },
        toast: null,
      });
    },
    { tid: threadId, items: contents },
  );
}

test.describe("Composer queue list (inline)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "provider.listModels": () => [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
      ],
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
    );
  });

  test("hides the queue section when the queue is empty", async ({ page }) => {
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Queued messages" })).toHaveCount(0);
  });

  test("renders queued messages stacked above the composer", async ({ page }) => {
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, [
      "Refactor the queue store",
      "Wire send-now interrupt",
      "Add drag-and-drop reorder",
    ]);

    const region = page.getByRole("region", { name: "Queued messages" });
    await expect(region).toBeVisible();
    await expect(region.getByText("Queued")).toBeVisible();
    await expect(region.getByText("Refactor the queue store")).toBeVisible();
    await expect(region.getByText("Wire send-now interrupt")).toBeVisible();
    await expect(region.getByText("Add drag-and-drop reorder")).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/composer-queue-list-stacked.png",
      fullPage: false,
    });

    // Hover one row to reveal the action cluster (edit pencil + remove).
    await region.getByText("Wire send-now interrupt").hover();
    await page.screenshot({
      path: "e2e/screenshots/composer-queue-list-row-hover.png",
      fullPage: false,
    });
  });

  test("Continue button is hidden while running and visible when idle", async ({ page }) => {
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["Run me later"]);

    const region = page.getByRole("region", { name: "Queued messages" });
    await expect(
      region.getByRole("button", { name: "Send next queued message" }),
    ).toHaveCount(0);

    // Toggle the thread to idle and expect Continue to appear.
    await page.evaluate(({ tid }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threadStore = stores.find((s: any) => {
        const st = s.getState();
        return "runningThreadIds" in st && "records" in st;
      });
      if (threadStore) {
        threadStore.setState({ runningThreadIds: new Set<string>() });
      }
      void tid;
    }, { tid: THREAD.id });

    await expect(
      region.getByRole("button", { name: "Send next queued message" }),
    ).toBeVisible();
  });

  test("remove button drops only the targeted row", async ({ page }) => {
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["Alpha task", "Beta task", "Gamma task"]);

    const region = page.getByRole("region", { name: "Queued messages" });
    await expect(region.getByText("Beta task")).toBeVisible();

    // Hover the Beta row to reveal the action cluster, then click Remove.
    await region.getByText("Beta task").hover();
    await region
      .getByRole("button", { name: "Remove queued message 2", exact: true })
      .click();

    await expect(region.getByText("Beta task")).toHaveCount(0);
    await expect(region.getByText("Alpha task")).toBeVisible();
    await expect(region.getByText("Gamma task")).toBeVisible();
  });

  test("edit pulls the message back into the composer textarea", async ({ page }) => {
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["Drop me into the composer"]);

    const region = page.getByRole("region", { name: "Queued messages" });
    // Click the labelled Edit (pencil) button.
    await region.getByText("Drop me into the composer").hover();
    await region
      .getByRole("button", { name: "Edit queued message 1", exact: true })
      .click();

    // Row disappears from the queue and the inline list collapses (count: 0).
    await expect(region).toHaveCount(0);

    // Text shows up in the Lexical editor.
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Drop me into the composer");

    // The "Editing" chip is visible inside the composer card.
    await expect(page.getByText("Editing", { exact: false })).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/composer-queue-list-edit-mode.png",
      fullPage: false,
    });
  });

  test("clicking another row swaps without destroying the in-progress edit", async ({ page }) => {
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["Alpha task", "Beta task", "Gamma task"]);

    const region = page.getByRole("region", { name: "Queued messages" });

    // Edit row 2 (Beta).
    await region.getByText("Beta task").hover();
    await region
      .getByRole("button", { name: "Edit queued message 2", exact: true })
      .click();

    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Beta task");

    // Append a marker so we can prove the in-progress edit survives the swap.
    await editor.click();
    await page.keyboard.type(" (edited)");

    // Now click Edit on row 2 of the *remaining* queue (was Gamma after Beta popped).
    // After the swap, Beta (edited) should be back in the queue at slot 02 and
    // Gamma's edited text should appear in the composer.
    await region.getByText("Gamma task").hover();
    await region
      .getByRole("button", { name: "Edit queued message 2", exact: true })
      .click();

    await expect(editor).toContainText("Gamma task");
    // Beta has returned to the queue with its edit preserved.
    await expect(region.getByText("Beta task (edited)")).toBeVisible();
    // Alpha is still in its original slot.
    await expect(region.getByText("Alpha task")).toBeVisible();
  });

  test("pressing Enter while editing (agent idle) saves the edit and dispatches the message", async ({ page }) => {
    // Capture every agent.send call server-side (the RPC handler runs in the
    // test/Node context, not the page context).
    const sentMessages: string[] = [];
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "provider.listModels": () => [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
      ],
      "agent.send": (params?: unknown) => {
        const p = params as { content?: string } | undefined;
        if (typeof p?.content === "string") sentMessages.push(p.content);
        return { ok: true };
      },
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
    );

    // Set up with agent NOT running (the user-reported scenario).
    await setupChat(page, { running: false });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["First task", "Second task", "Third task"]);

    const region = page.getByRole("region", { name: "Queued messages" });

    // Edit the second message.
    await region.getByText("Second task").hover();
    await region
      .getByRole("button", { name: "Edit queued message 2", exact: true })
      .click();

    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Second task");

    // Append an edit so we can tell save+send happened.
    await editor.click();
    await page.keyboard.type(" with extra context");

    // Press Enter to save and send.
    await page.keyboard.press("Enter");

    // Composer clears.
    await expect(editor).not.toContainText("Second task");
    // Editing chip is gone.
    await expect(page.getByText("EDITING", { exact: false })).toHaveCount(0);
    // Dispatch happened with the edited text.
    await expect.poll(() => sentMessages, { timeout: 5_000 }).toContain(
      "Second task with extra context",
    );
    // The other queued messages remained intact.
    await expect(region.getByText("First task")).toBeVisible();
    await expect(region.getByText("Third task")).toBeVisible();
  });

  test("cancel discards edits and restores the ORIGINAL message at its slot", async ({ page }) => {
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["Alpha task", "Beta task", "Gamma task"]);

    const region = page.getByRole("region", { name: "Queued messages" });

    // Edit row 2 (Beta) and modify the text.
    await region.getByText("Beta task").hover();
    await region
      .getByRole("button", { name: "Edit queued message 2", exact: true })
      .click();

    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Beta task");
    await page.keyboard.type(" partial");

    // Cancel via the chip's X. The original "Beta task" should return -
    // NOT "Beta task partial" - because Cancel = discard changes.
    await page
      .getByRole("button", { name: "Discard edits and restore the original queued message" })
      .click();

    await expect(editor).not.toContainText("Beta task");
    await expect(region.getByText("Beta task", { exact: true })).toBeVisible();
    await expect(region.getByText("Beta task partial")).toHaveCount(0);
  });

  test("emptying an edit and pressing Enter removes the message from the queue", async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.enrich": { items: [] },
      "settings.get": MOCK_SETTINGS,
      "provider.listModels": () => [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Claude" },
      ],
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean })
          .__mcodeHydrationComplete === true,
    );
    await setupChat(page, { running: true });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["Alpha task", "Beta task", "Gamma task"]);

    const region = page.getByRole("region", { name: "Queued messages" });
    await region.getByText("Beta task").hover();
    await region
      .getByRole("button", { name: "Edit queued message 2", exact: true })
      .click();

    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("Beta task");

    // Select-all + delete clears the editor.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Enter");

    // The chip is gone, no "Beta task" anywhere - the queued message was removed.
    await expect(page.getByText("EDITING", { exact: false })).toHaveCount(0);
    await expect(region.getByText("Beta task")).toHaveCount(0);
    // Other queued items remain intact.
    await expect(region.getByText("Alpha task")).toBeVisible();
    await expect(region.getByText("Gamma task")).toBeVisible();
    // Feedback toast appeared.
    await expect(page.getByText("Removed from queue")).toBeVisible();
  });

  test("Continue affordance is hidden while editing", async ({ page }) => {
    // Agent idle + queue has items + editing → Continue must NOT show
    // (avoids parallel-action confusion with the live composer).
    await setupChat(page, { running: false });
    await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
    await seedQueue(page, THREAD.id, ["Alpha task", "Beta task"]);

    const region = page.getByRole("region", { name: "Queued messages" });
    // Continue is visible before editing.
    await expect(region.getByRole("button", { name: "Send next queued message" })).toBeVisible();

    // Start editing.
    await region.getByText("Alpha task").hover();
    await region
      .getByRole("button", { name: "Edit queued message 1", exact: true })
      .click();

    // Continue disappears.
    await expect(
      region.getByRole("button", { name: "Send next queued message" }),
    ).toHaveCount(0);
  });
});
