/**
 * E2E tests verifying that threads with status "interrupted" render the correct
 * amber pulsing dot in the sidebar, and that the dot clears to running (primary)
 * when the thread resumes via turnStarted.
 *
 * This tests the fix for: "copilot not persisting working state" where threads
 * showed idle/normal state after a server restart instead of interrupted state.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE = {
  id: "ws-interrupted-test",
  name: "Interrupted Test Workspace",
  path: "/tmp/interrupted-test",
  provider_config: {},
  is_git_repo: true,
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const THREAD_INTERRUPTED = {
  id: "thread-interrupted-1",
  workspace_id: WORKSPACE.id,
  title: "Was running when server restarted",
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
  sdk_session_id: "sdk-session-xyz",
  provider: "claude",
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Inject workspaces and threads into the Zustand workspace store. */
async function setupWorkspaceState(
  page: Page,
  opts: { workspaces: typeof WORKSPACE[]; threads: typeof THREAD_INTERRUPTED[]; activeWorkspaceId: string },
): Promise<void> {
  await page.evaluate(
    ({ workspaces, threads, activeWorkspaceId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      if (!wsStore) throw new Error("[E2E] workspace store not found");
      wsStore.setState({ workspaces, threads, activeWorkspaceId, activeThreadId: null, loading: false });
    },
    opts,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Sidebar: interrupted thread state", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((wsId: string) => {
      localStorage.setItem("mcode-expanded-projects", JSON.stringify({ [wsId]: true }));
    }, WORKSPACE.id);

    await mockWebSocketServer(page, {
      "thread.list": [THREAD_INTERRUPTED],
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Wait for hydration to complete before injecting state.
    await page.waitForFunction(
      () => (window as any).__mcodeHydrationComplete === true, // eslint-disable-line @typescript-eslint/no-explicit-any
    );
  });

  test("interrupted thread shows amber pulsing marker in sidebar", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE],
      threads: [THREAD_INTERRUPTED],
      activeWorkspaceId: WORKSPACE.id,
    });

    const threadRow = page.locator(
      `[data-testid="thread-item"][data-thread-id="${THREAD_INTERRUPTED.id}"]`,
    );
    await expect(threadRow).toBeVisible();

    const statusMarker = threadRow.getByLabel("Interrupted");

    // Must show amber (not idle grey, not primary blue).
    await expect(statusMarker).toHaveClass(/amber/);
    await expect(statusMarker).toHaveClass(/status-pulse/);
    // Must NOT look like a running thread.
    await expect(statusMarker).not.toHaveClass(/bg-primary/);

    await page.screenshot({
      path: "e2e/screenshots/interrupted-amber-dot.png",
      fullPage: true,
    });
  });

  test("interrupted marker switches to primary spinner when turnStarted fires", async ({ page }) => {
    await setupWorkspaceState(page, {
      workspaces: [WORKSPACE],
      threads: [THREAD_INTERRUPTED],
      activeWorkspaceId: WORKSPACE.id,
    });

    const threadRow = page.locator(
      `[data-testid="thread-item"][data-thread-id="${THREAD_INTERRUPTED.id}"]`,
    );
    await expect(threadRow).toBeVisible();

    const statusMarker = threadRow.getByLabel("Interrupted");

    // Confirm amber state before resume.
    await expect(statusMarker).toHaveClass(/amber/);

    // Inject turnStarted to simulate user resuming the thread.
    await page.evaluate(
      ({ threadId }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores: any[] = (window as any).__mcodeStores ?? [];
        const threadStore = stores.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) => "handleAgentEvent" in s.getState() && "runningThreadIds" in s.getState(),
        );
        if (!threadStore) throw new Error("[E2E] thread store not found");
        threadStore.getState().handleAgentEvent({
          type: "turnStarted",
          threadId,
        });
      },
      { threadId: THREAD_INTERRUPTED.id },
    );

    // After resume the marker must switch to the primary running spinner.
    const runningMarker = threadRow.getByLabel("Running");
    await expect(runningMarker).toHaveClass(/text-primary/);
    await expect(runningMarker).toHaveClass(/status-spin/);
    await expect(runningMarker).not.toHaveClass(/amber/);

    await page.screenshot({
      path: "e2e/screenshots/interrupted-resumed-running-dot.png",
      fullPage: true,
    });
  });
});
