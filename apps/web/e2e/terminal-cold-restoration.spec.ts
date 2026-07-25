import { expect, test, type Page } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import { getDefaultSettings } from "@mcode/contracts";
import {
  interceptZustandStores,
  mockWebSocketServer,
} from "./helpers/e2e-helpers";

const now = new Date().toISOString();
const workspace = {
  id: "ws-cold-terminal",
  name: "Cold terminal restoration",
  path: "/tmp/cold-terminal",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const thread: Thread = {
  id: "thread-cold-terminal",
  workspace_id: workspace.id,
  title: "Cold terminal",
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

const baseOverrides = {
  "workspace.list": [workspace],
  "thread.list": [thread],
  "terminal.write": true,
  "terminal.resize": true,
  "terminal.pause": true,
  "terminal.resume": true,
  "terminal.kill": true,
  "terminal.killByThread": true,
  "settings.get": getDefaultSettings(),
} as const;

async function seedTerminal(page: Page, ptyId: string): Promise<void> {
  await page.evaluate(
    ({ workspaceFixture, threadFixture, pty }) => {
      const stores =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const workspaceStore = stores.find((candidate) => {
        const state = (
          candidate as { getState: () => Record<string, unknown> }
        ).getState();
        return "activeThreadId" in state && "threads" in state;
      }) as { setState: (state: unknown) => void } | undefined;
      const panelStore = stores.find((candidate) => {
        const state = (
          candidate as { getState: () => Record<string, unknown> }
        ).getState();
        return "showRightPanel" in state && "setRightPanelTab" in state;
      }) as
        | {
            getState: () => {
              showRightPanel: (workspaceId: string, threadId: string) => void;
              setRightPanelTab: (
                workspaceId: string,
                threadId: string,
                tab: string,
              ) => void;
            };
          }
        | undefined;
      const terminalStore = stores.find((candidate) => {
        const state = (
          candidate as { getState: () => Record<string, unknown> }
        ).getState();
        return "addTerminal" in state && "setActiveTerminal" in state;
      }) as
        | {
            getState: () => {
              addTerminal: (
                threadId: string,
                terminalId: string,
                label: string,
              ) => void;
            };
          }
        | undefined;

      workspaceStore?.setState({
        workspaces: [workspaceFixture],
        activeWorkspaceId: workspaceFixture.id,
        threads: [threadFixture],
        activeThreadId: threadFixture.id,
      });
      panelStore
        ?.getState()
        .showRightPanel(workspaceFixture.id, threadFixture.id);
      panelStore
        ?.getState()
        .setRightPanelTab(workspaceFixture.id, threadFixture.id, "terminal");
      terminalStore?.getState().addTerminal(threadFixture.id, pty, pty);
    },
    { workspaceFixture: workspace, threadFixture: thread, pty: ptyId },
  );
}

async function selectTerminal(page: Page, ptyId: string): Promise<void> {
  await page.evaluate(
    ({ threadId, pty }) => {
      const stores =
        (window as unknown as { __mcodeStores?: unknown[] }).__mcodeStores ?? [];
      const terminalStore = stores.find((candidate) => {
        const state = (
          candidate as { getState: () => Record<string, unknown> }
        ).getState();
        return "setActiveTerminal" in state;
      }) as
        | {
            getState: () => {
              setActiveTerminal: (threadId: string, ptyId: string) => void;
            };
          }
        | undefined;
      terminalStore?.getState().setActiveTerminal(threadId, pty);
    },
    { threadId: thread.id, pty: ptyId },
  );
}

async function boot(page: Page): Promise<void> {
  await interceptZustandStores(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () =>
      (window as unknown as { __mcodeHydrationComplete?: boolean })
        .__mcodeHydrationComplete === true,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    Object.defineProperty(window, "desktopBridge", {
      value: {},
      configurable: true,
    });
  });
}

test.describe("terminal cold restoration", () => {
  test.setTimeout(90_000);

  test("restores split ANSI text and foreground from a serialized checkpoint", async ({
    page,
  }) => {
    const checkpoints = new Map<string, string>();
    const attachCounts = new Map<string, number>();
    const ws = await mockWebSocketServer(page, {
      ...baseOverrides,
      "terminal.checkpoint": (params: unknown) => {
        const value = params as { ptyId: string; data: string };
        checkpoints.set(value.ptyId, value.data);
        return { accepted: true };
      },
      "terminal.reattach": (params: unknown) => {
        const { ptyId } = params as { ptyId: string };
        const count = (attachCounts.get(ptyId) ?? 0) + 1;
        attachCounts.set(ptyId, count);
        const checkpoint = checkpoints.get(ptyId);
        return count > 1 && checkpoint
          ? { mode: "checkpoint", checkpoint }
          : { mode: "delta" };
      },
    });
    await boot(page);
    await seedTerminal(page, "pty-a");
    await expect(page.locator(".xterm")).toHaveCount(1);

    await ws.sendPush("terminal.data", {
      ptyId: "pty-a",
      data: "\u001b[3",
      seq: 1,
    });
    await ws.sendPush("terminal.data", {
      ptyId: "pty-a",
      data: "1mRED\u001b[0m plain",
      seq: 2,
    });
    await expect(page.locator(".xterm-rows")).toContainText("RED plain");

    await seedTerminal(page, "pty-b");
    await expect.poll(() => checkpoints.has("pty-a")).toBe(true);
    await selectTerminal(page, "pty-a");
    await expect(page.locator(".xterm")).toHaveCount(1);
    await expect(page.locator(".xterm-rows")).toContainText("RED plain");

    const colors = await page.locator(".xterm-rows").evaluate((rows) => {
      const spans = [...rows.querySelectorAll("span")];
      const red = spans.find((span) => span.textContent?.includes("RED"));
      const plain = spans.find((span) => span.textContent?.includes("plain"));
      return {
        red: red ? getComputedStyle(red).color : "",
        plain: plain ? getComputedStyle(plain).color : "",
      };
    });
    expect(colors.red).toBe("rgb(204, 0, 0)");
    expect(colors.plain).not.toBe(colors.red);
  });

  test("drops a discontinuous retained tail and resumes with safe future output", async ({
    page,
  }) => {
    const attachCounts = new Map<string, number>();
    const ws = await mockWebSocketServer(page, {
      ...baseOverrides,
      "terminal.checkpoint": () => ({ accepted: false }),
      "terminal.reattach": (params: unknown) => {
        const { ptyId } = params as { ptyId: string };
        const count = (attachCounts.get(ptyId) ?? 0) + 1;
        attachCounts.set(ptyId, count);
        return ptyId === "pty-gap" && count > 1
          ? { mode: "reset", discardThrough: 20 }
          : { mode: "delta" };
      },
    });
    await boot(page);
    await seedTerminal(page, "pty-gap");
    await ws.sendPush("terminal.data", {
      ptyId: "pty-gap",
      data: "before-gap\u001b[31",
      seq: 10,
    });

    await seedTerminal(page, "pty-other");
    await selectTerminal(page, "pty-gap");
    await expect.poll(() => attachCounts.get("pty-gap")).toBe(2);
    await expect(page.locator(".xterm")).toHaveCount(1);
    await expect(page.locator(".xterm-rows")).toContainText(
      "Earlier output beyond the scrollback limit was trimmed",
    );
    await ws.sendPush("terminal.data", {
      ptyId: "pty-gap",
      data: "future-safe",
      seq: 21,
    });

    await expect(page.locator(".xterm-rows")).toContainText("future-safe");
    const rendered = await page.locator(".xterm-rows").innerText();
    expect(rendered).toContain("future-safe");
    expect(rendered).not.toContain("before-gap");
    expect(rendered).not.toContain("[31");
    await expect(page.locator(".xterm")).toHaveCount(1);
  });
});
