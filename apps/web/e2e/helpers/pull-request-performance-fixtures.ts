import {
  PULL_REQUEST_PATCH_MAX_LINES,
  type PullRequestCapabilitiesResult,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestFilesRequest,
  type PullRequestFilesResult,
  type PullRequestGetRequest,
  type PullRequestGetResult,
  type PullRequestIdentity,
  type PullRequestListRequest,
  type PullRequestListResult,
  type PullRequestPatchResult,
  type PullRequestSummary,
  type PullRequestTimelineItem,
  type PullRequestTimelineRequest,
  type PullRequestTimelineResult,
} from "@mcode/contracts";
import type { Page } from "@playwright/test";

const FIXTURE_TIME = "2026-07-11T12:00:00.000Z";
const FIXTURE_STALE_AT = "2099-07-11T12:00:00.000Z";
const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);

/** Pull request identity shared by the performance fixtures. */
export const PERFORMANCE_PULL_REQUEST_IDENTITY: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "REPO_PERFORMANCE",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 468,
};

/** Read and mutation capabilities exposed by the fake GitHub viewer. */
export const PERFORMANCE_PULL_REQUEST_CAPABILITIES: PullRequestCapabilitiesResult = {
  ok: true,
  viewer: {
    providerNodeId: "VIEWER_PERFORMANCE",
    login: "performance-reviewer",
    avatarUrl: null,
    profileUrl: null,
  },
  capabilities: {
    read: { allowed: true },
    teamRequests: { allowed: true },
    comment: { allowed: true },
    review: { allowed: true },
    readiness: { allowed: true },
    close: { allowed: true },
    merge: { allowed: true },
    reviewWorktree: { allowed: true },
  },
  fetchedAt: FIXTURE_TIME,
  staleAt: FIXTURE_STALE_AT,
};

/** Build contract-valid pull request summaries for a paged inbox fixture. */
export function makePerformanceSummaries(count: number): PullRequestSummary[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      identity: {
        ...PERFORMANCE_PULL_REQUEST_IDENTITY,
        number,
      },
      url: `https://github.com/Mzeey-Empire/mcode/pull/${number}`,
      title: `Performance change stack ${number}`,
      author: {
        providerNodeId: `ACTOR_${number}`,
        login: `reviewer-${number % 17}`,
        avatarUrl: null,
        profileUrl: null,
      },
      state: "open",
      readiness: number % 5 === 0 ? "draft" : "ready",
      head: {
        owner: "Mzeey-Empire",
        repository: "mcode",
        name: `perf/change-${number}`,
        oid: HEAD_OID,
      },
      base: {
        owner: "Mzeey-Empire",
        repository: "mcode",
        name: "main",
        oid: BASE_OID,
      },
      relationships: ["authored"],
      checks: { state: number % 7 === 0 ? "pending" : "passing" },
      commentCount: number % 9,
      additions: number,
      deletions: number % 13,
      updatedAt: FIXTURE_TIME,
    };
  });
}

/** Return the selected pull request detail used by Timeline and Code tests. */
export function makePerformanceDetail(changedFiles = 500): PullRequestDetail {
  const summary = makePerformanceSummaries(1)[0];
  if (!summary) throw new Error("The performance summary fixture is missing");
  return {
    identity: summary.identity,
    providerNodeId: "PR_PERFORMANCE",
    url: summary.url,
    title: summary.title,
    body: "A bounded fake pull request used to measure large review surfaces.",
    author: summary.author,
    state: "open",
    readiness: "ready",
    head: summary.head,
    base: summary.base,
    additions: PULL_REQUEST_PATCH_MAX_LINES - 1,
    deletions: 0,
    changedFiles,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    mergeability: "mergeable",
    mergeMethods: ["merge", "squash"],
    defaultMergeMethod: "squash",
    reviewDecision: "review_required",
    reviewers: [],
    checks: { state: "passing" },
    checkCount: 0,
    commentCount: 0,
    reviewThreadCount: 0,
  };
}

/** Build chronologically ordered, contract-valid Timeline events. */
export function makePerformanceTimeline(count: number): PullRequestTimelineItem[] {
  const start = Date.parse("2026-07-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    kind: "commit" as const,
    providerNodeId: `TIMELINE_${index.toString().padStart(4, "0")}`,
    occurredAt: new Date(start + index * 1_000).toISOString(),
    actor: {
      providerNodeId: "ACTOR_PERFORMANCE",
      login: "performance-author",
      avatarUrl: null,
      profileUrl: null,
    },
    url: `https://github.com/Mzeey-Empire/mcode/pull/468#event-${index}`,
    oid: index.toString(16).padStart(40, "0"),
    messageHeadline: `Bounded Timeline event ${index}`,
  }));
}

/** Build changed-file records that share one shallow directory tree. */
export function makePerformanceFiles(count: number): PullRequestFile[] {
  return Array.from({ length: count }, (_, index) => ({
    locator: `FILE_${index.toString().padStart(4, "0")}`,
    path: `src/performance/file-${index.toString().padStart(4, "0")}.ts`,
    previousPath: null,
    changeType: "modified" as const,
    additions: index === 0 ? PULL_REQUEST_PATCH_MAX_LINES - 1 : 1,
    deletions: 0,
    changes: index === 0 ? PULL_REQUEST_PATCH_MAX_LINES - 1 : 1,
    blobOid: (index + 1).toString(16).padStart(40, "0"),
    patchStatus: "available" as const,
  }));
}

/** Build the maximum legal parsed patch: one hunk header and 19,999 lines. */
export function makePerformancePatch(): string {
  return [
    `@@ -0,0 +1,${PULL_REQUEST_PATCH_MAX_LINES - 1} @@`,
    ...Array.from(
      { length: PULL_REQUEST_PATCH_MAX_LINES - 1 },
      (_, index) => `+value ${index}`,
    ),
  ].join("\n");
}

/** Return one legal inbox page using the request's bounded page size. */
export function makePerformanceListPage(
  items: PullRequestSummary[],
  request: PullRequestListRequest,
): PullRequestListResult {
  const offset = request.cursor
    ? Number.parseInt(request.cursor.replace("inbox:", ""), 10)
    : 0;
  const page = items.slice(offset, offset + request.limit);
  const nextOffset = offset + page.length;
  return {
    ok: true,
    items: page,
    nextCursor: nextOffset < items.length ? `inbox:${nextOffset}` : null,
    snapshotVersion: `inbox:${items.length}`,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    limitations: [],
  };
}

/** Return one legal Timeline page for the initial or older lane. */
export function makePerformanceTimelinePage(
  items: PullRequestTimelineItem[],
  request: PullRequestTimelineRequest,
): PullRequestTimelineResult {
  const pageEnd =
    request.lane === "initial"
      ? items.length
      : Number.parseInt(request.cursor.replace("timeline:", ""), 10);
  const pageStart = Math.max(0, pageEnd - request.limit);
  return {
    ok: true,
    lane: request.lane,
    items: items.slice(pageStart, pageEnd),
    olderCursor: pageStart > 0 ? `timeline:${pageStart}` : null,
    newerCursor: `timeline:${items.length}`,
    hasMoreOlder: pageStart > 0,
    hasMoreNewer: false,
    snapshotVersion: `timeline:${items.length}`,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    boundedData: null,
  };
}

/** Return one legal changed-file page using the request's bounded page size. */
export function makePerformanceFilesPage(
  items: PullRequestFile[],
  request: PullRequestFilesRequest,
): PullRequestFilesResult {
  const offset = request.cursor
    ? Number.parseInt(request.cursor.replace("files:", ""), 10)
    : 0;
  const page = items.slice(offset, offset + request.limit);
  const nextOffset = offset + page.length;
  return {
    ok: true,
    items: page,
    nextCursor: nextOffset < items.length ? `files:${nextOffset}` : null,
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    snapshotVersion: `files:${items.length}`,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    boundedData: null,
  };
}

/** Return the detail, checks, or comments fixture selected by the request. */
export function makePerformanceGetResult(
  request: PullRequestGetRequest,
  detail = makePerformanceDetail(),
): PullRequestGetResult {
  const freshness = {
    snapshotVersion: `detail:${BASE_OID}:${HEAD_OID}`,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    boundedData: null,
  } as const;
  if (request.resource === "detail") {
    return { ok: true, resource: "detail", item: detail, ...freshness };
  }
  return {
    ok: true,
    resource: request.resource,
    items: [],
    nextCursor: null,
    ...freshness,
  };
}

/** Return the maximum patch result for the first changed file. */
export function makePerformancePatchResult(
  file: PullRequestFile,
  patch: string,
): PullRequestPatchResult {
  return {
    ok: true,
    locator: file.locator,
    path: file.path,
    previousPath: file.previousPath,
    changeType: file.changeType,
    blobOid: file.blobOid,
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    status: "available",
    patch,
    parsedLineCount: PULL_REQUEST_PATCH_MAX_LINES,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
  };
}

interface TraceEvent {
  name: string;
  ph?: string;
  pid: number;
  tid: number;
  ts?: number;
  dur?: number;
  args?: Record<string, unknown> & { name?: string };
}

/** Measured main-thread work for one bounded browser interaction. */
export interface PullRequestInteractionMetrics {
  slowLayoutDurationsMs: number[];
  slowLayoutOffsetsMs: number[];
  longTaskDurationsMs: number[];
}

/** Capture Chromium layout and long-task timings around one browser interaction. */
export async function capturePullRequestInteractionMetrics(
  page: Page,
  action: () => Promise<void>,
): Promise<PullRequestInteractionMetrics> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () => new Promise<void>((resolve) => {
      let remainingFrames = 10;
      const settle = (): void => {
        remainingFrames -= 1;
        if (remainingFrames === 0) {
          resolve();
          return;
        }
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    }),
  );
  await page.evaluate(() => {
    const target = window as unknown as {
      __pullRequestLongTasks?: number[];
      __pullRequestLongTaskObserver?: PerformanceObserver;
    };
    target.__pullRequestLongTasks = [];
    if (!("PerformanceObserver" in window)) return;
    const supported = PerformanceObserver.supportedEntryTypes.includes("longtask");
    if (!supported) return;
    const observer = new PerformanceObserver((list) => {
      target.__pullRequestLongTasks?.push(
        ...list.getEntries().map((entry) => entry.duration),
      );
    });
    observer.observe({ entryTypes: ["longtask"] });
    target.__pullRequestLongTaskObserver = observer;
  });

  const session = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  session.on(
    "Tracing.dataCollected",
    (payload: { value: TraceEvent[] }) => events.push(...payload.value),
  );
  const tracingComplete = new Promise<void>((resolve) => {
    session.once("Tracing.tracingComplete", () => resolve());
  });
  await session.send("Tracing.start", {
    categories: "devtools.timeline,toplevel,blink.user_timing",
    options: "record-until-full",
  });
  try {
    await page.evaluate(() => {
      const target = window as unknown as { __pullRequestLongTasks?: number[] };
      target.__pullRequestLongTasks = [];
    });
    await action();
    await page.evaluate(
      () => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    );
  } finally {
    await session.send("Tracing.end");
    await tracingComplete;
    await session.detach();
  }

  const observedLongTasks = await page.evaluate(() => {
    const target = window as unknown as {
      __pullRequestLongTasks?: number[];
      __pullRequestLongTaskObserver?: PerformanceObserver;
    };
    target.__pullRequestLongTaskObserver?.disconnect();
    return target.__pullRequestLongTasks ?? [];
  });
  const rendererThreads = new Set(
    events
      .filter(
        (event) =>
          event.ph === "M" &&
          event.name === "thread_name" &&
          event.args?.name === "CrRendererMain",
      )
      .map((event) => `${event.pid}:${event.tid}`),
  );
  const onRendererMain = (event: TraceEvent): boolean =>
    rendererThreads.size === 0 || rendererThreads.has(`${event.pid}:${event.tid}`);
  const slowLayoutEvents = events
    .filter(
      (event) =>
        event.ph === "X" &&
        event.name === "Layout" &&
        typeof event.dur === "number" &&
        onRendererMain(event) &&
        event.dur / 1_000 > 1,
    );
  const slowLayoutDurationsMs = slowLayoutEvents.map(
    (event) => (event.dur ?? 0) / 1_000,
  );
  const firstLayoutTimestamp = slowLayoutEvents[0]?.ts ?? 0;
  const slowLayoutOffsetsMs = slowLayoutEvents.map(
    (event) => ((event.ts ?? firstLayoutTimestamp) - firstLayoutTimestamp) / 1_000,
  );
  const tracedLongTasks = events
    .filter(
      (event) =>
        event.ph === "X" &&
        event.name === "RunTask" &&
        typeof event.dur === "number" &&
        onRendererMain(event) &&
        event.dur / 1_000 > 50,
    )
    .map((event) => (event.dur ?? 0) / 1_000);
  const observedLongTasksOverLimit = observedLongTasks.filter(
    (duration) => duration > 50,
  );

  return {
    slowLayoutDurationsMs,
    slowLayoutOffsetsMs,
    longTaskDurationsMs:
      observedLongTasksOverLimit.length > 0
        ? observedLongTasksOverLimit
        : tracedLongTasks,
  };
}
