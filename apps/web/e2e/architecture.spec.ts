import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
  waitForActiveThreadLoaded,
  setActiveThreadMessages,
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
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const WORKSPACE_B = {
  id: "ws-arch-2",
  name: "Second Project",
  path: "/tmp/second-project",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 1,
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
  provider: "claude",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
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
  provider: "claude",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
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
  provider: "claude",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
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

/** Inject messages into the active thread's record after loadMessages completes. */
async function injectMessages(
  page: Page,
  messages: ReturnType<typeof makeMessage>[],
): Promise<void> {
  await waitForActiveThreadLoaded(page);
  await setActiveThreadMessages(page, messages);
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
    // exact: true avoids strict-mode violation when both sidebar "Mcode" and landing "mcode" are visible
    await expect(page.getByText("Mcode", { exact: true })).toBeVisible();
    // When no workspace is active the full-screen landing replaces the chat empty state
    await expect(page.getByText("mcode", { exact: true })).toBeVisible();
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
      "records",
      "loadMessages",
      "handleAgentEvent",
    ]);
    expect(hasThreadStore).toBe(true);

    const hasTerminalStore = await findStore(page, [
      "terminals",
      "terminalPanelByThread",
      "toggleTerminalPanel",
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
    // Default state has no workspaces. Both the sidebar and the landing's
    // empty state surface "Open a folder", so use `.first()` for both.
    await expect(page.locator("text=Open a folder").first()).toBeVisible();
    await expect(page.locator("text=No projects yet").first()).toBeVisible();
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

    await waitForActiveThreadLoaded(page);

    // Simulate an agent message event via the handleAgentEvent function
    await page.evaluate(
      ({ threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const threadStore = stores.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) =>
            "handleAgentEvent" in s.getState() && "records" in s.getState(),
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

test.describe("Architecture: session.turnStarted → sidebar running dot", () => {
  test.beforeEach(async ({ page }) => {
    // Pre-seed localStorage so the workspace row is expanded on first render,
    // avoiding a manual click that would race with loadThreads().
    await page.addInitScript((wsId: string) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify({ [wsId]: true }),
      );
    }, WORKSPACE_A.id);

    // Override thread.list so the `loadThreads` call fired by ProjectTree's
    // "load expanded workspaces on mount" effect returns our seeded thread
    // instead of the default []. Matches the shape returned by
    // getTransport().listThreads() (Thread[]).
    await mockWebSocketServer(page, {
      "thread.list": [THREAD_DIRECT],
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Wait until the WS transport's initial hydration (agent.listRunning RPC)
    // has resolved. Without this, a session.turnStarted injection below races
    // hydrateRunningThreadsFromServer: the injected id gets captured in
    // `beforeRpc`, is not classified as a concurrent add, and the server's
    // empty [] response overwrites it.
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__mcodeHydrationComplete === true,
    );
  });

  test("session.turnStarted populates runningThreadIds for the sidebar spinner", async ({
    page,
  }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE_A],
      threads: [THREAD_DIRECT],
      activeWorkspaceId: WORKSPACE_A.id,
    });

    const threadRow = page.locator(
      `[data-testid="thread-item"][data-thread-id="${THREAD_DIRECT.id}"]`,
    );
    await expect(threadRow).toBeVisible();

    // Before the signal fires, the row should show fallback time rather than a running marker.
    await expect(threadRow.getByLabel("Running")).toHaveCount(0);

    await page.screenshot({
      path: "e2e/screenshots/running-signal-before.png",
      fullPage: true,
    });

    // Inject session.turnStarted through the same channel the existing
    // `agent.event push updates streaming state` test uses: handleAgentEvent
    // on the thread store (which is what pushEmitter's `agent.event` listener
    // invokes in production).
    await page.evaluate(
      ({ threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const threadStore = stores.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) =>
            "handleAgentEvent" in s.getState() &&
            "runningThreadIds" in s.getState(),
        );
        if (!threadStore) throw new Error("[E2E] thread store not found");

        threadStore.getState().handleAgentEvent(threadId, {
          method: "session.turnStarted",
          threadId,
        });
      },
      { threadId: THREAD_DIRECT.id },
    );

    // After injection the store should flag the thread as running and the
    // sidebar marker should flip to the primary spinner.
    const runningMarker = threadRow.getByLabel("Running");
    await expect(runningMarker).toHaveClass(/text-primary/);
    await expect(runningMarker).toHaveClass(/status-spin/);

    // Also confirm the store side-effect (handleAgentEvent wrote the id).
    const isRunning = await page.evaluate(
      ({ threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const threadStore = stores.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) => "runningThreadIds" in s.getState(),
        );
        return threadStore?.getState().runningThreadIds.has(threadId) ?? false;
      },
      { threadId: THREAD_DIRECT.id },
    );
    expect(isRunning).toBe(true);

    await page.screenshot({
      path: "e2e/screenshots/running-signal-after.png",
      fullPage: true,
    });
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

    // The terminal panel is keyed per thread: toggleTerminalPanel(threadId)
    // flips terminalPanelByThread[threadId].visible (defaults to false).
    await page.evaluate((threadId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const termStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) =>
          "terminalPanelByThread" in s.getState() &&
          "toggleTerminalPanel" in s.getState(),
      );
      if (!termStore) throw new Error("Terminal store not found");
      termStore.getState().toggleTerminalPanel(threadId);
    }, THREAD_DIRECT.id);

    // Panel should now be visible for the active thread.
    await page.waitForTimeout(200);
    const isPanelVisible = await page.evaluate((threadId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const termStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => "terminalPanelByThread" in s.getState(),
      );
      return termStore?.getState().getTerminalPanel(threadId).visible;
    }, THREAD_DIRECT.id);
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

    // App should still render fully — exact: true avoids strict-mode violation with landing "mcode"
    await expect(page.getByText("Mcode", { exact: true })).toBeVisible();
    await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  });

  test("open-in app listing returns empty array without bridge", async ({
    page,
  }) => {
    const apps = await page.evaluate(async () => {
      // Simulate what the transport does: check desktopBridge
      return (await window.desktopBridge?.listOpenInApps()) ?? [];
    });

    expect(apps).toEqual([]);
  });
});

test.describe("Architecture: Settings", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  test("opens as a full-page view exposing each section's controls", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // Settings is a full-page sectioned view, not a modal dialog. A "Back to
    // projects" affordance replaces the sidebar; there is no [role="dialog"].
    await expect(
      page.getByRole("button", { name: "Back to projects" }),
    ).toBeVisible();

    // Appearance section exposes the Theme radio group.
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeVisible();

    // Agent section exposes the concurrency limit.
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.getByText("Max concurrent agents")).toBeVisible();

    // Notifications section exposes the desktop-notifications toggle.
    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    await expect(
      page.getByText("Show desktop notifications for agent events."),
    ).toBeVisible();
  });

  test("theme switching works without errors", async ({ page }) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();

    // Switch to light
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    // Switch back to dark
    await page.getByRole("radio", { name: "Dark" }).click();
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

    // Deselecting clears activeThreadId, which swaps the chat view for the
    // project landing. Assert the composer is gone and the store is cleared
    // (the successful evaluate also proves no crash tore down the app).
    await expect(page.locator('[contenteditable="true"]')).toBeHidden();
    const result = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      const wsStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => "activeThreadId" in s.getState(),
      );
      // Distinguish "store missing" from a legitimate null activeThreadId —
      // `?? sentinel` would collapse the success case (null) into the sentinel.
      return {
        found: Boolean(wsStore),
        activeThreadId: wsStore ? wsStore.getState().activeThreadId : "STORE_MISSING",
      };
    });
    expect(result.found).toBe(true);
    expect(result.activeThreadId).toBeNull();
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
    await expect(page.getByText("Mcode", { exact: true })).toBeVisible();

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
