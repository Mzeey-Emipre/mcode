import { test, expect } from "@playwright/test";
import type { Thread } from "@mcode/contracts";
import {
  mockWebSocketServer,
  interceptZustandStores,
  seedActiveThread,
} from "./helpers/e2e-helpers";
import { getDefaultSettings } from "@mcode/contracts";

/** 1×1 PNG so `<img>` loads; otherwise thumbnails use the inert error fallback in E2E (no real HTTP server on the WS port). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const E2E_WS_FOR_ATTACHMENTS = "ws://localhost:19400";

const MOCK_SETTINGS = getDefaultSettings();
const THREAD_ID = "thread-e2e-attachment-lightbox";

const FAKE_WORKSPACE = {
  id: "ws-attachment-lb",
  name: "Attachment Lightbox",
  path: "/tmp/attachment-lb",
  provider_config: {},
  is_git_repo: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  pinned: false,
  last_opened_at: null,
  sort_order: 0,
};

const FAKE_THREAD: Thread = {
  id: THREAD_ID,
  workspace_id: "ws-attachment-lb",
  title: "Images",
  status: "active" as const,
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

function makeMessageWithImages() {
  return {
    id: "msg-user-images",
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
      { id: "att-png", name: "shot.png", mimeType: "image/png", sizeBytes: 120 },
      { id: "att-jpg", name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 240 },
    ],
  };
}

/**
 * Activate a thread and inject messages after `loadMessages` finishes, via the
 * shared {@link seedActiveThread} helper.
 */
async function activateThreadAndInjectMessages(
  page: import("@playwright/test").Page,
  messages: ReturnType<typeof makeMessageWithImages>[],
): Promise<void> {
  await seedActiveThread(page, FAKE_WORKSPACE, FAKE_THREAD, messages);
}

test.describe("Image attachment lightbox", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
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

    await mockWebSocketServer(page, { "settings.get": MOCK_SETTINGS });
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
    }, E2E_WS_FOR_ATTACHMENTS);
  });

  test("opens carousel lightbox from transcript thumbnails", async ({ page }) => {
    await activateThreadAndInjectMessages(page, [makeMessageWithImages()]);

    await page.getByRole("button", { name: "Preview image shot.png" }).click();

    const stage = page.getByTestId("image-attachment-lightbox");
    await expect(stage).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Next image" })).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("button", { name: "Previous image" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(stage).toBeHidden();
  });
});
