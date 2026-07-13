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
  type PullRequestPatchRequest,
  type PullRequestPatchResult,
  type PullRequestReviewThread,
  type PullRequestSummary,
} from "@mcode/contracts";
import { expect, test, type Page } from "@playwright/test";
import {
  interceptZustandStores,
  mockWebSocketServer,
  type RpcOverrides,
} from "./helpers/e2e-helpers";

const BASE_OID_A = "a".repeat(40);
const HEAD_OID_A = "b".repeat(40);
const BASE_OID_B = "c".repeat(40);
const HEAD_OID_B = "d".repeat(40);
const CODE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const EAGER_CHUNK_MAX_BYTES = 500 * 1024;
const FIXTURE_TIME = "2026-07-11T12:00:00.000Z";
const FIXTURE_STALE_AT = "2099-07-11T12:00:00.000Z";

const IDENTITY: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "REPO_D3_E2E",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 468,
};

const DRAFT_IDENTITY_KEY = JSON.stringify([
  IDENTITY.provider,
  IDENTITY.repositoryNodeId,
  IDENTITY.number,
]);

const CAPABILITIES: PullRequestCapabilitiesResult = {
  ok: true,
  viewer: {
    providerNodeId: "VIEWER_D3_E2E",
    login: "fixture-reviewer",
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

function pullRequestSummary(): PullRequestSummary {
  return {
    identity: IDENTITY,
    url: "https://github.com/Mzeey-Empire/mcode/pull/468",
    title: "Exercise the bounded Code review surface",
    author: {
      providerNodeId: "ACTOR_D3_E2E",
      login: "fixture-author",
      avatarUrl: null,
      profileUrl: null,
    },
    state: "open",
    readiness: "ready",
    head: {
      owner: "fixture-author",
      repository: "mcode",
      name: "codex/pull-request-large-code",
      oid: HEAD_OID_A,
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: BASE_OID_A,
    },
    relationships: ["direct_review_requested"],
    checks: { state: "passing" },
    commentCount: 1,
    additions: PULL_REQUEST_PATCH_MAX_LINES - 1,
    deletions: 0,
    updatedAt: FIXTURE_TIME,
  };
}

function pullRequestDetail(
  baseOid = BASE_OID_A,
  headOid = HEAD_OID_A,
): PullRequestDetail {
  const summary = pullRequestSummary();
  return {
    identity: summary.identity,
    providerNodeId: "PR_D3_E2E",
    url: summary.url,
    title: summary.title,
    body: "A deterministic browser fixture for Code review limits.",
    author: summary.author,
    state: summary.state,
    readiness: summary.readiness,
    head: { ...summary.head, oid: headOid },
    base: { ...summary.base, oid: baseOid },
    additions: summary.additions,
    deletions: summary.deletions,
    changedFiles: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    mergeability: "mergeable",
    reviewDecision: "review_required",
    reviewers: [],
    checks: summary.checks,
    checkCount: 1,
    commentCount: 0,
    reviewThreadCount: 1,
  };
}

function changedFile(
  locator: string,
  path: string,
  overrides: Partial<PullRequestFile> = {},
): PullRequestFile {
  return {
    locator,
    path,
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    blobOid: locator.charCodeAt(0).toString(16).padStart(40, "0"),
    patchStatus: "available",
    ...overrides,
  };
}

function filesResult(input: {
  items: PullRequestFile[];
  baseOid?: string;
  headOid?: string;
  nextCursor?: string | null;
  boundedData?: PullRequestFilesResult extends { ok: true; boundedData: infer Marker }
    ? Marker
    : never;
}): PullRequestFilesResult {
  return {
    ok: true,
    items: input.items,
    nextCursor: input.nextCursor ?? null,
    baseOid: input.baseOid ?? BASE_OID_A,
    headOid: input.headOid ?? HEAD_OID_A,
    snapshotVersion: `files:${input.baseOid ?? BASE_OID_A}:${input.headOid ?? HEAD_OID_A}`,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    boundedData: input.boundedData ?? null,
  };
}

function patchResult(input: {
  file: PullRequestFile;
  baseOid?: string;
  headOid?: string;
  patch?: string;
  status?: "available" | "generated";
}): PullRequestPatchResult {
  const patch = input.patch ?? "@@ -1 +1 @@\n-before\n+after";
  return {
    ok: true,
    locator: input.file.locator,
    path: input.file.path,
    previousPath: input.file.previousPath,
    changeType: input.file.changeType,
    blobOid: input.file.blobOid,
    baseOid: input.baseOid ?? BASE_OID_A,
    headOid: input.headOid ?? HEAD_OID_A,
    status: input.status ?? "available",
    patch,
    parsedLineCount: patch.split("\n").length,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
  };
}

function detailResult(detail: PullRequestDetail): PullRequestGetResult {
  return {
    ok: true,
    resource: "detail",
    item: detail,
    snapshotVersion: `detail:${detail.base.oid}:${detail.head.oid}`,
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    boundedData: null,
  };
}

function commentsResult(
  items: PullRequestReviewThread[] = [],
): PullRequestGetResult {
  return {
    ok: true,
    resource: "comments",
    items,
    nextCursor: null,
    snapshotVersion: "comments:d3-e2e",
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    boundedData: null,
  };
}

function checksResult(): PullRequestGetResult {
  return {
    ok: true,
    resource: "checks",
    items: [],
    nextCursor: null,
    snapshotVersion: "checks:d3-e2e",
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    boundedData: null,
  };
}

function getResultFor(
  request: PullRequestGetRequest,
  detail: PullRequest,
  comments: PullRequestReviewThread[] = [],
): PullRequestGetResult {
  if (request.resource === "detail") return detailResult(detail);
  if (request.resource === "comments") return commentsResult(comments);
  return checksResult();
}

function listResult() {
  return {
    ok: true as const,
    items: [pullRequestSummary()],
    nextCursor: null,
    snapshotVersion: "inbox:d3-e2e",
    fetchedAt: FIXTURE_TIME,
    staleAt: FIXTURE_STALE_AT,
    limitations: [],
  };
}

async function installPullRequestHarness(
  page: Page,
  overrides: RpcOverrides,
): Promise<void> {
  await interceptZustandStores(page);
  await mockWebSocketServer(page, {
    "pullRequest.capabilities": CAPABILITIES,
    "pullRequest.list": listResult(),
    "pullRequest.cancel": { ok: true, cancelled: true },
    ...overrides,
  });
}

async function openPullRequestDetail(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Pull requests" }).click();
  const row = page.getByTestId("pull-request-row");
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(
    page.getByRole("heading", { name: "Exercise the bounded Code review surface" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Code" })).toBeVisible();
}

async function activeDetailSnapshot(page: Page): Promise<{
  baseOid: string | null;
  headOid: string | null;
  operationId: string | null;
}> {
  return page.evaluate(() => {
    type Store = { getState(): Record<string, unknown> };
    const stores = (window as unknown as { __mcodeStores?: Store[] }).__mcodeStores ?? [];
    const store = stores.find((candidate) => {
      const state = candidate.getState();
      return "activeKey" in state && "loadDetail" in state && "refreshActive" in state;
    });
    if (!store) throw new Error("Pull request detail store was not registered");
    const state = store.getState() as {
      activeKey: string | null;
      entries: Record<
        string,
        {
          detail: PullRequestDetail | null;
          lanes: { detail: { operationId: string | null } };
        }
      >;
    };
    const entry = state.activeKey ? state.entries[state.activeKey] ?? null : null;
    return {
      baseOid: entry?.detail?.base.oid ?? null,
      headOid: entry?.detail?.head.oid ?? null,
      operationId: entry?.lanes.detail.operationId ?? null,
    };
  });
}

function largePatch(): string {
  const addedLines = Array.from(
    { length: PULL_REQUEST_PATCH_MAX_LINES - 1 },
    () => "+x",
  );
  return [
    `@@ -0,0 +1,${PULL_REQUEST_PATCH_MAX_LINES - 1} @@`,
    ...addedLines,
  ].join("\n");
}

function outdatedThread(headOid = HEAD_OID_A): PullRequestReviewThread {
  return {
    kind: "review_thread",
    providerNodeId: "THREAD_REMOVED_FILE",
    path: "src/removed.ts",
    line: 8,
    startLine: 8,
    side: "right",
    startSide: "right",
    originalLine: 7,
    originalStartLine: 7,
    subjectType: "line",
    commitOid: HEAD_OID_A,
    headOid,
    isResolved: false,
    isOutdated: true,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    totalCount: 1,
    comments: [
      {
        providerNodeId: "COMMENT_REMOVED_FILE",
        author: null,
        body: "Remote note retained for the removed file.",
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
        url: "https://github.com/Mzeey-Empire/mcode/pull/468#discussion_r1",
      },
    ],
  };
}

test.describe("Pull request large Code gates", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps a 20,000-line patch virtualized, accounted, and lazy", async ({ page }) => {
    const patch = largePatch();
    const file = changedFile("large_file", "x", {
      additions: PULL_REQUEST_PATCH_MAX_LINES - 1,
      deletions: 0,
      changes: PULL_REQUEST_PATCH_MAX_LINES - 1,
    });
    const codeModuleResponses: Array<import("@playwright/test").Response> = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.endsWith("/PullRequestCode.tsx")) {
        codeModuleResponses.push(response);
      }
    });

    await installPullRequestHarness(page, {
      "pullRequest.get": (params) =>
        getResultFor(params as PullRequestGetRequest, pullRequestDetail()),
      "pullRequest.files": filesResult({ items: [file] }),
      "pullRequest.patch": patchResult({ file, patch }),
    });
    await openPullRequestDetail(page);

    expect(codeModuleResponses).toHaveLength(0);
    await page.getByRole("tab", { name: "Code" }).click();
    const codeRoot = page.getByTestId("pull-request-code-root");
    const grid = page.getByRole("grid", { name: "Pull request diff" });
    await expect(codeRoot).toBeVisible();
    await expect(grid).toHaveAttribute(
      "aria-rowcount",
      String(PULL_REQUEST_PATCH_MAX_LINES + 1),
    );

    await expect.poll(() => codeRoot.locator("*").count()).toBeLessThan(500);
    await expect.poll(() => grid.getByRole("row").count()).toBeLessThan(40);

    await expect.poll(() => page.evaluate(() => {
      type Store = { getState(): Record<string, unknown> };
      const stores = (window as unknown as { __mcodeStores?: Store[] }).__mcodeStores ?? [];
      const store = stores.find((candidate) => {
        const state = candidate.getState();
        return "activeSnapshotKey" in state && "patches" in state && "loadAllFiles" in state;
      });
      if (!store) return 0;
      const patches = (store.getState() as {
        patches: Record<string, { parsedBytes: number }>;
      }).patches;
      return Object.values(patches)[0]?.parsedBytes ?? 0;
    })).toBeGreaterThan(0);

    const accounting = await page.evaluate(({ cacheLimit }) => {
      type Store = { getState(): Record<string, unknown> };
      const stores = (window as unknown as { __mcodeStores?: Store[] }).__mcodeStores ?? [];
      const store = stores.find((candidate) => {
        const state = candidate.getState();
        return "activeSnapshotKey" in state && "patches" in state && "loadAllFiles" in state;
      });
      if (!store) throw new Error("Pull request Code store was not registered");
      const state = store.getState() as {
        patches: Record<
          string,
          {
            result: { parsedLineCount: number | null } | null;
            rawBytes: number;
            parsedBytes: number;
            tokenBytes: number;
            estimatedBytes: number;
          }
        >;
      };
      const lanes = Object.values(state.patches);
      if (lanes.length !== 1 || !lanes[0]) {
        throw new Error(`Expected one cached patch, received ${lanes.length}`);
      }
      const lane = lanes[0];
      return {
        parsedLineCount: lane.result?.parsedLineCount ?? null,
        rawBytes: lane.rawBytes,
        parsedBytes: lane.parsedBytes,
        tokenBytes: lane.tokenBytes,
        estimatedBytes: lane.estimatedBytes,
        componentsTotal: lane.rawBytes + lane.parsedBytes + lane.tokenBytes,
        withinBudget: lane.estimatedBytes <= cacheLimit,
      };
    }, { cacheLimit: CODE_CACHE_MAX_BYTES });
    expect(accounting).toMatchObject({
      parsedLineCount: PULL_REQUEST_PATCH_MAX_LINES,
      withinBudget: true,
    });
    expect(accounting.parsedBytes).toBeGreaterThan(0);
    expect(accounting.estimatedBytes).toBe(accounting.componentsTotal);

    await expect.poll(() => codeModuleResponses.length).toBe(1);
    const codeModuleBody = await codeModuleResponses[0].body();
    expect(codeModuleBody.byteLength).toBeLessThan(EAGER_CHUNK_MAX_BYTES);
  });

  test("continues catch-up search and stops at the provider limit", async ({ page }) => {
    const initialFile = changedFile("initial_file", "src/initial.ts");
    const firstMatch = changedFile("match_one", "src/needle-one.ts");
    const secondMatch = changedFile("match_two", "src/needle-two.ts");
    const searchRequests: PullRequestFilesRequest[] = [];
    const fileByLocator = new Map(
      [initialFile, firstMatch, secondMatch].map((file) => [file.locator, file]),
    );

    await installPullRequestHarness(page, {
      "pullRequest.get": (params) =>
        getResultFor(params as PullRequestGetRequest, pullRequestDetail()),
      "pullRequest.files": (params) => {
        const request = params as PullRequestFilesRequest;
        if (!request.search) return filesResult({ items: [initialFile] });
        searchRequests.push(request);
        if (!request.cursor) {
          return filesResult({
            items: [firstMatch],
            nextCursor: "search-page-2",
            boundedData: { reason: "catch_up_limit" },
          });
        }
        return filesResult({
          items: [secondMatch],
          nextCursor: "provider-has-more",
          boundedData: { reason: "provider_limit" },
        });
      },
      "pullRequest.patch": (params) => {
        const request = params as PullRequestPatchRequest;
        const file = fileByLocator.get(request.locator);
        if (!file) throw new Error(`Unknown fixture locator ${request.locator}`);
        return patchResult({ file });
      },
    });
    await openPullRequestDetail(page);
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByTestId("pull-request-code-root")).toBeVisible();

    await page.getByRole("textbox", { name: "Search changed files" }).fill("needle");
    await expect(
      page.getByText("Search paused after four GitHub pages. More matching files may remain."),
    ).toBeVisible();
    const continueButton = page.getByRole("button", { name: "Search remaining files" });
    await expect(continueButton).toBeVisible();
    await continueButton.click();

    await expect(
      page.getByText("GitHub's changed-file limit was reached. This Change stack is partial."),
    ).toBeVisible();
    await expect(continueButton).toHaveCount(0);
    expect(searchRequests.map((request) => request.cursor ?? null)).toEqual([
      null,
      "search-page-2",
    ]);
  });

  test("invalidates both OIDs and keeps orphaned remote and local context visible", async ({
    page,
  }) => {
    const snapshots = [
      { baseOid: BASE_OID_A, headOid: HEAD_OID_A, path: "src/review.ts" },
      { baseOid: BASE_OID_B, headOid: HEAD_OID_A, path: "src/rebased.ts" },
      { baseOid: BASE_OID_B, headOid: HEAD_OID_B, path: "src/updated.ts" },
    ];
    let snapshotIndex = 0;
    const fileRequests: Array<{ baseOid: string; headOid: string }> = [];
    const filesByLocator = new Map<string, PullRequestFile>();

    await installPullRequestHarness(page, {
      "pullRequest.get": (params) => {
        const request = params as PullRequestGetRequest;
        if (request.resource === "detail") {
          const snapshot = snapshots[snapshotIndex];
          return detailResult(pullRequestDetail(snapshot.baseOid, snapshot.headOid));
        }
        if (request.resource === "comments") {
          return commentsResult([outdatedThread(snapshots[snapshotIndex].headOid)]);
        }
        return checksResult();
      },
      "pullRequest.files": (params) => {
        const request = params as PullRequestFilesRequest;
        fileRequests.push({ baseOid: request.baseOid, headOid: request.headOid });
        const snapshot = snapshots.find(
          (candidate) =>
            candidate.baseOid === request.baseOid && candidate.headOid === request.headOid,
        );
        if (!snapshot) throw new Error("Unexpected snapshot-qualified file request");
        const file = changedFile(
          `file_${fileRequests.length}`,
          snapshot.path,
        );
        filesByLocator.set(file.locator, file);
        return filesResult({
          items: [file],
          baseOid: request.baseOid,
          headOid: request.headOid,
        });
      },
      "pullRequest.patch": (params) => {
        const request = params as PullRequestPatchRequest;
        const file = filesByLocator.get(request.locator);
        if (!file) throw new Error(`Unknown fixture locator ${request.locator}`);
        return patchResult({
          file,
          baseOid: request.baseOid,
          headOid: request.headOid,
        });
      },
    });
    await openPullRequestDetail(page);
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText("Remote note retained for the removed file.")).toBeVisible();

    await page.evaluate(({ identityKey, baseOid, headOid }) => {
      type Store = { getState(): Record<string, unknown> };
      const stores = (window as unknown as { __mcodeStores?: Store[] }).__mcodeStores ?? [];
      const store = stores.find((candidate) => {
        const state = candidate.getState();
        return "drafts" in state && "createDraft" in state && "reconcileActiveSnapshot" in state;
      });
      if (!store) throw new Error("Pull request review draft store was not registered");
      const result = (
        store.getState() as {
          createDraft(input: unknown): { ok: boolean };
        }
      ).createDraft({
        snapshot: { identityKey, baseOid, headOid },
        kind: "inline",
        path: "src/removed.ts",
        body: "Local draft retained for the removed file.",
      });
      if (!result.ok) throw new Error("Failed to seed the local review draft");
    }, { identityKey: DRAFT_IDENTITY_KEY, baseOid: BASE_OID_A, headOid: HEAD_OID_A });

    const refresh = page.getByRole("button", { name: "Refresh pull request detail" });
    snapshotIndex = 1;
    await refresh.click();
    await expect.poll(() => activeDetailSnapshot(page)).toEqual({
      baseOid: BASE_OID_B,
      headOid: HEAD_OID_A,
      operationId: null,
    });
    await expect.poll(() => fileRequests.length).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("textbox", { name: "Review draft" })).toHaveValue(
      "Local draft retained for the removed file.",
    );
    await expect(page.getByLabel("Outdated conversation")).toBeVisible();

    snapshotIndex = 2;
    await refresh.click();
    await expect.poll(() => activeDetailSnapshot(page)).toEqual({
      baseOid: BASE_OID_B,
      headOid: HEAD_OID_B,
      operationId: null,
    });
    await expect.poll(() => fileRequests.length).toBeGreaterThanOrEqual(3);
    const distinctFileRequests = fileRequests.filter((request, index, requests) => {
      const previous = requests[index - 1];
      return !previous || request.baseOid !== previous.baseOid || request.headOid !== previous.headOid;
    });
    expect(distinctFileRequests).toEqual([
      { baseOid: BASE_OID_A, headOid: HEAD_OID_A },
      { baseOid: BASE_OID_B, headOid: HEAD_OID_A },
      { baseOid: BASE_OID_B, headOid: HEAD_OID_B },
    ]);

    const cache = await page.evaluate(() => {
      type Store = { getState(): Record<string, unknown> };
      const stores = (window as unknown as { __mcodeStores?: Store[] }).__mcodeStores ?? [];
      const store = stores.find((candidate) => {
        const state = candidate.getState();
        return "activeSnapshotKey" in state && "patches" in state && "loadAllFiles" in state;
      });
      if (!store) throw new Error("Pull request Code store was not registered");
      const state = store.getState() as {
        activeSnapshotKey: string | null;
        entries: Record<string, { baseOid: string; headOid: string }>;
        patches: Record<string, unknown>;
      };
      const activeEntry = state.activeSnapshotKey
        ? state.entries[state.activeSnapshotKey] ?? null
        : null;
      return {
        baseOid: activeEntry?.baseOid ?? null,
        headOid: activeEntry?.headOid ?? null,
        entryCount: Object.keys(state.entries).length,
        patchCount: Object.keys(state.patches).length,
      };
    });
    expect(cache).toMatchObject({ baseOid: BASE_OID_B, headOid: HEAD_OID_B });
    expect(cache.entryCount).toBe(1);
    expect(cache.patchCount).toBe(1);
  });

  test("renders generated patch evidence as generated code", async ({ page }) => {
    const file = changedFile("generated_file", "src/generated.ts", {
      patchStatus: "unavailable",
    });

    await installPullRequestHarness(page, {
      "pullRequest.get": (params) =>
        getResultFor(params as PullRequestGetRequest, pullRequestDetail()),
      "pullRequest.files": filesResult({ items: [file] }),
      "pullRequest.patch": patchResult({ file, status: "generated" }),
    });
    await openPullRequestDetail(page);
    await page.getByRole("tab", { name: "Code" }).click();

    await expect(
      page.getByLabel("Change stack").getByText("Generated", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("grid", { name: "Pull request diff" })).toContainText(
      "after",
    );
    const status = await page.evaluate(() => {
      type Store = { getState(): Record<string, unknown> };
      const stores = (window as unknown as { __mcodeStores?: Store[] }).__mcodeStores ?? [];
      const store = stores.find((candidate) => {
        const state = candidate.getState();
        return "activeSnapshotKey" in state && "patches" in state && "loadAllFiles" in state;
      });
      if (!store) throw new Error("Pull request Code store was not registered");
      const patches = (store.getState() as {
        patches: Record<string, { result: { status: string } | null }>;
      }).patches;
      return Object.values(patches)[0]?.result?.status ?? null;
    });
    expect(status).toBe("generated");
  });
});
