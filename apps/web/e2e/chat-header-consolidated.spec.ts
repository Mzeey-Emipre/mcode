import { test, expect } from "@playwright/test";
import {
  interceptZustandStores,
  mockWebSocketServer,
  type WsController,
} from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

const MOCK_SETTINGS = getDefaultSettings();
const now = new Date().toISOString();
const WS_ID = "ws-1";

const workspace = {
  id: WS_ID,
  name: "Test Workspace",
  path: "/test/path",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now() - 3600_000,
  sort_order: 0,
};

const thread = {
  id: "thread-1",
  workspace_id: WS_ID,
  title: "Consolidated Header Thread",
  status: "paused" as const,
  mode: "worktree" as const,
  worktree_path: "/test/path/.worktrees/feat-x",
  branch: "feat/consolidated-header",
  checkout_state: "named" as const,
  base_branch: null,
  worktree_managed: true,
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

const openPrThread = {
  ...thread,
  pr_number: 42,
  pr_status: "open",
};

const openPr = {
  number: 42,
  state: "OPEN",
  url: "https://github.com/Mzeey-Empire/mcode/pull/42",
};

const usage = {
  providerId: "claude",
  quotaCategories: [
    {
      label: "5-hour limit",
      used: 12,
      total: 100,
      remainingPercent: 0.88,
      isUnlimited: false,
    },
    {
      label: "Weekly limit",
      used: 47,
      total: 100,
      remainingPercent: 0.53,
      isUnlimited: false,
    },
  ],
};

const gitCommit = {
  sha: "abc1234",
  message: "feat: work",
  author: "Tester",
  date: now,
};

const snapshot = {
  id: "snapshot-1",
  message_id: "message-1",
  thread_id: thread.id,
  ref_before: "before",
  ref_after: "after",
  files_changed: ["apps/web/src/components/chat/HeaderActions.tsx"],
  worktree_path: thread.worktree_path,
  created_at: now,
};

const branches = [
  {
    name: "feat/consolidated-header",
    shortSha: "abc1234",
    type: "local" as const,
    isCurrent: true,
  },
  {
    name: "main",
    shortSha: "def5678",
    type: "local" as const,
    isCurrent: false,
  },
  {
    name: "feat/git-create-branch",
    shortSha: "fed1234",
    type: "local" as const,
    isCurrent: false,
  },
  {
    name: "feat/review-panel",
    shortSha: "a1b2c3d",
    type: "local" as const,
    isCurrent: false,
  },
  {
    name: "feat/settings-sync",
    shortSha: "b2c3d4e",
    type: "local" as const,
    isCurrent: false,
  },
  {
    name: "fix/thread-switching",
    shortSha: "c3d4e5f",
    type: "local" as const,
    isCurrent: false,
  },
  {
    name: "chore/e2e-fixtures",
    shortSha: "d4e5f6a",
    type: "local" as const,
    isCurrent: false,
  },
  {
    name: "docs/runtime-guide",
    shortSha: "e5f6a7b",
    type: "local" as const,
    isCurrent: false,
  },
];

/** The Overview body, whether docked (reflowed) or floating (popover). */
const overviewContent = (page: import("@playwright/test").Page) =>
  page.getByTestId("thread-overview-body");

async function waitForHydration(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __mcodeHydrationComplete?: boolean }).__mcodeHydrationComplete === true,
  );
}

async function waitForChecksAggregate(
  page: import("@playwright/test").Page,
  threadId: string,
  aggregate: "passing" | "failing" | "pending",
): Promise<void> {
  await page.waitForFunction(
    ({ tid, agg }) => {
      const stores =
        (window as unknown as { __mcodeStores?: Array<{ getState: () => Record<string, unknown> }> })
          .__mcodeStores ?? [];
      const workspaceStore = stores.find((store) => {
        const state = store.getState();
        return "checksById" in state && "threads" in state && "workspaces" in state;
      });
      const checksById = workspaceStore?.getState().checksById as
        | Record<string, { aggregate?: string }>
        | undefined;
      return checksById?.[tid]?.aggregate === agg;
    },
    { tid: threadId, agg: aggregate },
  );
}

function checks(aggregate: "passing" | "failing" | "pending") {
  return {
    aggregate,
    runs: [],
    fetchedAt: Date.now(),
  };
}

function failingChecksWithRuns() {
  return {
    aggregate: "failing" as const,
    fetchedAt: Date.now(),
    runs: [
      {
        name: "Test Web E2E (shard 1/4)",
        status: "completed" as const,
        conclusion: "failure" as const,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 120_000,
      },
      {
        name: "Test",
        status: "in_progress" as const,
        conclusion: null,
        startedAt: new Date(Date.now() - 8_000).toISOString(),
        completedAt: null,
        durationMs: null,
      },
      {
        name: "Typecheck",
        status: "completed" as const,
        conclusion: "success" as const,
        startedAt: new Date(Date.now() - 42_000).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 42_000,
      },
    ],
  };
}

/** Opens the Overview if it isn't already (it auto-opens on wide viewports). */
async function ensureOverviewOpen(page: import("@playwright/test").Page) {
  const content = overviewContent(page);
  if (!(await content.isVisible().catch(() => false))) {
    await page.getByTestId("header-workspace-menu").click();
  }
  await expect(content).toBeVisible();
}

/** Closes the Overview if it auto-opened, so closed-state assertions are stable. */
async function ensureOverviewClosed(page: import("@playwright/test").Page) {
  const content = overviewContent(page);
  if (await content.isVisible().catch(() => false)) {
    await page.getByTestId("header-workspace-menu").click();
  }
  await expect(content).toBeHidden();
}

test.describe("Consolidated chat header", () => {
  // Dock the right panel inline (not as a modal overlay) so the header toggle
  // stays clickable for the show/hide assertions. The default panel width is 50%
  // of the viewport, so the panel only stays inline (rather than popping out as a
  // modal that intercepts the toggle click) on a wide desktop viewport.
  test.use({ viewport: { width: 1920, height: 1080 } });

  let remoteUrlCalls: unknown[] = [];

  test.beforeEach(async ({ page }) => {
    remoteUrlCalls = [];
    await page.addInitScript((wsId: string) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify({ [wsId]: true }),
      );
    }, WS_ID);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { __mcodeCopiedText?: string }).__mcodeCopiedText = text;
          },
        },
      });
    });
    await page.addInitScript(() => {
      const openedUrls: string[] = [];
      (window as unknown as { __mcodeOpenedExternalUrls?: string[] })
        .__mcodeOpenedExternalUrls = openedUrls;
      window.open = ((url?: string | URL) => {
        openedUrls.push(String(url ?? ""));
        return null;
      }) as typeof window.open;
    });

    await mockWebSocketServer(page, {
      "workspace.list": [workspace],
      "workspace.enrich": { items: [] },
      "workspace.touchLastOpened": null,
      "thread.list": [thread],
      "settings.get": MOCK_SETTINGS,
      "provider.getUsage": usage,
      // Keep PR polling deterministic: no existing PR, one commit ahead so the
      // Create PR affordance renders enabled.
      "github.branchPr": null,
      "git.log": [gitCommit],
      "snapshot.listByThread": [snapshot],
      "snapshot.getDiffStats": async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [
          {
            filePath: "apps/web/src/components/chat/HeaderActions.tsx",
            additions: 233,
            deletions: 0,
          },
        ];
      },
      "git.listBranches": async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return branches;
      },
      "git.getRemoteUrl": (params) => {
        remoteUrlCalls.push(params);
        return {
          label: "Mzeey-Empire/mcode",
          webUrl: "https://github.com/Mzeey-Empire/mcode",
        };
      },
      "git.workingTreeFiles": (params) =>
        (params as { staged?: boolean } | undefined)?.staged
          ? ["apps/web/src/components/chat/HeaderActions.tsx"]
          : [
              "apps/web/src/components/chat/ThreadOverview.tsx",
              "apps/web/e2e/chat-header-consolidated.spec.ts",
            ],
    });
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-item']");
    await page.locator("[data-testid='thread-item']").first().click();
    await page.waitForSelector("[data-testid='chat-header-title']");
  });

  test("keeps Open and the Overview controls visible; Create PR lives in the popover", async ({ page }) => {
    await ensureOverviewClosed(page);
    await expect(page.getByRole("button", { name: /^open in /i })).toBeVisible();
    await expect(page.getByTestId("header-workspace-menu")).toBeVisible();
    await expect(page.getByTestId("header-panel-toggle")).toBeVisible();
    // No standalone Create PR button in the header chrome. It lives in Overview
    // (no PR exists yet for this thread, so the PR-status badge is absent too).
    await expect(page.getByRole("button", { name: /create pr/i })).toHaveCount(0);
  });

  test("Overview popover holds changes, local, branch, and PR actions", async ({ page }) => {
    await ensureOverviewOpen(page);

    await expect(page.getByTestId("thread-overview-body")).toBeVisible();
    await expect(page.getByText("Environment", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("workspace-menu-changes")).toBeVisible();
    await expect(page.getByTestId("thread-overview-repository")).toBeVisible();
    await expect(page.getByTestId("thread-overview-local")).toBeVisible();
    await expect(page.getByTestId("workspace-menu-branch")).toBeVisible();
    await expect(page.getByTestId("thread-overview-pr")).toBeVisible();
    await expect(page.getByTestId("thread-overview-usage")).toHaveAttribute(
      "aria-label",
      "Usage, 5-hour 12%, weekly 47%",
    );
    await expect(page.getByTestId("thread-overview-usage")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("thread-overview-usage")).not.toContainText("5-hour 12%, weekly 47%");
    await expect(page.getByRole("progressbar", { name: "5-hour usage" })).toHaveAttribute(
      "aria-valuenow",
      "12",
    );
    await expect(page.getByRole("progressbar", { name: "weekly usage" })).toHaveAttribute(
      "aria-valuenow",
      "47",
    );
    await expect(page.getByText("usage unavailable")).toHaveCount(0);
    await expect(page.getByTestId("thread-overview-usage-popover")).toHaveCount(0);
    await expect(page.getByTestId("workspace-menu-create-pr")).toBeVisible();
    await expect(page.getByTestId("workspace-menu-commit")).toHaveCount(0);
    await expect(page.getByTestId("thread-overview-sources")).toHaveCount(0);
    await expect(page.locator(".animate-overview-enter").first()).toBeVisible();

    await expect(page.getByTestId("thread-overview-local")).toContainText("Worktree");
    await expect(page.getByTestId("thread-overview-repository")).toContainText(
      "REPOSITORY",
    );
    await expect(page.getByTestId("thread-overview-repository")).toContainText(
      "Mzeey-Empire/mcode",
    );
    await expect(page.getByTestId("thread-overview-repository-favicon-frame")).toBeVisible();
    await expect(page.getByTestId("thread-overview-repository-favicon")).toHaveAttribute(
      "src",
      "https://github.com/favicon.ico",
    );
    await expect(page.getByTestId("thread-overview-repository-favicon")).toHaveCSS(
      "filter",
      "invert(1)",
    );
    expect(remoteUrlCalls).toContainEqual({ workspaceId: WS_ID, threadId: thread.id });
    await page.getByTestId("thread-overview-repository-link").click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __mcodeOpenedExternalUrls?: string[] })
            .__mcodeOpenedExternalUrls?.at(-1),
        ),
      )
      .toBe("https://github.com/Mzeey-Empire/mcode");
    await expect(page.getByTestId("workspace-menu-branch")).toContainText("feat/consolidated-header");
    await expect(page.getByTestId("thread-overview-pr")).toContainText("Create PR");
    await expect(page.getByTestId("workspace-menu-create-pr")).toBeVisible();
    await expect(page.getByTestId("thread-overview-pr-status")).toHaveCount(0);
    await expect(page.getByTestId("thread-overview-pr-detail")).toHaveCount(0);
    await expect(page.getByTestId("thread-overview-change-summary")).toContainText("+233");
    await expect(page.getByTestId("thread-overview-change-summary")).toContainText("-0");
    await expect(page.getByTestId("workspace-menu-changes")).toHaveCSS("cursor", "pointer");
    await expect(page.getByTestId("thread-overview-local-popover")).toHaveCount(0);

    await page.getByTestId("thread-overview-local").click();
    await expect(page.getByTestId("thread-overview-local-popover")).toBeVisible();
    await expect(page.getByTestId("thread-overview-local-path")).toContainText(
      "/test/path/.worktrees/feat-x",
    );
    await expect(page.getByTestId("thread-overview-local-branch")).toContainText(
      "feat/consolidated-header",
    );
    await page.getByRole("button", { name: "Copy worktree path" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __mcodeCopiedText?: string }).__mcodeCopiedText),
      )
      .toBe("/test/path/.worktrees/feat-x");
    await page.getByRole("button", { name: "Copy branch" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __mcodeCopiedText?: string }).__mcodeCopiedText),
      )
      .toBe("feat/consolidated-header");

    await page.getByTestId("workspace-menu-branch").click();
    await expect(page.getByTestId("thread-overview-branch-popover")).toBeVisible();
    await expect(page.getByTestId("thread-overview-branch-list")).not.toHaveClass(/h-60/);
    await expect(page.getByRole("textbox", { name: "Search branches" })).toBeVisible();
    await expect(page.getByTestId("thread-overview-current-branch")).toContainText(
      "feat/consolidated-header",
    );
    await expect(page.getByTestId("thread-overview-branch-list")).toHaveClass(/h-60/);
    await expect(page.getByTestId("thread-overview-branch-list")).toHaveJSProperty(
      "clientHeight",
      240,
    );
    await expect(page.getByTestId("thread-overview-current-branch")).toContainText(
      "Uncommitted: 3 files",
    );
    await expect(page.getByTestId("thread-overview-create-checkout-branch")).toBeEnabled();
  });

  test("panel toggle shows and hides the workspace-global right panel", async ({ page }) => {
    const toggle = page.getByTestId("header-panel-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // The panel's tab rail becomes visible once the panel opens. The changes
    // tab is labelled "Review" (see panel-tabs.ts).
    await expect(page.getByText("Review", { exact: true })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("Changes row opens the right panel", async ({ page }) => {
    const toggle = page.getByTestId("header-panel-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await ensureOverviewOpen(page);
    await page.getByTestId("workspace-menu-changes").click();

    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("auto-opens the Overview when the viewport has room", async ({ page }) => {
    // Wide describe viewport (1920px) leaves room, so the Overview sits open
    // without a click. It steps aside on narrow viewports / when cramped.
    await expect(overviewContent(page)).toBeVisible();
    await expect(page.getByTestId("thread-overview-repository")).toBeVisible();
  });

  test("keeps the thread centered when the Overview has room beside it", async ({ page }) => {
    await ensureOverviewOpen(page);

    const messageAreaPaddingRight = await page
      .locator("[data-testid='chat-view'] > .animate-fade-up-in")
      .evaluate((node) => getComputedStyle(node).paddingRight);

    expect(messageAreaPaddingRight).toBe("0px");
  });
});

test.describe("Consolidated chat header CI trigger state", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  let ws: WsController;

  test.beforeEach(async ({ page }) => {
    await interceptZustandStores(page);
    await page.addInitScript((wsId: string) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify({ [wsId]: true }),
      );
    }, WS_ID);

    ws = await mockWebSocketServer(page, {
      "workspace.list": [workspace],
      "workspace.enrich": { items: [] },
      "workspace.touchLastOpened": null,
      "thread.list": [openPrThread],
      "settings.get": MOCK_SETTINGS,
      "provider.getUsage": usage,
      "github.branchPr": openPr,
      "git.log": [gitCommit],
      "snapshot.listByThread": [snapshot],
      "snapshot.getDiffStats": [],
      "git.listBranches": branches,
      "git.getRemoteUrl": {
        label: "Mzeey-Empire/mcode",
        webUrl: "https://github.com/Mzeey-Empire/mcode",
      },
      "git.workingTreeFiles": [],
    });

    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-item']");
    await page.locator("[data-testid='thread-item']").first().click();
    await page.waitForSelector("[data-testid='chat-header-title']");
    await waitForHydration(page);
  });

  test("updates the Overview trigger CI dot for pending, failing, and passing checks", async ({ page }) => {
    const trigger = page.getByTestId("header-workspace-menu");
    await expect(page.getByTestId("thread-overview-pr")).toContainText("PR #42");

    await expect(trigger).toHaveAttribute("aria-label", "Thread overview");
    await expect(trigger).toHaveAttribute("title", "Thread overview");
    await expect(page.getByTestId("thread-overview-ci-red")).toHaveCount(0);
    await expect(page.getByTestId("thread-overview-ci-green")).toHaveCount(0);

    await ws.sendPush("thread.checksUpdated", {
      threadId: openPrThread.id,
      checks: checks("pending"),
    });
    await waitForChecksAggregate(page, openPrThread.id, "pending");

    await expect(trigger).toHaveAttribute("aria-label", "Thread overview");
    await expect(page.getByTestId("thread-overview-ci-red")).toHaveCount(0);
    await expect(page.getByTestId("thread-overview-ci-green")).toHaveCount(0);

    await ws.sendPush("thread.checksUpdated", {
      threadId: openPrThread.id,
      checks: checks("failing"),
    });
    await waitForChecksAggregate(page, openPrThread.id, "failing");

    await expect(trigger).toHaveAttribute("aria-label", "Thread overview, CI checks failing");
    await expect(trigger).toHaveAttribute("title", "Thread overview, CI checks failing");
    await expect(page.getByTestId("thread-overview-ci-red")).toBeVisible();
    await expect(page.getByTestId("thread-overview-ci-green")).toHaveCount(0);

    await ws.sendPush("thread.checksUpdated", {
      threadId: openPrThread.id,
      checks: checks("passing"),
    });
    await waitForChecksAggregate(page, openPrThread.id, "passing");

    await expect(trigger).toHaveAttribute("aria-label", "Thread overview, CI checks passing");
    await expect(trigger).toHaveAttribute("title", "Thread overview, CI checks passing");
    await expect(page.getByTestId("thread-overview-ci-green")).toBeVisible();
    await expect(page.getByTestId("thread-overview-ci-red")).toHaveCount(0);
  });

  test("keeps a trigger click active when CI status changes during the click", async ({ page }) => {
    const trigger = page.getByTestId("header-workspace-menu");
    await expect(page.getByTestId("thread-overview-body")).toBeVisible();

    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    const center = {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    };

    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await ws.sendPush("thread.checksUpdated", {
      threadId: openPrThread.id,
      checks: checks("failing"),
    });
    await waitForChecksAggregate(page, openPrThread.id, "failing");
    await page.mouse.up();

    await expect(page.getByTestId("thread-overview-body")).toBeHidden();
  });

  test("shows CI summary below the PR row and expands details from it", async ({ page }) => {
    await ws.sendPush("thread.checksUpdated", {
      threadId: openPrThread.id,
      checks: failingChecksWithRuns(),
    });
    await waitForChecksAggregate(page, openPrThread.id, "failing");
    await ensureOverviewOpen(page);

    const summary = page.getByTestId("thread-overview-pr-status");
    await expect(summary).toHaveAttribute("aria-label", /1 failing/);
    await expect(summary).toHaveAttribute("aria-label", /1 green/);
    await expect(summary).not.toContainText("Checks failing");
    await expect(summary).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(summary).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");

    await summary.hover();
    await expect(page.getByText("Test Web E2E (shard 1/4)")).toBeVisible();
    await expect(page.getByText("Typecheck")).toBeVisible();
  });
});
