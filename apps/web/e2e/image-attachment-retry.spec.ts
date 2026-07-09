import { expect, test, type Page } from "@playwright/test";
import { getDefaultSettings, type Thread } from "@mcode/contracts";
import {
  interceptZustandStores,
  mockWebSocketServer,
  seedActiveThread,
} from "./helpers/e2e-helpers";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const THREAD_ID = "thread-e2e-attachment-retry";
const ATTACHMENT_WS_URL = "ws://localhost:19400";

const WORKSPACE = {
  id: "ws-attachment-retry",
  name: "Attachment Retry",
  path: "/tmp/attachment-retry",
  provider_config: {},
  is_git_repo: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
};

const THREAD: Thread = {
  id: THREAD_ID,
  workspace_id: "ws-attachment-retry",
  title: "Retry image",
  status: "active",
  mode: "direct",
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

function makeImageMessage() {
  return {
    id: "msg-user-image-retry",
    thread_id: THREAD_ID,
    role: "user" as const,
    content: "",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: new Date().toISOString(),
    sequence: 1,
    attachments: [
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        name: "fresh-shot.png",
        mimeType: "image/png",
        sizeBytes: TINY_PNG.length,
      },
    ],
  };
}

async function openSeededThread(page: Page): Promise<void> {
  await mockWebSocketServer(page, { "settings.get": getDefaultSettings() });
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
  }, ATTACHMENT_WS_URL);
  await seedActiveThread(page, WORKSPACE, THREAD, [makeImageMessage()]);
}

test.describe("Image attachment retry", () => {
  test("keeps a fresh transcript image mounted when the first attachment request 404s", async ({
    page,
  }) => {
    let requestCount = 0;
    await page.route(
      /http:\/\/(localhost|127\.0\.0\.1):\d{5}\/attachments\/.+/,
      async (route) => {
        requestCount += 1;
        const retry = new URL(route.request().url()).searchParams.get("mcodeRetry");
        if (!retry) {
          await route.fulfill({ status: 404, body: "Not found" });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: TINY_PNG,
        });
      },
    );

    await openSeededThread(page);

    const thumbnail = page.getByRole("button", { name: "Preview image fresh-shot.png" });
    await expect(thumbnail).toBeVisible({ timeout: 10_000 });
    await expect(thumbnail.locator("img")).toHaveAttribute("src", /mcodeRetry=1/, {
      timeout: 10_000,
    });
    expect(requestCount).toBeGreaterThanOrEqual(2);

    await page.screenshot({
      path: "e2e/screenshots/image-attachment-retry.png",
      fullPage: false,
    });
  });
});
