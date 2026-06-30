import { test, expect } from "@playwright/test";
import { interceptZustandStores, mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Visual demo: the Overview popover (repository row + Sources favicon grid),
 * its space-aware auto-open, and humanized inline links in the transcript.
 * Captures screenshots to e2e/screenshots/demo/ for review without a live app.
 */

const now = new Date("2026-06-19T00:00:00.000Z").toISOString();
const WS_ID = "ws-demo";

const workspace = {
  id: WS_ID,
  name: "CaravanFE",
  path: "/tmp/caravanfe",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const thread = {
  id: "thread-demo",
  workspace_id: WS_ID,
  title: "Logo work",
  status: "paused" as const,
  mode: "worktree" as const,
  worktree_path: "/tmp/caravanfe/.worktrees/feat-x",
  branch: "feat/logo",
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

const baseMsg = {
  thread_id: thread.id,
  tool_calls: null,
  files_changed: null,
  cost_usd: null,
  tokens_used: null,
  timestamp: now,
  attachments: null,
  tool_call_count: 0,
};

const userMessage = {
  ...baseMsg,
  id: "user-demo",
  role: "user" as const,
  content: "we have been slapped with a subscribe page. any alternatives?",
  sequence: 1,
};

const assistantMessage = {
  ...baseMsg,
  id: "assistant-demo",
  role: "assistant" as const,
  content: [
    "Yep. Alternatives:",
    "",
    "1. SVGTrace: free, color SVG, layered output. https://svgtrace.com/",
    "2. Adobe Express SVG converter: https://www.adobe.com/express/feature/image/convert/svg",
    "3. Recraft SVG converter: https://www.recraft.ai/ai-image-vectorizer",
    "4. The repo lives at https://github.com/milex-consulting/CaravanFE",
    "5. Tracking issue: https://github.com/milex-consulting/CaravanFE/issues/42",
    "6. Screenshot artifact: [local-unseeded-app.png](/tmp/screens/local-unseeded-app.png)",
    "",
    "My pick: try SVGTrace next.",
  ].join("\n"),
  sequence: 2,
};

const followUpMessage = {
  ...baseMsg,
  id: "user-follow-up-demo",
  role: "user" as const,
  content: "Great, show that in the Overview too.",
  sequence: 3,
  timestamp: "2026-06-19T00:17:00.000Z",
};

test.use({ viewport: { width: 1920, height: 1080 } });

test("Overview sources + humanized links demo", async ({ page }) => {
  const recapText =
    "Checking SVG alternatives and wiring the Overview surface so the team can compare options without reopening the transcript. The current pass keeps source links, repository context, and recap details visible together so returning users can recover the thread state without scanning prior messages.";
  let resolveRecap!: (value: { text: string }) => void;
  const recapResult = new Promise<{ text: string }>((resolve) => {
    resolveRecap = resolve;
  });

  await interceptZustandStores(page);
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "thread.list": [thread],
    "conversation.page": {
      messages: [userMessage, assistantMessage, followUpMessage],
      hasMore: false,
      answeredPlanMessageIds: [],
      narrativeByMessage: {},
    },
    "narrative.list": { tools: [], thoughts: [], hooks: [] },
    "github.branchPr": null,
    "git.log": [{ sha: "abc1234", message: "feat: work", author: "Tester", date: now }],
    "snapshot.listByThread": [],
    "git.listBranches": [
      { name: "feat/logo", shortSha: "abc1234", type: "local", isCurrent: true },
    ],
    "git.listWorktrees": [
      { name: "feat-x", path: "/tmp/caravanfe/.worktrees/feat-x", branch: "feat/logo", managed: true },
    ],
    "git.getRemoteUrl": {
      label: "milex-consulting/CaravanFE",
      webUrl: "https://github.com/milex-consulting/CaravanFE",
    },
    "git.workingTreeFiles": [],
    "recap.generate": () => recapResult,
  });

  await page.addInitScript((wsId: string) => {
    localStorage.setItem("mcode-expanded-projects", JSON.stringify({ [wsId]: true }));
  }, WS_ID);
  await page.goto("/");
  await page.waitForSelector("[data-testid='thread-item']");
  await page.locator("[data-testid='thread-item']").first().click();
  await page.waitForSelector("[data-testid='chat-header-title']");

  // Humanized inline links in the transcript.
  await expect(page.getByText("milex-consulting/CaravanFE#42")).toBeVisible();
  await expect(page.getByTestId("markdown-link-file-icon")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/demo/transcript-humanized-links.png", fullPage: false });

  // Wide viewport: the Overview opens by default and shows repo, Sources, and the closing Recap.
  await expect(page.getByTestId("thread-overview-body")).toBeVisible();
  await expect(page.getByTestId("thread-overview-recap")).toBeVisible();
  await expect(page.getByTestId("thread-overview-recap-skeleton")).toBeVisible();
  await expect(page.getByTestId("thread-overview-recap-refresh")).toBeDisabled();
  const refreshIconClass = await page
    .getByTestId("thread-overview-recap-refresh")
    .locator("svg")
    .getAttribute("class");
  expect(refreshIconClass ?? "").not.toContain("animate-spin");
  await page.screenshot({ path: "e2e/screenshots/demo/overview-recap-skeleton.png", fullPage: false });
  resolveRecap({ text: recapText });
  await expect(page.getByTestId("thread-overview-recap-text")).toContainText("Checking SVG alternatives");
  await expect(page.getByTestId("thread-overview-recap-text")).toContainText("without scanning prior messages");
  await expect(page.getByTestId("thread-overview-recap-text")).not.toContainText("...");
  await expect(page.getByTestId("thread-overview-recap-skeleton")).toHaveCount(0);
  await page.evaluate((threadId) => {
    type StoreHandle = {
      getState: () => Record<string, unknown>;
      setState: (state: Record<string, unknown>) => void;
    };
    const stores = (window as unknown as { __mcodeStores?: StoreHandle[] }).__mcodeStores ?? [];
    const threadStore = stores.find((store) => {
      const state = store.getState();
      return "recapByThread" in state && "records" in state;
    });
    const state = threadStore?.getState();
    if (!threadStore || !state) throw new Error("Thread store unavailable");

    threadStore.setState({
      recapByThread: {
        ...(state.recapByThread as Record<string, unknown>),
        [threadId]: {
          text: "Cached recap stays readable while newer activity exists.",
          signature: "older-signature",
          coveredMessageId: "assistant-demo",
          generatedAt: "2026-06-19T00:01:00.000Z",
        },
      },
    });
  }, thread.id);
  await expect(page.getByTestId("thread-overview-recap-text")).toContainText(
    "Cached recap stays readable",
  );
  await page.getByTestId("thread-overview-recap").screenshot({
    path: "e2e/screenshots/demo/overview-recap-coverage-row.png",
  });
  await page.getByTestId("thread-overview-recap-coverage").hover();
  await expect(page.getByText(/Covered through/)).toBeVisible();
  await expect(page.getByText(/Latest activity/)).toBeVisible();
  await page.screenshot({
    path: "e2e/screenshots/demo/overview-recap-coverage-tooltip.png",
    fullPage: false,
  });
  await page.getByTestId("thread-overview-recap-coverage").focus();
  await expect(page.getByText(/Covered through/)).toBeVisible();
  await expect(page.getByTestId("thread-overview-recap")).not.toContainText(/stale|out of date|generate/i);
  const recapTextStyles = await page.getByTestId("thread-overview-recap-text").evaluate((node) => {
    const styles = window.getComputedStyle(node);
    return {
      textOverflow: styles.textOverflow,
      whiteSpace: styles.whiteSpace,
      clipped: node.scrollHeight > node.clientHeight,
    };
  });
  expect(recapTextStyles).toEqual({ textOverflow: "clip", whiteSpace: "normal", clipped: false });
  await expect(page.getByTestId("thread-overview-repository")).toBeVisible();
  await expect(page.getByTestId("thread-overview-sources")).toBeVisible();
  const recapFollowsSources = await page.evaluate(() => {
    const sources = document.querySelector('[data-testid="thread-overview-sources"]');
    const recap = document.querySelector('[data-testid="thread-overview-recap"]');
    if (!sources || !recap) return false;
    return Boolean(sources.compareDocumentPosition(recap) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(recapFollowsSources).toBe(true);
  const sourceCount = await page.getByTestId("thread-overview-source").count();
  expect(sourceCount).toBeGreaterThanOrEqual(5);
  await page.screenshot({ path: "e2e/screenshots/demo/overview-auto-open-sources.png", fullPage: false });

  // Clicking elsewhere does not close the Overview; only the trigger/Escape do.
  await page.getByTestId("chat-header-title").click();
  await expect(page.getByTestId("thread-overview-body")).toBeVisible();

  // Narrow viewport: the Overview steps aside (does not auto-open).
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.getByTestId("thread-overview-body")).toHaveCount(0);
  await page.screenshot({ path: "e2e/screenshots/demo/overview-narrow-closed.png", fullPage: false });

  // Opened by hand on a small view, it floats over the chat (no reserved space).
  await page.getByTestId("header-workspace-menu").click();
  await expect(page.getByTestId("thread-overview-body")).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/demo/overview-narrow-floating.png", fullPage: false });
});
