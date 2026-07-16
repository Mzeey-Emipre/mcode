import {
  PULL_REQUEST_PATCH_MAX_LINES,
  type PullRequestFilesRequest,
  type PullRequestGetRequest,
  type PullRequestListRequest,
  type PullRequestPatchRequest,
  type PullRequestTimelineRequest,
} from "@mcode/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { assessPullRequestLayoutOffsets } from "../src/lib/pull-request-performance-metrics";
import {
  mockWebSocketServer,
  type RpcOverrides,
} from "./helpers/e2e-helpers";
import {
  PERFORMANCE_PULL_REQUEST_CAPABILITIES,
  capturePullRequestInteractionMetrics,
  makePerformanceDetail,
  makePerformanceFiles,
  makePerformanceFilesPage,
  makePerformanceGetResult,
  makePerformanceListPage,
  makePerformancePatch,
  makePerformancePatchResult,
  makePerformanceSummaries,
  makePerformanceTimeline,
  makePerformanceTimelinePage,
} from "./helpers/pull-request-performance-fixtures";

const INBOX_RECORDS = 1_000;
const TIMELINE_RECORDS = 1_000;
const FILE_RECORDS = 500;
const INBOX_PAGE_COUNT = Math.ceil(INBOX_RECORDS / 30);
const TIMELINE_PAGE_COUNT = Math.ceil(TIMELINE_RECORDS / 30);
const FILE_PAGE_COUNT = Math.ceil(FILE_RECORDS / 100);
const REMOTE_MUTATION_METHODS = [
  "pullRequest.postComment",
  "pullRequest.submitReview",
  "pullRequest.setReadiness",
  "pullRequest.close",
  "pullRequest.merge",
] as const;

interface RpcLog {
  calls: Map<string, unknown[]>;
  record: (method: string, params?: unknown) => void;
  count: (method: string) => number;
}

function createRpcLog(): RpcLog {
  const calls = new Map<string, unknown[]>();
  return {
    calls,
    record(method, params) {
      const entries = calls.get(method) ?? [];
      entries.push(params);
      calls.set(method, entries);
    },
    count(method) {
      return calls.get(method)?.length ?? 0;
    },
  };
}

function tracked<T>(
  log: RpcLog,
  method: string,
  handler: (params: unknown) => T | Promise<T>,
): (params?: unknown) => T | Promise<T> {
  return (params) => {
    log.record(method, params);
    return handler(params);
  };
}

function mutationGuards(log: RpcLog): RpcOverrides {
  return Object.fromEntries(
    REMOTE_MUTATION_METHODS.map((method) => [
      method,
      tracked(log, method, () => {
        throw new Error(`Remote mutation was not expected in performance verification: ${method}`);
      }),
    ]),
  );
}

async function openPullRequestSurface(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Pull requests" }).click();
  await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
}

async function scrollToEnd(viewport: Locator, extent = 1): Promise<void> {
  await viewport.evaluate((element, targetExtent) => {
    element.scrollTop = element.scrollHeight * targetExtent;
  }, extent);
}

function expectNoRemoteMutations(log: RpcLog): void {
  for (const method of REMOTE_MUTATION_METHODS) {
    expect(log.count(method), method).toBe(0);
  }
}

function expectBoundedInteraction(
  metrics: Awaited<ReturnType<typeof capturePullRequestInteractionMetrics>>,
  context: Record<string, unknown> = {},
): void {
  const layoutGate = assessPullRequestLayoutOffsets(metrics.slowLayoutOffsetsMs);
  expect(
    layoutGate.passed,
    JSON.stringify({
      ...context,
      ...metrics,
      layoutGate,
      rule: "at most two >1 ms layouts, with no repeated pair inside 16.7 ms",
    }),
  ).toBe(true);
  expect(metrics.longTaskDurationsMs).toEqual([]);
}

test.describe("pull request bounded performance gates", () => {
  test.skip(
    process.env.PULL_REQUEST_PERFORMANCE_E2E !== "1",
    "Run the production performance gate with `bun run perf:pull-requests`.",
  );
  test.describe.configure({ mode: "serial", timeout: 120_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps a legally paged 1,000-item inbox virtual and free of RPC fan-out", async ({
    page,
  }) => {
    const log = createRpcLog();
    const summaries = makePerformanceSummaries(INBOX_RECORDS);
    const detail = makePerformanceDetail();
    await mockWebSocketServer(page, {
      "pullRequest.capabilities": tracked(log, "pullRequest.capabilities", () =>
        PERFORMANCE_PULL_REQUEST_CAPABILITIES),
      "pullRequest.list": tracked(log, "pullRequest.list", (params) =>
        makePerformanceListPage(summaries, params as PullRequestListRequest)),
      "pullRequest.get": tracked(log, "pullRequest.get", (params) =>
        makePerformanceGetResult(params as PullRequestGetRequest, detail)),
      "pullRequest.timeline": tracked(log, "pullRequest.timeline", () => ({
        ok: true,
        lane: "initial",
        items: [],
        olderCursor: null,
        newerCursor: null,
        hasMoreOlder: false,
        hasMoreNewer: false,
        snapshotVersion: "timeline:empty",
        fetchedAt: "2026-07-11T12:00:00.000Z",
        staleAt: "2099-07-11T12:00:00.000Z",
        boundedData: null,
      })),
      "pullRequest.cancel": { ok: true, cancelled: false },
      ...mutationGuards(log),
    });

    await openPullRequestSurface(page);
    await expect.poll(() => log.count("pullRequest.list")).toBe(1);
    for (let pageNumber = 2; pageNumber <= INBOX_PAGE_COUNT; pageNumber += 1) {
      const loadMore = page.getByRole("button", { name: "Load more" });
      await expect(loadMore).toBeEnabled();
      await loadMore.click();
      await expect.poll(() => log.count("pullRequest.list")).toBe(pageNumber);
    }
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

    const listbox = page.getByRole("listbox", { name: "Pull requests" });
    const listContent = page.getByTestId("pull-request-list-content");
    const mountedOptions = listbox.getByRole("option");
    await expect(mountedOptions.first()).toHaveAttribute("aria-setsize", "1000");
    expect(await mountedOptions.count()).toBeLessThan(50);
    expect(await listContent.locator("*").count()).toBeLessThan(500);

    const metrics = await capturePullRequestInteractionMetrics(page, () =>
      scrollToEnd(listbox),
    );
    expectBoundedInteraction(metrics);
    expect(log.count("pullRequest.capabilities")).toBe(1);
    expect(log.count("pullRequest.list")).toBe(INBOX_PAGE_COUNT);
    expectNoRemoteMutations(log);
  });

  test("keeps 1,000 paged Timeline events virtual with one RPC per page", async ({
    page,
  }) => {
    const log = createRpcLog();
    const summaries = makePerformanceSummaries(1);
    const detail = makePerformanceDetail();
    const timeline = makePerformanceTimeline(TIMELINE_RECORDS);
    await mockWebSocketServer(page, {
      "pullRequest.capabilities": tracked(log, "pullRequest.capabilities", () =>
        PERFORMANCE_PULL_REQUEST_CAPABILITIES),
      "pullRequest.list": tracked(log, "pullRequest.list", (params) =>
        makePerformanceListPage(summaries, params as PullRequestListRequest)),
      "pullRequest.get": tracked(log, "pullRequest.get", (params) =>
        makePerformanceGetResult(params as PullRequestGetRequest, detail)),
      "pullRequest.timeline": tracked(log, "pullRequest.timeline", (params) =>
        makePerformanceTimelinePage(timeline, params as PullRequestTimelineRequest)),
      "pullRequest.cancel": { ok: true, cancelled: false },
      ...mutationGuards(log),
    });

    await openPullRequestSurface(page);
    await page
      .getByRole("option", { name: /Performance change stack 1/ })
      .click();
    await expect(page.getByRole("heading", { name: "Performance change stack 1" })).toBeVisible();
    await page.getByRole("tab", { name: "Timeline" }).click();
    await expect.poll(() => log.count("pullRequest.timeline")).toBe(1);
    for (let pageNumber = 2; pageNumber <= TIMELINE_PAGE_COUNT; pageNumber += 1) {
      const loadOlder = page.getByRole("button", { name: "Load older activity" });
      await expect(loadOlder).toBeEnabled();
      await loadOlder.click();
      await expect.poll(() => log.count("pullRequest.timeline")).toBe(pageNumber);
    }
    await expect(page.getByRole("button", { name: "Load older activity" })).toHaveCount(0);

    const timelineRegion = page.locator('section[aria-label="Pull request Timeline"]');
    const timelineList = timelineRegion.getByRole("list", { name: "Pull request timeline" });
    const timelineViewport = timelineRegion.getByLabel("Pull request Timeline viewport");
    const mountedEvents = timelineList.locator("li");
    await expect(mountedEvents.first()).toHaveAttribute("aria-setsize", "1000");
    await expect(mountedEvents.first().locator("time")).toHaveAttribute("datetime");
    const measuredTimelineRowHeight = await mountedEvents.first().evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(await mountedEvents.count()).toBeLessThan(50);
    expect(await timelineRegion.locator("*").count()).toBeLessThan(500);

    const metrics = await capturePullRequestInteractionMetrics(page, () =>
      scrollToEnd(timelineViewport),
    );
    expectBoundedInteraction(metrics, { measuredTimelineRowHeight });
    expect(log.count("pullRequest.list")).toBe(1);
    expect(log.count("pullRequest.timeline")).toBe(TIMELINE_PAGE_COUNT);
    expect(log.count("pullRequest.get")).toBeLessThanOrEqual(3);
    expectNoRemoteMutations(log);
  });

  test("keeps 500 files and a 20,000-line patch virtual without N+1 reads", async ({
    page,
  }) => {
    const log = createRpcLog();
    const summaries = makePerformanceSummaries(1);
    const detail = makePerformanceDetail(FILE_RECORDS);
    const files = makePerformanceFiles(FILE_RECORDS);
    const patch = makePerformancePatch();
    await mockWebSocketServer(page, {
      "pullRequest.capabilities": tracked(log, "pullRequest.capabilities", () =>
        PERFORMANCE_PULL_REQUEST_CAPABILITIES),
      "pullRequest.list": tracked(log, "pullRequest.list", (params) =>
        makePerformanceListPage(summaries, params as PullRequestListRequest)),
      "pullRequest.get": tracked(log, "pullRequest.get", (params) =>
        makePerformanceGetResult(params as PullRequestGetRequest, detail)),
      "pullRequest.files": tracked(log, "pullRequest.files", (params) =>
        makePerformanceFilesPage(files, params as PullRequestFilesRequest)),
      "pullRequest.patch": tracked(log, "pullRequest.patch", (params) => {
        const request = params as PullRequestPatchRequest;
        const file = files.find((item) => item.locator === request.locator);
        if (!file) throw new Error(`Unknown patch locator: ${request.locator}`);
        return makePerformancePatchResult(file, patch);
      }),
      "pullRequest.cancel": { ok: true, cancelled: false },
      ...mutationGuards(log),
    });

    await openPullRequestSurface(page);
    await page
      .getByRole("option", { name: /Performance change stack 1/ })
      .click();
    await expect(page.getByRole("heading", { name: "Performance change stack 1" })).toBeVisible();
    await page.getByRole("tab", { name: "Code" }).click();
    await expect.poll(() => log.count("pullRequest.files")).toBe(1);
    await expect.poll(() => log.count("pullRequest.patch")).toBe(1);
    for (let pageNumber = 2; pageNumber <= FILE_PAGE_COUNT; pageNumber += 1) {
      const loadMoreFiles = page.getByRole("button", { name: "Load more files" });
      await expect(loadMoreFiles).toBeEnabled();
      await loadMoreFiles.click();
      await expect.poll(() => log.count("pullRequest.files")).toBe(pageNumber);
    }
    await expect(page.getByRole("button", { name: "Load more files" })).toHaveCount(0);

    const codeRoot = page.getByTestId("pull-request-code-root");
    const fileTree = page.getByRole("tree", { name: "Pull request changed files" });
    const diffViewport = page.getByLabel("Pull request diff viewport");
    const diffGrid = page.getByRole("grid", { name: "Pull request diff" });
    await expect(diffGrid).toHaveAttribute(
      "aria-rowcount",
      String(PULL_REQUEST_PATCH_MAX_LINES + FILE_RECORDS),
    );
    const mountedFiles = fileTree.getByRole("treeitem");
    const mountedDiffRows = diffGrid.getByRole("row");
    expect(await mountedFiles.count()).toBeLessThan(50);
    expect(await mountedDiffRows.count()).toBeLessThan(50);
    expect(await codeRoot.locator("*").count()).toBeLessThan(500);
    await expect(
      fileTree.getByRole("treeitem", { name: /file-0000\.ts/ }),
    ).toHaveAttribute("aria-setsize", "500");
    await expect(fileTree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    await expect(diffGrid.locator('[tabindex="0"]')).toHaveCount(1);

    const fileTreeMetrics = await capturePullRequestInteractionMetrics(page, () =>
      scrollToEnd(fileTree),
    );
    const diffMetrics = await capturePullRequestInteractionMetrics(page, () =>
      scrollToEnd(diffViewport, 0.5),
    );
    expectBoundedInteraction(fileTreeMetrics);
    expectBoundedInteraction(diffMetrics);
    expect(log.count("pullRequest.list")).toBe(1);
    expect(log.count("pullRequest.files")).toBe(FILE_PAGE_COUNT);
    expect(log.count("pullRequest.patch")).toBe(1);
    expectNoRemoteMutations(log);
  });
});
