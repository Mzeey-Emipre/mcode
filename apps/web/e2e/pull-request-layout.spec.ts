import type { PullRequestListRequest } from "@mcode/contracts";
import { expect, test } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import {
  makePerformanceListPage,
  makePerformanceSummaries,
  PERFORMANCE_PULL_REQUEST_CAPABILITIES,
} from "./helpers/pull-request-performance-fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

test("centers the pull request inbox column in the available pane", async ({
  page,
}) => {
  const summaries = makePerformanceSummaries(1);
  await mockWebSocketServer(page, {
    "pullRequest.capabilities": PERFORMANCE_PULL_REQUEST_CAPABILITIES,
    "pullRequest.list": (request) =>
      makePerformanceListPage(summaries, request as PullRequestListRequest),
    "pullRequest.cancel": { ok: true, cancelled: false },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Pull requests" }).click();

  const pane = page.getByTestId("pull-request-inbox-pane");
  const heading = page.getByRole("heading", { name: "Pull requests" });
  const header = heading.locator("..");
  const listbox = page.getByRole("listbox", { name: "Pull requests" });
  await expect(listbox).toBeVisible();

  const paneBox = await pane.boundingBox();
  const headerBox = await header.boundingBox();
  const listboxBox = await listbox.boundingBox();
  expect(paneBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(listboxBox).not.toBeNull();

  for (const contentBox of [headerBox, listboxBox]) {
    if (!paneBox || !contentBox) continue;
    const leftGutter = contentBox.x - paneBox.x;
    const rightGutter =
      paneBox.x + paneBox.width - (contentBox.x + contentBox.width);
    expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(1);
  }
});
