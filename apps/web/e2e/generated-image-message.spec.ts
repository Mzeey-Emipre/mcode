import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

const WS_ID = "ws-generated-image";
const THREAD_ID = "thread-generated-image";
const ATTACHMENT_WS_URL = "ws://localhost:19400";
const now = new Date().toISOString();

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const workspace = {
  id: WS_ID,
  name: "Generated Image",
  path: "/test/generated-image",
  provider_config: {},
  is_git_repo: true,
  created_at: now,
  updated_at: now,
  pinned: false,
  last_opened_at: Date.now(),
  sort_order: 0,
};

const thread = {
  id: THREAD_ID,
  workspace_id: WS_ID,
  title: "Generated image result",
  status: "paused" as const,
  mode: "direct" as const,
  worktree_path: null,
  branch: "main",
  worktree_managed: false,
  issue_number: null,
  pr_number: null,
  pr_status: null,
  sdk_session_id: null,
  created_at: now,
  updated_at: now,
  model: "gpt-5.1-codex",
  provider: "codex",
  deleted_at: null,
  last_context_tokens: null,
  context_window: null,
  reasoning_level: null,
  interaction_mode: null,
  permission_mode: null,
  parent_thread_id: null,
  forked_from_message_id: null,
};

const generatedImageMessage = {
  id: "msg-generated-image",
  thread_id: THREAD_ID,
  role: "assistant" as const,
  content: "",
  sequence: 1,
  tool_calls: null,
  files_changed: null,
  cost_usd: null,
  tokens_used: null,
  timestamp: now,
  model: "gpt-5.1-codex",
  attachments: [
    {
      id: "generated-image-1",
      name: "generated-image.png",
      mimeType: "image/png",
      sizeBytes: TINY_PNG.length,
    },
  ],
};

async function setupGeneratedImageThread(page: Page): Promise<void> {
  await page.addInitScript(
    ({ workspaceId, wsUrl }) => {
      localStorage.setItem(
        "mcode-expanded-projects",
        JSON.stringify({ [workspaceId]: true }),
      );
      (
        window as unknown as { __mcodeE2EAttachmentTransportWsUrl?: string }
      ).__mcodeE2EAttachmentTransportWsUrl = wsUrl;
    },
    { workspaceId: WS_ID, wsUrl: ATTACHMENT_WS_URL },
  );

  await page.route(
    /http:\/\/(localhost|127\.0\.0\.1):\d{5}\/attachments\/.+/,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: TINY_PNG,
      });
    },
  );

  const emptyNarrative = { tools: [], thoughts: [], hooks: [] };
  await mockWebSocketServer(page, {
    "workspace.list": [workspace],
    "workspace.enrich": { items: [] },
    "workspace.touchLastOpened": null,
    "thread.list": [thread],
    "message.list": {
      messages: [generatedImageMessage],
      hasMore: false,
      answeredPlanMessageIds: [],
    },
    "narrative.list": emptyNarrative,
    "narrative.listBatch": emptyNarrative,
    "settings.get": getDefaultSettings(),
  });
}

test.describe("Generated assistant images", () => {
  test("renders generated image attachments and opens the lightbox", async ({ page }) => {
    await setupGeneratedImageThread(page);
    await page.goto("/");
    await page.waitForSelector("[data-testid='thread-item']");
    await page.locator("[data-testid='thread-item']").first().click();

    const thumbnail = page.getByRole("button", {
      name: "Preview image generated-image.png",
    });
    await expect(thumbnail).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: "e2e/screenshots/generated-image-assistant-thumbnail.png",
      fullPage: false,
    });

    await thumbnail.click();
    await expect(page.getByTestId("image-attachment-lightbox")).toBeVisible();
    await page.screenshot({
      path: "e2e/screenshots/generated-image-assistant-lightbox.png",
      fullPage: false,
    });
  });
});
