import { test, type Page } from "@playwright/test";
import type { Thread, ProviderUsageInfo, ProviderId } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
} from "./helpers/e2e-helpers";

/**
 * Visual-verification spec for the SidebarUsagePanel across providers and states.
 *
 * Purpose: capture enough screenshots to run a design critique/polish pass on
 * the hover popover. No assertions — these exist purely to surface the UI in
 * the real rendered conditions that production users hit.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const THREAD_ID = "thread-usage-visual";
const WORKSPACE = {
  id: "ws-usage-visual",
  name: "Usage Visual",
  path: "/tmp/usage-visual",
  provider_config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function makeThread(provider: ProviderId, model: string | null): Thread {
  return {
    id: THREAD_ID,
    workspace_id: WORKSPACE.id,
    title: "Usage Panel Visual",
    status: "active",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    issue_number: null,
    pr_number: null,
    pr_status: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model,
    deleted_at: null,
    worktree_managed: false,
    sdk_session_id: null,
    provider,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    permission_mode: null,
    parent_thread_id: null,
    forked_from_message_id: null,
  };
}

// ─── State injection helpers ─────────────────────────────────────────────────

interface VisualState {
  provider: ProviderId;
  model: string | null;
  usage?: ProviderUsageInfo;
  context?: {
    lastTokensIn: number;
    contextWindow?: number;
    tokensOut?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costMultiplier?: number;
  };
}

async function applyState(page: Page, state: VisualState): Promise<void> {
  await page.evaluate(
    ({ workspace, thread, threadId, provider, usage, context }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stores: any[] = (window as any).__mcodeStores ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsStore = stores.find((s: any) => {
        const st = s.getState();
        return "activeThreadId" in st && "threads" in st && "workspaces" in st;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threadStore = stores.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) =>
          "contextByThread" in s.getState() &&
          "usageByProvider" in s.getState(),
      );
      if (!wsStore || !threadStore) {
        console.error("[E2E] required stores not found", {
          wsStore: !!wsStore,
          threadStore: !!threadStore,
        });
        return;
      }
      wsStore.setState({
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        threads: [thread],
        activeThreadId: threadId,
      });
      const key = `${threadId}:${provider}`;
      threadStore.setState((prev: Record<string, unknown>) => ({
        ...prev,
        usageByProvider: usage ? { [key]: usage } : {},
        contextByThread: context ? { [threadId]: context } : {},
      }));
    },
    {
      workspace: WORKSPACE,
      thread: makeThread(state.provider, state.model),
      threadId: THREAD_ID,
      provider: state.provider,
      usage: state.usage,
      context: state.context,
    },
  );
}

async function openAndCapture(page: Page, name: string): Promise<void> {
  // Strip lives in sidebar footer. Screenshot strip-only first.
  const strip = page.locator('[data-slot="popover-trigger"]').filter({
    has: page.locator("div.space-y-1\\.5"),
  }).last();

  await page
    .screenshot({
      path: `e2e/screenshots/usage/${name}-01-strip.png`,
      clip: await strip.boundingBox().then((b) =>
        b ? { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 } : undefined,
      ),
    })
    .catch(() => {
      // If clip resolution fails, fall back to sidebar-level shot.
      return page.screenshot({ path: `e2e/screenshots/usage/${name}-01-strip.png` });
    });

  // Hover to open popover.
  await strip.hover({ force: true });
  // Popover has a 150ms close-delay timer; wait a beat for the open animation.
  await page.waitForTimeout(400);

  // Popover-only screenshot.
  const popover = page.locator('[data-slot="popover-content"]').first();
  const box = await popover.boundingBox();
  await page.screenshot({
    path: `e2e/screenshots/usage/${name}-02-popover.png`,
    clip: box
      ? { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 }
      : undefined,
  });

  // Full page for context.
  await page.screenshot({
    path: `e2e/screenshots/usage/${name}-03-full.png`,
    fullPage: true,
  });

  // Close popover before next state.
  await page.locator("body").hover({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(300);
}

// ─── State matrix ────────────────────────────────────────────────────────────

const nowPlus = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();

const STATES: Record<string, VisualState> = {
  "claude-empty": {
    provider: "claude",
    model: "claude-opus-4-7",
  },

  "claude-first-turn": {
    provider: "claude",
    model: "claude-opus-4-7",
    usage: {
      providerId: "claude",
      quotaCategories: [],
      sessionCostUsd: 0.0142,
      numTurns: 1,
      durationMs: 8_400,
      serviceTier: "standard",
    },
    context: {
      lastTokensIn: 12_400,
      contextWindow: 200_000,
      tokensOut: 890,
      cacheReadTokens: 0,
      cacheWriteTokens: 11_200,
    },
  },

  "claude-mid-session": {
    provider: "claude",
    model: "claude-opus-4-7",
    usage: {
      providerId: "claude",
      quotaCategories: [],
      sessionCostUsd: 1.1287,
      numTurns: 5,
      durationMs: 98_000,
      serviceTier: "standard",
    },
    context: {
      lastTokensIn: 73_000,
      contextWindow: 200_000,
      tokensOut: 7_000,
      cacheReadTokens: 308_000,
      cacheWriteTokens: 8_000,
    },
  },

  "claude-near-limit": {
    provider: "claude",
    model: "claude-opus-4-7",
    usage: {
      providerId: "claude",
      quotaCategories: [
        {
          label: "Opus weekly",
          used: 188,
          total: 200,
          remainingPercent: 0.06,
          resetDate: nowPlus(1.5),
          isUnlimited: false,
        },
        {
          label: "All models weekly",
          used: 640,
          total: 900,
          remainingPercent: 0.29,
          resetDate: nowPlus(1.5),
          isUnlimited: false,
        },
      ],
      sessionCostUsd: 4.5032,
      numTurns: 12,
      durationMs: 420_000,
      serviceTier: "priority",
    },
    context: {
      lastTokensIn: 188_500,
      contextWindow: 200_000,
      tokensOut: 14_200,
      cacheReadTokens: 1_440_000,
      cacheWriteTokens: 42_000,
    },
  },

  "claude-max-unlimited": {
    provider: "claude",
    model: "claude-opus-4-7",
    usage: {
      providerId: "claude",
      quotaCategories: [
        {
          label: "Opus weekly",
          used: 0,
          total: null,
          remainingPercent: 1,
          resetDate: nowPlus(4),
          isUnlimited: true,
        },
        {
          label: "All models weekly",
          used: 0,
          total: null,
          remainingPercent: 1,
          resetDate: nowPlus(4),
          isUnlimited: true,
        },
      ],
      sessionCostUsd: 0.7821,
      numTurns: 3,
      durationMs: 52_000,
      serviceTier: "standard",
    },
    context: {
      lastTokensIn: 41_000,
      contextWindow: 200_000,
      tokensOut: 3_200,
      cacheReadTokens: 104_000,
      cacheWriteTokens: 4_400,
    },
  },

  "codex-mid-session": {
    provider: "codex",
    model: "gpt-5-codex",
    usage: {
      providerId: "codex",
      quotaCategories: [
        {
          label: "5h limit",
          used: 17,
          total: 150,
          remainingPercent: 0.89,
          resetDate: nowPlus(0.2),
          isUnlimited: false,
        },
        {
          label: "Weekly limit",
          used: 120,
          total: 1500,
          remainingPercent: 0.92,
          resetDate: nowPlus(5),
          isUnlimited: false,
        },
      ],
    },
    context: {
      lastTokensIn: 54_000,
      contextWindow: 272_000,
      tokensOut: 3_800,
    },
  },

  "codex-near-reset": {
    provider: "codex",
    model: "gpt-5-codex",
    usage: {
      providerId: "codex",
      quotaCategories: [
        {
          label: "5h limit",
          used: 138,
          total: 150,
          remainingPercent: 0.08,
          resetDate: new Date(Date.now() + 3_600_000).toISOString(),
          isUnlimited: false,
        },
        {
          label: "Weekly limit",
          used: 1_420,
          total: 1_500,
          remainingPercent: 0.05,
          resetDate: nowPlus(2),
          isUnlimited: false,
        },
      ],
    },
    context: {
      lastTokensIn: 210_000,
      contextWindow: 272_000,
      tokensOut: 9_100,
    },
  },

  // Copilot Pro plan in a healthy mid-month state. Premium requests are the
  // only metered bucket; Chat and Completions are unlimited on Pro.
  "copilot-pro-healthy": {
    provider: "copilot",
    model: "claude-sonnet-4-6",
    usage: {
      providerId: "copilot",
      quotaCategories: [
        {
          label: "Premium requests",
          used: 82,
          total: 300,
          remainingPercent: 0.73,
          resetDate: nowPlus(12),
          isUnlimited: false,
        },
        {
          label: "Chat",
          used: 0,
          total: null,
          remainingPercent: 1,
          resetDate: nowPlus(12),
          isUnlimited: true,
        },
        {
          label: "Completions",
          used: 0,
          total: null,
          remainingPercent: 1,
          resetDate: nowPlus(12),
          isUnlimited: true,
        },
      ],
    },
    context: {
      lastTokensIn: 34_000,
      contextWindow: 128_000,
      tokensOut: 2_100,
    },
  },

  // Copilot Pro about to exhaust premium requests near the monthly reset.
  // Exercises the critical hint row and the destructive-token visual path.
  "copilot-pro-near-limit": {
    provider: "copilot",
    model: "claude-opus-4-7",
    usage: {
      providerId: "copilot",
      quotaCategories: [
        {
          label: "Premium requests",
          used: 287,
          total: 300,
          remainingPercent: 0.04,
          resetDate: nowPlus(3),
          isUnlimited: false,
        },
        {
          label: "Chat",
          used: 0,
          total: null,
          remainingPercent: 1,
          resetDate: nowPlus(3),
          isUnlimited: true,
        },
        {
          label: "Completions",
          used: 0,
          total: null,
          remainingPercent: 1,
          resetDate: nowPlus(3),
          isUnlimited: true,
        },
      ],
    },
    context: {
      lastTokensIn: 92_000,
      contextWindow: 200_000,
      tokensOut: 5_800,
    },
  },

  // Free-tier Copilot: small premium bucket almost gone. Demonstrates the
  // panel's read on a constrained free account — the shape most new users hit.
  "copilot-free-squeezed": {
    provider: "copilot",
    model: "gpt-4o-mini",
    usage: {
      providerId: "copilot",
      quotaCategories: [
        {
          label: "Premium requests",
          used: 47,
          total: 50,
          remainingPercent: 0.06,
          resetDate: nowPlus(18),
          isUnlimited: false,
        },
        {
          label: "Chat",
          used: 18,
          total: 50,
          remainingPercent: 0.64,
          resetDate: nowPlus(18),
          isUnlimited: false,
        },
        {
          label: "Completions",
          used: 640,
          total: 2_000,
          remainingPercent: 0.68,
          resetDate: nowPlus(18),
          isUnlimited: false,
        },
      ],
    },
    context: {
      lastTokensIn: 22_000,
      contextWindow: 128_000,
      tokensOut: 1_400,
    },
  },
};

// ─── Test body ───────────────────────────────────────────────────────────────

// Point this spec at the dedicated dev server started on :5174 so it does not
// collide with the :5173 server run by the sibling worktree.
test.use({ baseURL: "http://localhost:5174" });

test.describe("SidebarUsagePanel · visual matrix", () => {
  test.beforeEach(async ({ page }) => {
    // Supply a thread.messages=[] response for this thread so ChatView doesn't hang.
    await mockWebSocketServer(page, {
      "thread.messages": [],
      "provider.getUsage": null,
    });
    await interceptZustandStores(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
  });

  for (const [name, state] of Object.entries(STATES)) {
    test(`captures ${name}`, async ({ page }) => {
      await applyState(page, state);
      // Wait for React render + strip hydration.
      await page.waitForTimeout(350);
      await openAndCapture(page, name);
    });
  }
});
