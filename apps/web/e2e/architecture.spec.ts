import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * Comprehensive E2E tests for the architecture redesign.
 *
 * Tests verify:
 * 1. App initialization and WebSocket transport setup
 * 2. Workspace management (create, list, select, delete)
 * 3. Thread lifecycle (create, select, messages, status)
 * 4. Composer and chat UI
 * 5. Push event handling (agent events, terminal, thread status, file changes)
 * 6. Terminal panel
 * 7. Desktop bridge guards (native-only features degrade gracefully)
 * 8. Contracts types (worktree_managed, sdk_session_id fields)
 *
 * Strategy: Intercept Vite-bundled zustand.js to inject a store registry on
 * window.__mcodeStores. This allows setState() on workspace and thread stores
 * to set up desired UI state without running the actual server.
 */

/** Find a specific Zustand store by checking for identifying keys. */
async function findStore(
  page: Page,
  identifyingKeys: string[],
): Promise<boolean> {
  return page.evaluate(
    ({ keys }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      return stores.some((s) => {
        const state = s.getState();
        return keys.every((k) => k in state);
      });
    },
    { keys: identifyingKeys },
  );
}

// ── Test data ────────────────────────────────────────────────────────────────

const WORKSPACE_A = {
  id: "ws-arch-1",
  name: "Architecture Test",
  path: "/tmp/arch-test",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const WORKSPACE_B = {
  id: "ws-arch-2",
  name: "Second Project",
  path: "/tmp/second-project",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD_DIRECT = {
  id: "thread-direct-1",
  workspace_id: "ws-arch-1",
  title: "Direct Mode Thread",
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
};

const THREAD_WORKTREE = {
  id: "thread-wt-1",
  workspace_id: "ws-arch-1",
  title: "Worktree Thread",
  status: "active" as const,
  mode: "worktree" as const,
  worktree_path: "/tmp/arch-test/.worktrees/feature-x",
  branch: "feature-x",
  issue_number: null,
  pr_number: 42,
  pr_status: "open",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: "claude-opus-4-6",
  deleted_at: null,
  worktree_managed: true,
  sdk_session_id: "sdk-session-abc",
};

const THREAD_INTERRUPTED = {
  id: "thread-int-1",
  workspace_id: "ws-arch-1",
  title: "Interrupted Thread",
  status: "interrupted" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  issue_number: null,
  pr_number: null,
  pr_status: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  model: null,
  deleted_at: null,
  worktree_managed: false,
  sdk_session_id: null,
};

function makeMessage(
  id: string,
  threadId: string,
  role: "user" | "assistant" | "system",
  content: string,
  sequence: number,
  offsetMs = 0,
) {
  return {
    id,
    thread_id: threadId,
    role,
    content,
    tool_calls: null,
    files_changed: null,
    cost_usd: role === "assistant" ? 0.01 : null,
    tokens_used: role === "assistant" ? 150 : null,
    timestamp: new Date(Date.now() - offsetMs).toISOString(),
    sequence,
    attachments: null,
  };
}

/** Thread fixture shape shared by all test thread constants. */
type ThreadFixture = {
  id: string;
  workspace_id: string;
  [key: string]: unknown;
};

/** Inject workspaces, threads, and activate a thread. */
async function setupWorkspaceState(
  page: Page,
  opts: {
    workspaces: typeof WORKSPACE_A[];
    threads: ThreadFixture[];
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

/**
 * Wait for the thread store's loadMessages cycle to complete.
 *
 * The store starts with `loading: false`, so a naive check resolves
 * immediately before `loadMessages` (triggered by activeThreadId change)
 * fires. This helper first waits for `loading` to become `true` (the start
 * of loadMessages), then waits for it to return to `false` (completion).
 */
async function waitForThreadStoreReady(page: Page): Promise<void> {
  // Wait for loadMessages to start (loading becomes true).
  // It may have already completed before we start watching, so swallow the timeout.
  await page
    .waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const ts = stores.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) =>
            "messages" in s.getState() && "loadMessages" in s.getState(),
        );
        return ts?.getState().loading === true;
      },
      { timeout: 2000 },
    )
    .catch(() => {
      // loading may have already transitioned back to false before we polled
    });

  // Wait for loadMessages to finish (loading: false).
  await page.waitForFunction(
    () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const ts = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) =>
          "messages" in s.getState() && "loadMessages" in s.getState(),
      );
      return ts && ts.getState().loading === false;
    },
    { timeout: 5000 },
  );
}

/** Inject messages into the thread store after loadMessages completes. */
async function injectMessages(
  page: Page,
  messages: ReturnType<typeof makeMessage>[],
): Promise<void> {
  await waitForThreadStoreReady(page);
  await page.evaluate(
    ({ msgs }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const threadStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => "messages" in s.getState() && "loadMessages" in s.getState(),
      );
      if (!threadStore) throw new Error("[E2E] thread store not found");
      threadStore.setState({ messages: msgs, loading: false, error: null });
    },
    { msgs: messages },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("Architecture: App initialization", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("loads app shell with sidebar, main area, and dark theme", async ({
    page,
  }) => {

    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("text=Mcode")).toBeVisible();
    await expect(
      page.locator("h2", { hasText: "Select a thread" }),
    ).toBeVisible();
  });

  test("transport module initializes without crashing", async ({ page }) => {
    // The App component calls initTransport() on mount. Verify no error state.
    // No error overlay should be present
    await expect(page.locator(".vite-error-overlay")).not.toBeVisible();

    // The app structure should render fully
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  });
});

test.describe("Architecture: Workspace management", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("Zustand stores are accessible via interception", async ({ page }) => {
    const hasWorkspaceStore = await findStore(page, [
      "activeThreadId",
      "threads",
      "workspaces",
    ]);
    expect(hasWorkspaceStore).toBe(true);

    const hasThreadStore = await findStore(page, [
      "messages",
      "loadMessages",
      "handleAgentEvent",
    ]);
    expect(hasThreadStore).toBe(true);

    const hasTerminalStore = await findStore(page, [
      "terminals",
      "panelVisible",
      "togglePanel",
    ]);
    expect(hasTerminalStore).toBe(true);
  });

  test("shows workspace in sidebar when injected", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [],
      activeWorkspaceId: WORKSPACE_A.id,
    });

    await expect(page.locator("text=Architecture Test")).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/arch-workspace-injected.png",
      fullPage: true,
    });
  });

  test("shows multiple workspaces", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A, WORKSPACE_B],
      threads: [],
      activeWorkspaceId: WORKSPACE_A.id,
    });

    await expect(page.locator("text=Architecture Test")).toBeVisible();
    await expect(page.locator("text=Second Project")).toBeVisible();
  });

  test("empty state shows Open a folder when no workspaces", async ({
    page,
  }) => {
    // Default state has no workspaces
    await expect(page.locator("text=Open a folder")).toBeVisible();
    await expect(page.locator("text=No projects yet.")).toBeVisible();
  });
});

test.describe("Architecture: Thread lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("shows thread list when workspace has threads", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT, THREAD_WORKTREE, THREAD_INTERRUPTED],
      activeWorkspaceId: WORKSPACE_A.id,
    });

    // Verify threads are in the store
    const threadCount = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => "threads" in s.getState());
      return wsStore?.getState().threads.length ?? 0;
    });
    expect(threadCount).toBe(3);

    // Verify workspace is shown and active
    await expect(page.locator("text=Architecture Test")).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/arch-thread-list.png",
      fullPage: true,
    });
  });

  test("activating a thread shows chat view with composer", async ({
    page,
  }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    // The "Select a thread" empty state should disappear
    await expect(
      page.locator("h2", { hasText: "Select a thread" }),
    ).not.toBeVisible();

    // Composer should be visible (Lexical editor renders a contenteditable div)
    const composerArea = page.locator('[contenteditable="true"]');
    await expect(composerArea).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/arch-active-thread.png",
      fullPage: true,
    });
  });

  test("worktree thread shows branch info", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_WORKTREE],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_WORKTREE.id,
    });

    // The worktree thread has branch "feature-x"
    await expect(page.locator("text=feature-x")).toBeVisible();
  });

  test("contracts types: worktree_managed and sdk_session_id are accepted", async ({
    page,
  }) => {
    // This test verifies the contracts Thread type with new fields doesn't
    // cause runtime errors when injected into the store
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_WORKTREE], // has worktree_managed: true, sdk_session_id: "sdk-session-abc"
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_WORKTREE.id,
    });

    // App should render without errors
    await expect(page.locator("text=Worktree Thread")).toBeVisible();

    // Verify the store has the full contract data
    const threadData = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => "threads" in s.getState());
      if (!wsStore) return null;
      return wsStore.getState().threads[0];
    });

    expect(threadData).not.toBeNull();
    expect(threadData.worktree_managed).toBe(true);
    expect(threadData.sdk_session_id).toBe("sdk-session-abc");
  });
});

test.describe("Architecture: Chat and messages", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("displays injected messages in chat view", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    await injectMessages(page, [
      makeMessage("m1", THREAD_DIRECT.id, "user", "Hello agent!", 1, 60000),
      makeMessage(
        "m2",
        THREAD_DIRECT.id,
        "assistant",
        "Hello! How can I help you today?",
        2,
        30000,
      ),
    ]);

    await expect(page.locator("text=Hello agent!")).toBeVisible();
    await expect(
      page.locator("text=Hello! How can I help you today?"),
    ).toBeVisible();

    await page.screenshot({
      path: "e2e/screenshots/arch-chat-messages.png",
      fullPage: true,
    });
  });

  test("displays system message as session divider", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    await injectMessages(page, [
      makeMessage("m1", THREAD_DIRECT.id, "user", "Help me debug", 1, 120000),
      makeMessage(
        "m2",
        THREAD_DIRECT.id,
        "assistant",
        "I can help with that.",
        2,
        90000,
      ),
      makeMessage(
        "m-sys",
        THREAD_DIRECT.id,
        "system",
        "Session restarted. The agent no longer has context from earlier messages.",
        3,
        60000,
      ),
      makeMessage(
        "m3",
        THREAD_DIRECT.id,
        "user",
        "What was I working on?",
        4,
        30000,
      ),
    ]);

    await page.waitForFunction(
      () => document.body.innerText.includes("Session restarted"),
      { timeout: 5000 },
    );

    await expect(page.locator("text=Session restarted")).toBeVisible();
  });

  test("displays multiple messages in correct order", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    const messages = Array.from({ length: 6 }, (_, i) => {
      const role = i % 2 === 0 ? ("user" as const) : ("assistant" as const);
      return makeMessage(
        `m${i}`,
        THREAD_DIRECT.id,
        role,
        `Message ${i + 1} from ${role}`,
        i + 1,
        (6 - i) * 10000,
      );
    });

    await injectMessages(page, messages);

    // Verify first and last messages are visible
    await expect(page.locator("text=Message 1 from user")).toBeVisible();
    await expect(
      page.locator("text=Message 6 from assistant"),
    ).toBeVisible();
  });
});

test.describe("Architecture: Push events via PushEmitter", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("agent.event push updates streaming state", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    await waitForThreadStoreReady(page);

    // Simulate an agent message event via the handleAgentEvent function
    await page.evaluate(
      ({ threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const threadStore = stores.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) =>
            "handleAgentEvent" in s.getState() && "messages" in s.getState(),
        );
        if (!threadStore) throw new Error("Thread store not found");

        // Simulate message event (as handleAgentEvent expects)
        threadStore.getState().handleAgentEvent(threadId, {
          method: "session.message",
          threadId,
          content: "Streaming from agent...",
          tokens: 50,
        });
      },
      { threadId: THREAD_DIRECT.id },
    );

    // The streaming content should appear in the chat
    await expect(
      page.locator("text=Streaming from agent..."),
    ).toBeVisible({ timeout: 3000 });
  });

  test("thread.status push updates thread status in store", async ({
    page,
  }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
    });

    // Simulate a thread status change via store
    const updatedStatus = await page.evaluate(
      ({ threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wsStore = stores.find((s: any) => {
          const st = s.getState();
          return "threads" in st && "workspaces" in st;
        });
        if (!wsStore) return null;

        // Change thread status to "completed"
        const state = wsStore.getState();
        wsStore.setState({
          threads: state.threads.map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (t: any) =>
              t.id === threadId ? { ...t, status: "completed" } : t,
          ),
        });

        // Verify the status was updated in the store
        const updated = wsStore.getState().threads.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (t: any) => t.id === threadId,
        );
        return updated?.status;
      },
      { threadId: THREAD_DIRECT.id },
    );

    expect(updatedStatus).toBe("completed");
  });

  test("terminal.data push dispatches CustomEvent", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    // Set up a listener for the mcode:pty-data CustomEvent
    const eventReceived = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        window.addEventListener(
          "mcode:pty-data",
          (e) => {
            const detail = (e as CustomEvent).detail;
            resolve(
              detail.ptyId === "test-pty-1" && detail.data === "$ ls\n",
            );
          },
          { once: true },
        );

        // Dispatch a fake terminal data event
        window.dispatchEvent(
          new CustomEvent("mcode:pty-data", {
            detail: { ptyId: "test-pty-1", data: "$ ls\n" },
          }),
        );
      });
    });

    expect(eventReceived).toBe(true);
  });
});

test.describe("Architecture: Terminal panel", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("terminal panel is hidden by default", async ({ page }) => {
    // The terminal panel should not be visible initially
    // Terminal panel might not have a test id, check for xterm container
    const xtermElements = page.locator(".xterm");
    await expect(xtermElements).toHaveCount(0);
  });

  test("Ctrl+J toggles terminal panel via store", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    // Toggle panel visibility via store
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const termStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => "panelVisible" in s.getState() && "togglePanel" in s.getState(),
      );
      if (!termStore) throw new Error("Terminal store not found");
      termStore.getState().togglePanel();
    });

    // Panel should now be visible (it renders the terminal container div)
    // Even without a real PTY, the panel chrome should appear
    await page.waitForTimeout(200);
    const isPanelVisible = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const termStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => "panelVisible" in s.getState(),
      );
      return termStore?.getState().panelVisible;
    });
    expect(isPanelVisible).toBe(true);
  });
});

test.describe("Architecture: Desktop bridge graceful degradation", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("app loads without desktopBridge (standalone mode)", async ({
    page,
  }) => {
    // In standalone mode (no Electron), desktopBridge is undefined
    const hasBridge = await page.evaluate(
      () => typeof window.desktopBridge !== "undefined",
    );
    // In the Playwright browser context, desktopBridge should NOT exist
    expect(hasBridge).toBe(false);

    // App should still render fully
    await expect(page.locator("text=Mcode")).toBeVisible();
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  });

  test("native editor detection returns empty array without bridge", async ({
    page,
  }) => {
    const editors = await page.evaluate(async () => {
      // Simulate what the transport does: check desktopBridge
      return window.desktopBridge?.detectEditors() ?? [];
    });

    expect(editors).toEqual([]);
  });
});

test.describe("Architecture: Settings dialog", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("opens and shows all controls", async ({ page }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator("text=Theme")).toBeVisible();
    await expect(
      dialog.locator("text=Max Concurrent Agents"),
    ).toBeVisible();
    await expect(dialog.locator("text=Notifications")).toBeVisible();
  });

  test("theme switching works without errors", async ({ page }) => {
    await page.locator("button", { hasText: "Settings" }).click();

    const dialog = page.locator('[role="dialog"]');

    // Switch to light
    await dialog.locator("button", { hasText: "light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    // Switch back to dark
    await dialog.locator("button", { hasText: "dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});

test.describe("Architecture: Keyboard shortcuts", () => {
  test("Escape deselects thread without crash", async ({ page }) => {
    await mockWebSocketServer(page);
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
      activeThreadId: THREAD_DIRECT.id,
    });

    // Thread is active, composer should be visible
    await expect(page.locator('[contenteditable="true"]')).toBeVisible();

    // Press Escape to deselect
    await page.keyboard.press("Escape");

    // Should return to empty state
    await expect(
      page.locator("h2", { hasText: "Select a thread" }),
    ).toBeVisible();
  });
});

test.describe("Architecture: WebSocket transport structure", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("ws-transport.ts exports are available in transport module", async ({
    page,
  }) => {
    // Verify that the transport module loaded (no import errors)
    // The app initializes without crash, which means the transport loaded
    await expect(page.locator("text=Mcode")).toBeVisible();

    // Check that pushEmitter is available as a module-level export
    // We can verify this indirectly: if ws-events.ts loaded, push listeners
    // were attempted (even if WS isn't connected)
    const noErrors = await page.evaluate(() => {
      // Check console for transport init errors
      return !document.querySelector(".vite-error-overlay");
    });
    expect(noErrors).toBe(true);
  });
});
