import { test, expect } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer, interceptZustandStores } from "./helpers/e2e-helpers";

const WS_URL = "ws://localhost:19400";
const WS_ID = "ws-scroll-switch";

const now = new Date().toISOString();

const WORKSPACE = {
  id: WS_ID,
  name: "Scroll Switch",
  path: "/tmp/scroll-switch",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

function makeThread(id: string, title: string): Thread {
  return {
    id,
    workspace_id: WS_ID,
    title,
    status: "paused",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    worktree_managed: false,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: now,
    updated_at: now,
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
}

const THREAD_A = makeThread("thread-a", "Thread A");
const THREAD_B = makeThread("thread-b", "Thread B");

type HarnessViewport = {
  viewportY: number;
  length: number;
  rows: number;
  linesFromBottom: number;
};

/** Sets the active workspace thread (same state change as the sidebar). */
async function setActiveThread(
  page: import("@playwright/test").Page,
  threadId: string,
): Promise<void> {
  await page.evaluate((tid) => {
    const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const wsStore = stores.find((s: unknown) => {
      const state = (s as { getState: () => Record<string, unknown> }).getState();
      return "setActiveThread" in state;
    });
    if (!wsStore) return;
    (wsStore as { getState: () => { setActiveThread: (id: string) => void } }).getState().setActiveThread(tid);
  }, threadId);
}

/** Opens the right-panel terminal tab via store (avoids duplicate Toggle terminal buttons). */
async function openTerminalTab(
  page: import("@playwright/test").Page,
  workspaceId: string,
  threadId: string,
): Promise<void> {
  await page.evaluate(({ wid, tid }) => {
    const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const diffStore = stores.find((s: unknown) => {
      const st = (s as { getState: () => Record<string, unknown> }).getState();
      return "showRightPanel" in st && "setRightPanelTab" in st;
    });
    if (!diffStore) return;
    const api = (diffStore as { getState: () => {
      showRightPanel: (id: string, threadId?: string) => void;
      setRightPanelTab: (id: string, tab: string) => void;
    } }).getState();
    // Open/closed is per-thread; the active tab stays workspace-global.
    api.showRightPanel(wid, tid);
    api.setRightPanelTab(wid, "terminal");
  }, { wid: workspaceId, tid: threadId });
}

/** Ensures a thread has a terminal instance in the store (mounts pooled xterm). */
async function ensureThreadTerminal(
  page: import("@playwright/test").Page,
  threadId: string,
  ptyId: string,
  label = "bash",
): Promise<void> {
  await page.evaluate(
    ({ tid, pty, shell }) => {
      const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const termStore = stores.find((s: unknown) => {
        const st = (s as { getState: () => Record<string, unknown> }).getState();
        return "addTerminal" in st;
      }) as { getState: () => { addTerminal: (a: string, b: string, c?: string) => void; terminals: Record<string, unknown[]> } } | undefined;
      if (!termStore) return;
      const state = termStore.getState();
      if (!state.terminals[tid]?.length) {
        state.addTerminal(tid, pty, shell);
      }
    },
    { tid: threadId, pty: ptyId, shell: label },
  );
}

/** Resolves the active PTY id for a thread from the terminal store. */
async function getActivePtyId(
  page: import("@playwright/test").Page,
  threadId: string,
): Promise<string> {
  return page.evaluate((tid) => {
    const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
    const termStore = stores.find((s: unknown) => {
      const st = (s as { getState: () => Record<string, unknown> }).getState();
      return "terminals" in st && "terminalPanelByThread" in st;
    });
    if (!termStore) return "";
    const state = (termStore as { getState: () => {
      terminals: Record<string, { id: string }[]>;
      terminalPanelByThread: Record<string, { activeTerminalId: string | null }>;
    } }).getState();
    const activeId = state.terminalPanelByThread[tid]?.activeTerminalId;
    if (activeId) return activeId;
    return state.terminals[tid]?.[0]?.id ?? "";
  }, threadId);
}

/** Reads harness viewport for a PTY (null when xterm is not mounted/shown). */
async function getHarnessViewport(
  page: import("@playwright/test").Page,
  ptyId: string,
): Promise<HarnessViewport | null> {
  return page.evaluate((id) => {
    const harness = (
      window as unknown as {
        __mcodeTerminalScrollHarness?: {
          getViewport: (pty: string) => HarnessViewport | null;
        };
      }
    ).__mcodeTerminalScrollHarness;
    return harness?.getViewport(id) ?? null;
  }, ptyId);
}

/** Seeds workspace/thread state, opens the terminal tab, and mounts a PTY. */
async function seedThreadsAndOpenTerminal(
  page: import("@playwright/test").Page,
  activeThreadId: string,
  ptyId = `pty-${activeThreadId}`,
): Promise<void> {
  await page.evaluate(
    ({ workspace, threads, activeId }) => {
      const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const wsStore = stores.find((s: unknown) => {
        const st = (s as { getState: () => Record<string, unknown> }).getState();
        return "activeThreadId" in st && "threads" in st;
      });
      if (!wsStore) return;
      (wsStore as { setState: (p: unknown) => void }).setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads,
        activeThreadId: activeId,
      });
    },
    { workspace: WORKSPACE, threads: [THREAD_A, THREAD_B], activeId: activeThreadId },
  );
  await openTerminalTab(page, WS_ID, activeThreadId);
  await ensureThreadTerminal(page, activeThreadId, ptyId);
}

test.describe("Terminal scroll on workspace thread switch", () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page, {
      "workspace.list": [WORKSPACE],
      "thread.list": [THREAD_A, THREAD_B],
      "terminal.create": (params: unknown) => {
        const threadId = (params as { threadId?: string })?.threadId ?? "thread-a";
        return { ptyId: `pty-${threadId}`, shell: "bash" };
      },
      "terminal.pause": true,
      "terminal.resume": true,
      "terminal.write": true,
      "terminal.resize": true,
      "terminal.kill": true,
      "terminal.killByThread": true,
      "settings.get": getDefaultSettings(),
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(
      () =>
        (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete ===
        true,
      { timeout: 30_000 },
    );
    await page.evaluate((wsUrl) => {
      (
        window as unknown as { __mcodeE2EAttachmentTransportWsUrl?: string }
      ).__mcodeE2EAttachmentTransportWsUrl = wsUrl;
    }, WS_URL);
  });

  test("restores viewport after sidebar thread switch", async ({ page }) => {
    await seedThreadsAndOpenTerminal(page, "thread-a");

    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __mcodeTerminalScrollHarness?: unknown })
          .__mcodeTerminalScrollHarness !== "undefined",
      { timeout: 20_000 },
    );

    const ptyId = await getActivePtyId(page, "thread-a");
    expect(ptyId.length).toBeGreaterThan(0);

    await page.waitForFunction(
      (id) => {
        const harness = (
          window as unknown as {
            __mcodeTerminalScrollHarness?: {
              getViewport: (pty: string) => unknown;
            };
          }
        ).__mcodeTerminalScrollHarness;
        return harness?.getViewport(id) !== null;
      },
      ptyId,
      { timeout: 10_000 },
    );

    await page.evaluate(
      ({ id }) => {
        const harness = (
          window as unknown as {
            __mcodeTerminalScrollHarness?: {
              writeLines: (pty: string, n: number) => void;
              scrollLines: (pty: string, amount: number) => void;
            };
          }
        ).__mcodeTerminalScrollHarness;
        if (!harness) throw new Error("harness missing");
        harness.writeLines(id, 200);
        harness.scrollLines(id, -80);
      },
      { id: ptyId },
    );

    await page.waitForTimeout(500);

    const beforeSwitch = await getHarnessViewport(page, ptyId);
    expect(beforeSwitch).not.toBeNull();
    const targetLine = beforeSwitch!.viewportY;

    await setActiveThread(page, "thread-b");
    await page.waitForTimeout(600);
    await setActiveThread(page, "thread-a");
    await openTerminalTab(page, WS_ID, "thread-a");

    await page.waitForFunction(
      ({ id, expected }) => {
        const harness = (
          window as unknown as {
            __mcodeTerminalScrollHarness?: {
              getViewport: (pty: string) => { viewportY: number } | null;
            };
          }
        ).__mcodeTerminalScrollHarness;
        const vp = harness?.getViewport(id);
        return vp !== null && vp !== undefined && Math.abs(vp.viewportY - expected) <= 2;
      },
      { id: ptyId, expected: targetLine },
      { timeout: 15_000 },
    );
  });

  test("shows xterm content after switching between two threads with terminals", async ({
    page,
  }) => {
    await seedThreadsAndOpenTerminal(page, "thread-a");

    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __mcodeTerminalScrollHarness?: unknown })
          .__mcodeTerminalScrollHarness !== "undefined",
      { timeout: 20_000 },
    );

    const ptyA = await getActivePtyId(page, "thread-a");
    expect(ptyA).toBeTruthy();

    await page.evaluate(
      ({ id }) => {
        const harness = (
          window as unknown as {
            __mcodeTerminalScrollHarness?: { writeLines: (pty: string, n: number) => void };
          }
        ).__mcodeTerminalScrollHarness;
        harness?.writeLines(id, 40);
      },
      { id: ptyA },
    );

    await ensureThreadTerminal(page, "thread-b", "pty-thread-b", "powershell");
    await setActiveThread(page, "thread-b");
    await openTerminalTab(page, WS_ID, "thread-b");
    await page.waitForTimeout(400);

    const ptyB = await getActivePtyId(page, "thread-b");
    expect(ptyB).toBe("pty-thread-b");

    await page.waitForFunction(
      (id) => {
        const harness = (
          window as unknown as {
            __mcodeTerminalScrollHarness?: {
              getViewport: (pty: string) => unknown;
              listPtyIds: () => string[];
            };
          }
        ).__mcodeTerminalScrollHarness;
        return harness?.listPtyIds().includes(id) && harness.getViewport(id) !== null;
      },
      ptyB,
      { timeout: 15_000 },
    );

    await setActiveThread(page, "thread-a");
    await openTerminalTab(page, WS_ID, "thread-a");
    await page.waitForTimeout(400);

    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });

    const vpAfter = await getHarnessViewport(page, ptyA);
    expect(vpAfter).not.toBeNull();
    expect(vpAfter!.length).toBeGreaterThan(10);
  });

  test("renders terminal when activeTerminalId was null but terminals exist", async ({
    page,
  }) => {
    await page.evaluate(
      ({ workspace, threads }) => {
        const stores: unknown[] = (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
        const wsStore = stores.find((s: unknown) => {
          const st = (s as { getState: () => Record<string, unknown> }).getState();
          return "activeThreadId" in st && "threads" in st;
        });
        if (!wsStore) return;
        (wsStore as { setState: (p: unknown) => void }).setState({
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          threads,
          activeThreadId: "thread-a",
        });
        const termStore = stores.find((s: unknown) => {
          const st = (s as { getState: () => Record<string, unknown> }).getState();
          return "terminals" in st;
        }) as {
          setState: (fn: (s: unknown) => unknown) => void;
        } | undefined;
        if (!termStore) return;
        termStore.setState((state: unknown) => {
          const s = state as {
            terminals: Record<string, { id: string; threadId: string; label: string }[]>;
            terminalPanelByThread: Record<string, { visible: boolean; height: number; activeTerminalId: string | null }>;
            ptyToThread: Record<string, string>;
          };
          return {
            terminals: {
              ...s.terminals,
              "thread-a": [{ id: "pty-stale", threadId: "thread-a", label: "powershell" }],
            },
            ptyToThread: { ...s.ptyToThread, "pty-stale": "thread-a" },
            terminalPanelByThread: {
              ...s.terminalPanelByThread,
              "thread-a": { visible: true, height: 300, activeTerminalId: null },
            },
          };
        });
      },
      { workspace: WORKSPACE, threads: [THREAD_A, THREAD_B] },
    );

    await openTerminalTab(page, WS_ID, "thread-a");

    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __mcodeTerminalScrollHarness?: unknown })
          .__mcodeTerminalScrollHarness !== "undefined",
      { timeout: 20_000 },
    );

    await page.waitForFunction(
      () => {
        const harness = (
          window as unknown as {
            __mcodeTerminalScrollHarness?: {
              getViewport: (pty: string) => unknown;
            };
          }
        ).__mcodeTerminalScrollHarness;
        return harness?.getViewport("pty-stale") !== null;
      },
      undefined,
      { timeout: 15_000 },
    );

    await expect(page.locator(".xterm").first()).toBeVisible();
  });
});
