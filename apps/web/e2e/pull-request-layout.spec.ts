import type {
  PullRequestGetRequest,
  PullRequestListRequest,
} from "@mcode/contracts";
import { expect, test } from "@playwright/test";
import { mockWebSocketServer } from "./helpers/e2e-helpers";
import {
  makePerformanceDetail,
  makePerformanceGetResult,
  makePerformanceListPage,
  makePerformanceSummaries,
  PERFORMANCE_PULL_REQUEST_CAPABILITIES,
} from "./helpers/pull-request-performance-fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

test("keeps pull request rows centered and the scrollbar on the pane edge", async ({
  page,
}) => {
  const summaries = makePerformanceSummaries(20);
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
  const listContent = page.getByTestId("pull-request-list-content");
  const scrollbar = page.locator('[data-slot="scroll-area-scrollbar"]');
  await expect(listbox).toBeVisible();
  await expect(scrollbar).toBeVisible();

  const paneBox = await pane.boundingBox();
  const headerBox = await header.boundingBox();
  const listContentBox = await listContent.boundingBox();
  const scrollbarBox = await scrollbar.boundingBox();
  expect(paneBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(listContentBox).not.toBeNull();
  expect(scrollbarBox).not.toBeNull();

  for (const contentBox of [headerBox, listContentBox]) {
    if (!paneBox || !contentBox) continue;
    const leftGutter = contentBox.x - paneBox.x;
    const rightGutter =
      paneBox.x + paneBox.width - (contentBox.x + contentBox.width);
    expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(1);
  }

  if (paneBox && scrollbarBox) {
    const scrollbarInset =
      paneBox.x + paneBox.width - (scrollbarBox.x + scrollbarBox.width);
    expect(Math.abs(scrollbarInset)).toBeLessThanOrEqual(1);
  }
});

test("reveals each selected pull request and respects reduced motion", async ({
  page,
}) => {
  const summaries = makePerformanceSummaries(2);
  const baseDetail = makePerformanceDetail();
  await mockWebSocketServer(page, {
    "pullRequest.capabilities": PERFORMANCE_PULL_REQUEST_CAPABILITIES,
    "pullRequest.list": (request) =>
      makePerformanceListPage(summaries, request as PullRequestListRequest),
    "pullRequest.get": (request) => {
      const typedRequest = request as PullRequestGetRequest;
      const selected = summaries.find(
        (summary) => summary.identity.number === typedRequest.identity.number,
      );
      return makePerformanceGetResult(typedRequest, {
        ...baseDetail,
        identity: selected?.identity ?? baseDetail.identity,
        url: selected?.url ?? baseDetail.url,
        title: selected?.title ?? baseDetail.title,
        author: selected?.author ?? baseDetail.author,
        head: selected?.head ?? baseDetail.head,
        base: selected?.base ?? baseDetail.base,
      });
    },
    "pullRequest.cancel": { ok: true, cancelled: false },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Pull requests" }).click();
  await page.evaluate(() => {
    const state = window as typeof window & {
      __pullRequestDetailAnimationStarts?: number;
    };
    state.__pullRequestDetailAnimationStarts = 0;
    document.addEventListener("animationstart", (event) => {
      if (event.animationName === "pull-request-detail-enter") {
        state.__pullRequestDetailAnimationStarts =
          (state.__pullRequestDetailAnimationStarts ?? 0) + 1;
      }
    });
  });

  const options = page.getByRole("option");
  await options.nth(0).click();
  const reveal = page.getByTestId("pull-request-detail-reveal");
  await expect(reveal).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __pullRequestDetailAnimationStarts?: number;
            }
          ).__pullRequestDetailAnimationStarts ?? 0,
      ),
    )
    .toBe(1);

  await options.nth(1).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __pullRequestDetailAnimationStarts?: number;
            }
          ).__pullRequestDetailAnimationStarts ?? 0,
      ),
    )
    .toBe(2);

  await page.getByRole("button", { name: "Close pull request detail" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await options.nth(0).click();
  await expect(reveal).toBeVisible();
  await expect
    .poll(() =>
      reveal.evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe("none");
});
