import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import type {
  PullRequestBoundedDataMarker,
  PullRequestCapabilities,
  PullRequestCapabilitiesRequest,
  PullRequestCapabilitiesResult,
  PullRequestCancelResult,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestError,
  PullRequestFile,
  PullRequestFilesRequest,
  PullRequestFilesResult,
  PullRequestGetRequest,
  PullRequestGetResult,
  PullRequestIdentity,
  PullRequestListRequest,
  PullRequestListResult,
  PullRequestPatchRequest,
  PullRequestPatchResult,
  PullRequestRelationship,
  PullRequestReviewThread,
  PullRequestSummary,
  PullRequestTimelineRequest,
  PullRequestTimelineResult,
} from "@mcode/contracts";
import {
  PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH,
  PULL_REQUEST_CURSOR_MAX_LENGTH,
  PULL_REQUEST_FILE_MAX_COUNT,
} from "@mcode/contracts";
import { GithubPullRequestClientError } from "../github/github-pull-request-client.js";
import type {
  PullRequestRemoteBucket,
  PullRequestRemoteClient,
  PullRequestRemoteCommentCursorState,
  PullRequestRemoteCursorState,
  PullRequestRemotePage,
  PullRequestRemotePatchResult,
  PullRequestViewerContext,
} from "../github/pull-request-remote.js";
import {
  createPullRequestFileLocator,
  decodePullRequestFileLocator,
} from "../github/github-pull-request-file-normalizers.js";

const CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 100;
const DEFAULT_DETAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_IDENTITY_SNAPSHOT_MAX_ENTRIES = 1_000;
const DETAIL_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const PATCH_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_PATCH_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_PATCH_FETCH_MAX_CONCURRENCY = 4;
const DEFAULT_PATCH_FETCH_MAX_QUEUED = 16;
const FILE_SCAN_MAX_PAGES = 4;
const GITHUB_FILES_PER_PAGE = 100;
const GITHUB_FILES_MAX_PAGES = PULL_REQUEST_FILE_MAX_COUNT / GITHUB_FILES_PER_PAGE;
const DEFAULT_CONNECTION = {};
const relationshipOrder: PullRequestRelationship[] = [
  "authored",
  "direct_review_requested",
  "team_review_requested",
  "reviewed",
];

const cursorStateSchema = z
  .object({
    authored: z
      .string()
      .min(1)
      .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
      .nullable()
      .optional(),
    reviewRequested: z
      .string()
      .min(1)
      .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
      .nullable()
      .optional(),
    reviewed: z
      .string()
      .min(1)
      .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
      .nullable()
      .optional(),
  })
  .strict();

const inboxCursorSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().length(43),
    snapshotVersion: z.string().uuid(),
    cursors: cursorStateSchema,
  })
  .strict();

const detailCursorStateSchema = z.discriminatedUnion("resource", [
  z.object({
    resource: z.literal("checks"),
    cursor: z.string().min(1).max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH),
  }),
  z.object({
    resource: z.literal("comments"),
    cursors: z
      .object({
        issueComments: z
          .string()
          .min(1)
          .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
          .nullable()
          .optional(),
        reviewThreads: z
          .string()
          .min(1)
          .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
          .nullable()
          .optional(),
      })
      .strict(),
  }),
]);

const detailCursorSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().length(43),
    snapshotVersion: z.string().length(43),
    state: detailCursorStateSchema,
  })
  .strict();

const timelineCursorSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().length(43),
    snapshotVersion: z.string().length(43),
    lane: z.enum(["older", "newer"]),
    cursor: z.string().min(1).max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH),
  })
  .strict();

const filesCursorSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().length(43),
    baseOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
    headOid: z.string().regex(/^[0-9a-f]{40,64}$/i),
    page: z.number().int().min(1).max(GITHUB_FILES_MAX_PAGES),
    offset: z.number().int().min(0).max(GITHUB_FILES_PER_PAGE - 1),
  })
  .strict();

interface PullRequestServiceOptions {
  now?: () => number;
  cacheMaxEntries?: number;
  detailCacheMaxBytes?: number;
  identitySnapshotMaxEntries?: number;
  patchCacheMaxBytes?: number;
  patchFetchMaxConcurrency?: number;
  patchFetchMaxQueued?: number;
}

/** Fresh bounded provider data used to seed a local Review task. */
export interface PullRequestReviewTaskSource {
  detail: PullRequestDetail;
  headRepositoryNodeId: string;
  checks: PullRequestCheck[];
  unresolvedReviewThreads: PullRequestReviewThread[];
  bounds: {
    checksHasNextPage: boolean;
    checksBoundedData: PullRequestBoundedDataMarker | null;
    commentsHasNextPage: boolean;
    commentsBoundedData: PullRequestBoundedDataMarker | null;
  };
}

interface CachedListResult {
  result: PullRequestListResult & { ok: true };
  staleAtMs: number;
  viewerNodeId: string;
}

interface CachedViewer {
  viewer: PullRequestViewerContext;
  staleAtMs: number;
}

type CachedMutableResult =
  | (PullRequestGetResult & { ok: true })
  | (PullRequestTimelineResult & { ok: true })
  | (PullRequestFilesResult & { ok: true });

interface CachedMutableRead {
  result: CachedMutableResult;
  staleAtMs: number;
  bytes: number;
  identityKey: string;
}

interface IdentitySnapshot {
  headVersion: string;
  baseVersion?: string;
  staleAtMs: number;
}

interface CachedPatchRead {
  result: PullRequestPatchResult & { ok: true };
  staleAtMs: number;
  bytes: number;
  identityKey: string;
}

interface SharedPatchFetch {
  key: string;
  controller: AbortController;
  promise: Promise<PullRequestRemotePatchResult>;
  resolve: (result: PullRequestRemotePatchResult) => void;
  reject: (error: unknown) => void;
  request: Omit<Parameters<PullRequestRemoteClient["getPatch"]>[0], "signal">;
  state: "queued" | "active" | "settled";
  waiters: number;
  identityKey: string;
}

function capability(allowed: boolean, reason?: PullRequestCapabilities["read"]["reason"]) {
  return reason ? { allowed, reason } : { allowed };
}

/** Resolve independently gated pull request actions for an authenticated viewer. */
export function resolvePullRequestCapabilities(
  viewer: PullRequestViewerContext,
): PullRequestCapabilities {
  const scopes = new Set(viewer.scopes.map((scope) => scope.toLowerCase()));
  const teamRequestsAllowed = scopes.has("read:org") || scopes.has("admin:org");
  return {
    read: capability(true),
    teamRequests: teamRequestsAllowed
      ? capability(true)
      : capability(false, "missing_scope"),
    comment: capability(true),
    review: capability(true),
    readiness: capability(true),
    close: capability(true),
    merge: capability(true),
    reviewWorktree: capability(true),
  };
}

function identityKey(summary: PullRequestSummary): string {
  return pullRequestIdentityKey(summary.identity);
}

function pullRequestIdentityKey(identity: PullRequestIdentity): string {
  const { provider, repositoryNodeId, number } = identity;
  return `${provider}\0${repositoryNodeId}\0${number}`;
}

function normalizedRelationships(
  relationships: readonly PullRequestRelationship[],
): PullRequestRelationship[] {
  const selected = new Set(relationships);
  return relationshipOrder.filter((relationship) => selected.has(relationship));
}

/** Merge duplicate relationship results by provider, repository node ID, and number. */
export function mergePullRequestSummaries(
  page: PullRequestRemotePage,
  includeTeamRequests: boolean,
  maxItems: number,
): PullRequestSummary[] {
  const merged = new Map<string, PullRequestSummary>();
  const buckets: PullRequestRemoteBucket[] = ["authored", "reviewRequested", "reviewed"];

  for (const bucket of buckets) {
    const bucketPage = page.buckets[bucket];
    if (!bucketPage) continue;
    for (const item of bucketPage.items.slice(0, maxItems)) {
      const allowedRelationships = item.relationships.filter(
        (relationship) => includeTeamRequests || relationship !== "team_review_requested",
      );
      if (allowedRelationships.length === 0) continue;

      const key = identityKey(item);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...item,
          relationships: normalizedRelationships(allowedRelationships),
        });
        continue;
      }

      const newest = item.updatedAt > existing.updatedAt ? item : existing;
      merged.set(key, {
        ...newest,
        relationships: normalizedRelationships([
          ...existing.relationships,
          ...allowedRelationships,
        ]),
      });
    }
  }

  return [...merged.values()]
    .sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      if (updated !== 0) return updated;
      return identityKey(left).localeCompare(identityKey(right));
    })
    .slice(0, maxItems);
}

function requestFingerprint(request: PullRequestListRequest): string {
  const normalized = JSON.stringify({
    provider: request.provider,
    relationships: [...request.relationships].sort(),
    states: [...request.states].sort(),
    search: request.search ?? "",
    limit: request.limit,
  });
  return createHash("sha256").update(normalized).digest("base64url");
}

function decodeCursor(cursor: string | undefined, fingerprint: string) {
  if (!cursor) return { snapshotVersion: randomUUID(), cursors: {} };
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = inboxCursorSchema.parse(JSON.parse(decoded) as unknown);
    if (parsed.fingerprint !== fingerprint) return null;
    return {
      snapshotVersion: parsed.snapshotVersion,
      cursors: parsed.cursors,
    };
  } catch {
    return null;
  }
}

function nextRemoteCursors(
  page: PullRequestRemotePage,
  previous: PullRequestRemoteCursorState,
): PullRequestRemoteCursorState {
  const next = { ...previous };
  const buckets: PullRequestRemoteBucket[] = ["authored", "reviewRequested", "reviewed"];
  for (const bucket of buckets) {
    const bucketPage = page.buckets[bucket];
    if (!bucketPage) continue;
    next[bucket] = bucketPage.hasNextPage ? bucketPage.endCursor : null;
  }
  return next;
}

function hasNextPage(page: PullRequestRemotePage): boolean {
  return Object.values(page.buckets).some((bucket) => bucket?.hasNextPage);
}

function encodeCursor(
  fingerprint: string,
  snapshotVersion: string,
  cursors: PullRequestRemoteCursorState,
): string {
  const boundedCursors = cursorStateSchema.safeParse(cursors);
  if (!boundedCursors.success) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned an oversized pull request cursor.",
    );
  }
  const encoded = Buffer.from(
    JSON.stringify({
      version: 1,
      fingerprint,
      snapshotVersion,
      cursors: boundedCursors.data,
    }),
    "utf8",
  ).toString("base64url");
  if (encoded.length > PULL_REQUEST_CURSOR_MAX_LENGTH) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned an oversized pull request cursor.",
    );
  }
  return encoded;
}

function searchMatches(summary: PullRequestSummary, search: string | undefined): boolean {
  const query = search?.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    summary.title,
    `${summary.identity.owner}/${summary.identity.repository}`,
    summary.head.name,
    summary.author?.login ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

function stableFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("base64url");
}

function detailFingerprint(request: PullRequestGetRequest): string {
  return stableFingerprint({
    identity: request.identity,
    resource: request.resource,
    limit: request.resource === "detail" ? null : request.limit,
  });
}

function timelineFingerprint(request: PullRequestTimelineRequest): string {
  return stableFingerprint({ identity: request.identity, limit: request.limit });
}

function filesFingerprint(request: PullRequestFilesRequest): string {
  return stableFingerprint({
    identity: request.identity,
    baseOid: request.baseOid,
    headOid: request.headOid,
    search: request.search ?? "",
    changeTypes: [...request.changeTypes].sort(),
    limit: request.limit,
  });
}

function snapshotVersion(marker: string): string {
  return createHash("sha256").update(marker).digest("base64url");
}

function encodeOpaqueCursor(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (encoded.length > PULL_REQUEST_CURSOR_MAX_LENGTH) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned an oversized pull request cursor.",
    );
  }
  return encoded;
}

function decodeDetailCursor(
  request: PullRequestGetRequest & { resource: "checks" | "comments" },
) {
  if (!request.cursor) return null;
  try {
    const decoded = Buffer.from(request.cursor, "base64url").toString("utf8");
    const parsed = detailCursorSchema.parse(JSON.parse(decoded) as unknown);
    if (
      parsed.fingerprint !== detailFingerprint(request)
      || parsed.state.resource !== request.resource
    ) {
      return undefined;
    }
    if (
      parsed.state.resource === "comments"
      && !Object.values(parsed.state.cursors).some((cursor) => typeof cursor === "string")
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function encodeChecksCursor(
  fingerprint: string,
  version: string,
  cursor: string,
): string {
  const parsedCursor = z
    .string()
    .min(1)
    .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
    .safeParse(cursor);
  if (!parsedCursor.success) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned an invalid pull request checks cursor.",
    );
  }
  return encodeOpaqueCursor({
    version: 1,
    fingerprint,
    snapshotVersion: version,
    state: { resource: "checks", cursor: parsedCursor.data },
  });
}

function encodeCommentsCursor(
  fingerprint: string,
  version: string,
  cursors: PullRequestRemoteCommentCursorState,
): string {
  const parsedCursors = detailCursorStateSchema.safeParse({
    resource: "comments",
    cursors,
  });
  if (!parsedCursors.success) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned an invalid pull request comments cursor.",
    );
  }
  return encodeOpaqueCursor({
    version: 1,
    fingerprint,
    snapshotVersion: version,
    state: parsedCursors.data,
  });
}

function decodeTimelineCursor(request: PullRequestTimelineRequest) {
  if (request.lane === "initial") return null;
  try {
    const decoded = Buffer.from(request.cursor, "base64url").toString("utf8");
    const parsed = timelineCursorSchema.parse(JSON.parse(decoded) as unknown);
    if (
      parsed.fingerprint !== timelineFingerprint(request)
      || parsed.lane !== request.lane
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function encodeTimelineCursor(
  fingerprint: string,
  version: string,
  lane: "older" | "newer",
  cursor: string,
): string {
  const parsedCursor = z
    .string()
    .min(1)
    .max(PULL_REQUEST_CURSOR_COMPONENT_MAX_LENGTH)
    .safeParse(cursor);
  if (!parsedCursor.success) {
    throw new GithubPullRequestClientError(
      "remote_unavailable",
      "GitHub returned an invalid pull request Timeline cursor.",
    );
  }
  return encodeOpaqueCursor({
    version: 1,
    fingerprint,
    snapshotVersion: version,
    lane,
    cursor: parsedCursor.data,
  });
}

function decodeFilesCursor(request: PullRequestFilesRequest) {
  if (!request.cursor) return { page: 1, offset: 0 };
  try {
    const decoded = Buffer.from(request.cursor, "base64url").toString("utf8");
    const parsed = filesCursorSchema.parse(JSON.parse(decoded) as unknown);
    if (
      parsed.fingerprint !== filesFingerprint(request)
      || parsed.baseOid !== request.baseOid
      || parsed.headOid !== request.headOid
    ) {
      return null;
    }
    return { page: parsed.page, offset: parsed.offset };
  } catch {
    return null;
  }
}

function encodeFilesCursor(
  request: PullRequestFilesRequest,
  page: number,
  offset: number,
): string {
  return encodeOpaqueCursor({
    version: 1,
    fingerprint: filesFingerprint(request),
    baseOid: request.baseOid,
    headOid: request.headOid,
    page,
    offset,
  });
}

function fileMatchesRequest(
  file: { path: string; previousPath: string | null; changeType: PullRequestFile["changeType"] },
  request: PullRequestFilesRequest,
): boolean {
  if (request.changeTypes.length > 0 && !request.changeTypes.includes(file.changeType)) {
    return false;
  }
  const search = request.search?.trim().toLocaleLowerCase();
  return !search || file.path.toLocaleLowerCase().includes(search)
    || file.previousPath?.toLocaleLowerCase().includes(search) === true;
}

function remoteFileToContract(
  file: Parameters<typeof createPullRequestFileLocator>[0],
): PullRequestFile {
  return {
    locator: createPullRequestFileLocator(file),
    path: file.path,
    previousPath: file.previousPath,
    changeType: file.changeType,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blobOid: file.blobOid,
    patchStatus: file.hasPatch ? "available" : "unavailable",
  };
}

function strongerBoundedData(
  left: PullRequestBoundedDataMarker | null,
  right: PullRequestBoundedDataMarker | null,
): PullRequestBoundedDataMarker | null {
  if (left?.reason === "byte_limit" || right?.reason === "byte_limit") {
    return { reason: "byte_limit" };
  }
  return left ?? right;
}

function boundItemsByBytes<T>(items: readonly T[]): {
  items: T[];
  boundedData: PullRequestBoundedDataMarker | null;
} {
  const retained: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (bytes + itemBytes > DETAIL_RESPONSE_MAX_BYTES) {
      return { items: retained, boundedData: { reason: "byte_limit" } };
    }
    retained.push(item);
    bytes += itemBytes;
  }
  return { items: retained, boundedData: null };
}

function staleCursorResult(message: string): PullRequestGetResult | PullRequestTimelineResult {
  return {
    ok: false,
    error: { code: "stale_cursor", message },
  };
}

function cancelledResult(): PullRequestGetResult {
  return { ok: false, error: { code: "cancelled", message: "The pull request request was cancelled." } };
}

function checksNextCursor(
  remote: Awaited<ReturnType<PullRequestRemoteClient["listChecks"]>>,
  boundedData: PullRequestBoundedDataMarker | null,
  fingerprint: string,
  version: string,
): string | null {
  if (!remote.hasNextPage || boundedData) return null;
  if (!remote.endCursor) {
    throw new GithubPullRequestClientError("remote_unavailable", "GitHub returned an invalid pull request checks cursor.");
  }
  return encodeChecksCursor(fingerprint, version, remote.endCursor);
}

function assertGithubCommentsCursor(
  hasNextPage: boolean,
  cursors: PullRequestRemoteCommentCursorState,
): void {
  if (hasNextPage && !Object.values(cursors).some((cursor) => typeof cursor === "string")) {
    throw new GithubPullRequestClientError("remote_unavailable", "GitHub returned an invalid pull request comments cursor.");
  }
}

function cancelledTimelineResult(): PullRequestTimelineResult {
  return { ok: false, error: { code: "cancelled", message: "The pull request request was cancelled." } };
}

function timelineCursorVersionChanged(
  decoded: Exclude<ReturnType<typeof decodeTimelineCursor>, undefined>,
  lane: PullRequestTimelineRequest["lane"],
  version: string,
  headVersion: string,
): boolean {
  if (!decoded) return false;
  return decoded.snapshotVersion !== (lane === "newer" ? headVersion : version);
}

function timelinePageCursors(
  request: PullRequestTimelineRequest,
  remote: Awaited<ReturnType<PullRequestRemoteClient["listTimeline"]>>,
  boundedData: PullRequestBoundedDataMarker | null,
  version: string,
  headVersion: string,
): { older: string | null; newer: string | null; hasMoreOlder: boolean; hasMoreNewer: boolean } {
  const wasTruncated = boundedData?.reason === "byte_limit";
  const older = githubOlderTimelineCursor(request, remote, wasTruncated, version);
  const newer = githubNewerTimelineCursor(request, remote, wasTruncated, headVersion);
  assertGithubTimelineCursors(request, remote, wasTruncated, older, newer);
  return {
    older,
    newer,
    hasMoreOlder: !wasTruncated && request.lane !== "newer" && remote.hasPreviousPage,
    hasMoreNewer: !wasTruncated && request.lane !== "older" && remote.hasNextPage,
  };
}

function githubOlderTimelineCursor(
  request: PullRequestTimelineRequest,
  remote: Awaited<ReturnType<PullRequestRemoteClient["listTimeline"]>>,
  wasTruncated: boolean,
  version: string,
): string | null {
  if (wasTruncated || request.lane === "newer" || !remote.startCursor) return null;
  return encodeTimelineCursor(timelineFingerprint(request), version, "older", remote.startCursor);
}

function githubNewerTimelineCursor(
  request: PullRequestTimelineRequest,
  remote: Awaited<ReturnType<PullRequestRemoteClient["listTimeline"]>>,
  wasTruncated: boolean,
  headVersion: string,
): string | null {
  if (wasTruncated || request.lane === "older" || !remote.endCursor) return null;
  return encodeTimelineCursor(timelineFingerprint(request), headVersion, "newer", remote.endCursor);
}

function assertGithubTimelineCursors(
  request: PullRequestTimelineRequest,
  remote: Awaited<ReturnType<PullRequestRemoteClient["listTimeline"]>>,
  wasTruncated: boolean,
  older: string | null,
  newer: string | null,
): void {
  if (wasTruncated) return;
  if (request.lane !== "newer" && remote.hasPreviousPage && !older) {
    throw new GithubPullRequestClientError("remote_unavailable", "GitHub returned an invalid pull request Timeline cursor.");
  }
  if (request.lane !== "older" && remote.hasNextPage && !newer) {
    throw new GithubPullRequestClientError("remote_unavailable", "GitHub returned an invalid pull request Timeline cursor.");
  }
}

interface FileScanState {
  items: PullRequestFile[];
  page: number;
  offset: number;
  nextState: { page: number; offset: number } | null;
  boundedData: PullRequestBoundedDataMarker | null;
  scannedPages: number;
}

function staleFilesCursorResult(): PullRequestFilesResult {
  return {
    ok: false,
    error: { code: "stale_cursor", message: "The changed-files cursor does not match this comparison snapshot." },
  };
}

function appendMatchingFiles(
  state: FileScanState,
  remote: Awaited<ReturnType<PullRequestRemoteClient["listFiles"]>>,
  request: PullRequestFilesRequest,
): boolean {
  const pageStart = (state.page - 1) * GITHUB_FILES_PER_PAGE;
  const candidates = remote.items
    .filter((file) => file.globalPosition >= pageStart + state.offset)
    .sort((left, right) => left.globalPosition - right.globalPosition);
  for (const remoteFile of candidates) {
    const file = remoteFileToContract(remoteFile);
    if (!fileMatchesRequest(file, request)) continue;
    state.items.push(file);
    if (state.items.length < request.limit) continue;
    state.nextState = nextFilesScanState(remote, remoteFile.globalPosition, pageStart, state.page);
    if (remote.providerLimitReached) state.boundedData = { reason: "provider_limit" };
    return true;
  }
  return false;
}

function nextFilesScanState(
  remote: Awaited<ReturnType<PullRequestRemoteClient["listFiles"]>>,
  globalPosition: number,
  pageStart: number,
  page: number,
): { page: number; offset: number } | null {
  const nextOffset = globalPosition - pageStart + 1;
  if (remote.items.some((file) => file.globalPosition > globalPosition) && nextOffset < GITHUB_FILES_PER_PAGE) {
    return { page, offset: nextOffset };
  }
  return remote.hasNextPage && page < GITHUB_FILES_MAX_PAGES ? { page: page + 1, offset: 0 } : null;
}

type MutableCacheRequest = PullRequestGetRequest | PullRequestTimelineRequest | PullRequestFilesRequest;

function mutableResourceLane(request: MutableCacheRequest): string {
  if ("resource" in request) return request.resource;
  return "lane" in request ? request.lane : "files";
}

function mutableRequestLimit(request: MutableCacheRequest): number | null {
  return "limit" in request ? request.limit : null;
}

function mutableRequestCursor(request: MutableCacheRequest): string {
  return "cursor" in request ? request.cursor ?? "" : "";
}

function mutableRequestBaseOid(request: MutableCacheRequest): string | null {
  return "baseOid" in request ? request.baseOid : null;
}

function mutableRequestHeadOid(request: MutableCacheRequest): string | null {
  return "headOid" in request ? request.headOid : null;
}

function mutableRequestSearch(request: MutableCacheRequest): string {
  return "search" in request ? request.search ?? "" : "";
}

function mutableRequestChangeTypes(request: MutableCacheRequest): string[] {
  return "changeTypes" in request ? [...request.changeTypes].sort() : [];
}

function identitySnapshotChanged(
  previous: IdentitySnapshot | undefined,
  headVersion: string,
  baseVersion: string | undefined,
): boolean {
  if (!previous || previous.headVersion === headVersion) {
    return baseVersion !== undefined
      && previous?.baseVersion !== undefined
      && previous.baseVersion !== baseVersion;
  }
  return true;
}

function nextIdentitySnapshot(
  previous: IdentitySnapshot | undefined,
  headVersion: string,
  baseVersion: string | undefined,
  now: number,
): IdentitySnapshot {
  const retainedBaseVersion = baseVersion ?? previous?.baseVersion;
  return {
    headVersion,
    ...(retainedBaseVersion === undefined ? {} : { baseVersion: retainedBaseVersion }),
    staleAtMs: now + CACHE_TTL_MS,
  };
}

function safeError(error: unknown, signal: AbortSignal): PullRequestError {
  if (signal.aborted) {
    return { code: "cancelled", message: "The pull request request was cancelled." };
  }
  if (error instanceof GithubPullRequestClientError) {
    return {
      code: error.code,
      message: error.message.slice(0, 512),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
    };
  }
  return {
    code: "remote_unavailable",
    message: "Pull request data is unavailable.",
  };
}

/** Server-owned provider-neutral pull request capability and inbox read model. */
export class PullRequestService {
  private readonly now: () => number;
  private readonly cacheMaxEntries: number;
  private readonly detailCacheMaxBytes: number;
  private readonly patchCacheMaxBytes: number;
  private readonly patchFetchMaxConcurrency: number;
  private readonly patchFetchMaxQueued: number;
  private readonly identitySnapshotMaxEntries: number;
  private readonly listCache = new Map<string, CachedListResult>();
  private readonly mutableCache = new Map<string, CachedMutableRead>();
  private readonly identitySnapshots = new Map<string, IdentitySnapshot>();
  private readonly patchCache = new Map<string, CachedPatchRead>();
  private readonly patchFetches = new Map<string, SharedPatchFetch>();
  private readonly queuedPatchFetches: SharedPatchFetch[] = [];
  private readonly operations = new WeakMap<object, Map<string, AbortController>>();
  private mutableCacheBytes = 0;
  private patchCacheBytes = 0;
  private activePatchFetches = 0;
  private viewerCache: CachedViewer | null = null;
  private viewerInFlight: Promise<PullRequestViewerContext> | null = null;

  constructor(
    private readonly client: PullRequestRemoteClient,
    options: PullRequestServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cacheMaxEntries = Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
    this.detailCacheMaxBytes = Math.max(
      1,
      options.detailCacheMaxBytes ?? DEFAULT_DETAIL_CACHE_MAX_BYTES,
    );
    this.patchCacheMaxBytes = Math.max(
      1,
      options.patchCacheMaxBytes ?? DEFAULT_PATCH_CACHE_MAX_BYTES,
    );
    this.patchFetchMaxConcurrency = Math.max(
      1,
      options.patchFetchMaxConcurrency ?? DEFAULT_PATCH_FETCH_MAX_CONCURRENCY,
    );
    this.patchFetchMaxQueued = Math.max(
      0,
      options.patchFetchMaxQueued ?? DEFAULT_PATCH_FETCH_MAX_QUEUED,
    );
    this.identitySnapshotMaxEntries = Math.max(
      1,
      options.identitySnapshotMaxEntries ?? DEFAULT_IDENTITY_SNAPSHOT_MAX_ENTRIES,
    );
  }

  /** Load fresh bounded PR state for local Review task setup without using mutable caches. */
  async loadReviewTaskSource(
    identity: PullRequestIdentity,
  ): Promise<PullRequestReviewTaskSource> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const viewer = await this.getViewer(controller.signal);
      const [detail, checks, comments] = await Promise.all([
        this.client.getDetail({ viewer, identity, signal: controller.signal }),
        this.client.listChecks({
          viewer,
          identity,
          limit: 50,
          signal: controller.signal,
        }),
        this.client.listComments({
          viewer,
          identity,
          limit: 50,
          cursors: {},
          signal: controller.signal,
        }),
      ]);
      if (!detail.headRepositoryNodeId) {
        throw new GithubPullRequestClientError(
          "head_missing",
          "The pull request head repository is unavailable.",
        );
      }
      return {
        detail: detail.item,
        headRepositoryNodeId: detail.headRepositoryNodeId,
        checks: checks.items,
        unresolvedReviewThreads: comments.items.flatMap((item) =>
          item.kind === "review_thread" && !item.isResolved ? [item] : [],
        ),
        bounds: {
          checksHasNextPage: checks.hasNextPage,
          checksBoundedData: checks.boundedData,
          commentsHasNextPage: comments.hasNextPage,
          commentsBoundedData: comments.boundedData,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Resolve pull request capabilities for the active viewer. */
  async capabilities(
    request: PullRequestCapabilitiesRequest,
    connection: object = DEFAULT_CONNECTION,
  ): Promise<PullRequestCapabilitiesResult> {
    return this.runOperation(connection, request.operationId, async (signal) => {
      try {
        const viewer = await this.getViewer(signal);
        const fetchedAtMs = viewer.fetchedAt.getTime();
        return {
          ok: true as const,
          viewer: viewer.actor,
          capabilities: resolvePullRequestCapabilities(viewer),
          fetchedAt: new Date(fetchedAtMs).toISOString(),
          staleAt: new Date(fetchedAtMs + CACHE_TTL_MS).toISOString(),
        };
      } catch (error) {
        return { ok: false as const, error: safeError(error, signal) };
      }
    });
  }

  /** Load one bounded, cached pull request inbox page for the active viewer. */
  async list(
    request: PullRequestListRequest,
    connection: object = DEFAULT_CONNECTION,
  ): Promise<PullRequestListResult> {
    return this.runOperation(connection, request.operationId, async (signal) => {
      const fingerprint = requestFingerprint(request);
      const cursor = decodeCursor(request.cursor, fingerprint);
      if (!cursor) {
        return {
          ok: false as const,
          error: {
            code: "stale_cursor" as const,
            message: "The pull request cursor does not match this inbox query.",
          },
        };
      }

      try {
        const viewer = await this.getViewer(signal);
        const capabilities = resolvePullRequestCapabilities(viewer);
        const teamRequestsAllowed = capabilities.teamRequests.allowed;
        const cacheKey = this.cacheKey(viewer, request);
        const cached = this.readCachedList(cacheKey);
        if (cached) return cached;

        const effectiveRelationships = request.relationships.filter(
          (relationship) => teamRequestsAllowed || relationship !== "team_review_requested",
        );
        const page = effectiveRelationships.length === 0
          ? { buckets: {} }
          : await this.client.listPage({
              viewer,
              relationships: effectiveRelationships,
              states: request.states,
              search: request.search,
              limit: request.limit,
              cursors: cursor.cursors,
              teamRequestsAllowed,
              signal,
            });
        if (signal.aborted) {
          return {
            ok: false as const,
            error: {
              code: "cancelled" as const,
              message: "The pull request request was cancelled.",
            },
          };
        }

        const requestedRelationships = new Set(request.relationships);
        const items = mergePullRequestSummaries(page, teamRequestsAllowed, request.limit)
          .filter((item) => request.states.includes(item.state))
          .filter((item) => item.relationships.some((relationship) => requestedRelationships.has(relationship)))
          .filter((item) => searchMatches(item, request.search));
        const fetchedAtMs = this.now();
        const remoteCursors = nextRemoteCursors(page, cursor.cursors);
        const result: PullRequestListResult & { ok: true } = {
          ok: true,
          items,
          nextCursor: hasNextPage(page)
            ? encodeCursor(fingerprint, cursor.snapshotVersion, remoteCursors)
            : null,
          snapshotVersion: cursor.snapshotVersion,
          fetchedAt: new Date(fetchedAtMs).toISOString(),
          staleAt: new Date(fetchedAtMs + CACHE_TTL_MS).toISOString(),
          limitations:
            requestedRelationships.has("team_review_requested") && !teamRequestsAllowed
              ? [{ capability: "teamRequests", reason: "missing_scope" }]
              : [],
        };
        this.writeCachedList(
          cacheKey,
          viewer.actor.providerNodeId,
          result,
          fetchedAtMs + CACHE_TTL_MS,
        );
        return result;
      } catch (error) {
        return { ok: false as const, error: safeError(error, signal) };
      }
    });
  }

  /** Load cached pull request detail, checks, or comments for one stable identity. */
  async get(
    request: PullRequestGetRequest,
    connection: object = DEFAULT_CONNECTION,
  ): Promise<PullRequestGetResult> {
    return this.runOperation(connection, request.operationId, async (signal) => {
      try {
        return await this.getPullRequestResource(request, signal);
      } catch (error) {
        return { ok: false, error: safeError(error, signal) };
      }
    });
  }

  private async getPullRequestResource(
    request: PullRequestGetRequest,
    signal: AbortSignal,
  ): Promise<PullRequestGetResult> {
    const viewer = await this.getViewer(signal);
    const decoded = request.resource === "detail" ? null : decodeDetailCursor(request);
    if (decoded === undefined) return staleCursorResult("The pull request cursor does not match this detail query.") as PullRequestGetResult;
    const cacheKey = this.mutableCacheKey(viewer, request);
    const cached = this.readCachedMutable<PullRequestGetResult & { ok: true }>(cacheKey);
    if (cached) return cached;
    return this.getUncachedPullRequestResource(viewer, request, cacheKey, decoded, signal);
  }

  private getUncachedPullRequestResource(
    viewer: PullRequestViewerContext,
    request: PullRequestGetRequest,
    cacheKey: string,
    decoded: Exclude<ReturnType<typeof decodeDetailCursor>, undefined>,
    signal: AbortSignal,
  ): Promise<PullRequestGetResult> {
    if (request.resource === "detail") return this.getDetailResource(viewer, request, cacheKey, signal);
    const fingerprint = detailFingerprint(request);
    if (request.resource === "checks") {
      const cursor = decoded?.state.resource === "checks" ? decoded.state.cursor : undefined;
      return this.getChecksResource(viewer, request, cacheKey, fingerprint, decoded?.snapshotVersion, cursor, signal);
    }
    const cursors = decoded?.state.resource === "comments" ? decoded.state.cursors : {};
    return this.getCommentsResource(viewer, request, cacheKey, fingerprint, decoded?.snapshotVersion, cursors, signal);
  }

  private async getDetailResource(
    viewer: PullRequestViewerContext,
    request: Extract<PullRequestGetRequest, { resource: "detail" }>,
    cacheKey: string,
    signal: AbortSignal,
  ): Promise<PullRequestGetResult> {
    const remote = await this.client.getDetail({ viewer, identity: request.identity, signal });
    if (signal.aborted) return cancelledResult();
    const fetchedAtMs = this.now();
    const version = snapshotVersion(remote.snapshotMarker);
    this.recordIdentitySnapshot(request.identity, version);
    const result: PullRequestGetResult & { ok: true } = {
      ok: true, resource: "detail", item: remote.item, snapshotVersion: version,
      fetchedAt: new Date(fetchedAtMs).toISOString(), staleAt: new Date(fetchedAtMs + CACHE_TTL_MS).toISOString(),
      boundedData: remote.boundedData,
    };
    this.writeCachedMutable(cacheKey, pullRequestIdentityKey(request.identity), result, fetchedAtMs + CACHE_TTL_MS);
    return result;
  }

  private async getChecksResource(
    viewer: PullRequestViewerContext,
    request: Extract<PullRequestGetRequest, { resource: "checks" }>,
    cacheKey: string,
    fingerprint: string,
    expectedVersion: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<PullRequestGetResult> {
    const remote = await this.client.listChecks({ viewer, identity: request.identity, limit: request.limit,
      ...(cursor ? { cursor } : {}), signal });
    if (signal.aborted) return cancelledResult();
    const fetchedAtMs = this.now();
    const version = snapshotVersion(remote.snapshotMarker);
    if (expectedVersion && expectedVersion !== version) return staleCursorResult("The pull request checks changed while this page was loading.") as PullRequestGetResult;
    this.recordIdentitySnapshot(request.identity, version);
    const bounded = boundItemsByBytes(remote.items);
    const result: PullRequestGetResult & { ok: true } = {
      ok: true, resource: "checks", items: bounded.items,
      nextCursor: checksNextCursor(remote, bounded.boundedData, fingerprint, version), snapshotVersion: version,
      fetchedAt: new Date(fetchedAtMs).toISOString(), staleAt: new Date(fetchedAtMs + CACHE_TTL_MS).toISOString(),
      boundedData: strongerBoundedData(remote.boundedData, bounded.boundedData),
    };
    this.writeCachedMutable(cacheKey, pullRequestIdentityKey(request.identity), result, fetchedAtMs + CACHE_TTL_MS);
    return result;
  }

  private async getCommentsResource(
    viewer: PullRequestViewerContext,
    request: Extract<PullRequestGetRequest, { resource: "comments" }>,
    cacheKey: string,
    fingerprint: string,
    expectedVersion: string | undefined,
    cursors: PullRequestRemoteCommentCursorState,
    signal: AbortSignal,
  ): Promise<PullRequestGetResult> {
    const remote = await this.client.listComments({ viewer, identity: request.identity, limit: request.limit, cursors, signal });
    if (signal.aborted) return cancelledResult();
    const fetchedAtMs = this.now();
    const version = snapshotVersion(remote.snapshotMarker);
    if (expectedVersion && expectedVersion !== version) return staleCursorResult("The pull request comments changed while this page was loading.") as PullRequestGetResult;
    this.recordIdentitySnapshot(request.identity, snapshotVersion(remote.headMarker));
    const bounded = boundItemsByBytes(remote.items);
    assertGithubCommentsCursor(remote.hasNextPage, remote.cursors);
    const result: PullRequestGetResult & { ok: true } = {
      ok: true, resource: "comments", items: bounded.items,
      nextCursor: remote.hasNextPage && !bounded.boundedData ? encodeCommentsCursor(fingerprint, version, remote.cursors) : null,
      snapshotVersion: version, fetchedAt: new Date(fetchedAtMs).toISOString(),
      staleAt: new Date(fetchedAtMs + CACHE_TTL_MS).toISOString(),
      boundedData: strongerBoundedData(remote.boundedData, bounded.boundedData),
    };
    this.writeCachedMutable(cacheKey, pullRequestIdentityKey(request.identity), result, fetchedAtMs + CACHE_TTL_MS);
    return result;
  }

  /** Load one cached initial, older, or newer pull request Timeline page. */
  async timeline(
    request: PullRequestTimelineRequest,
    connection: object = DEFAULT_CONNECTION,
  ): Promise<PullRequestTimelineResult> {
    return this.runOperation(connection, request.operationId, async (signal) => {
      const decoded = decodeTimelineCursor(request);
      if (decoded === undefined) {
        return staleCursorResult(
          "The pull request cursor does not match this Timeline lane.",
        ) as PullRequestTimelineResult;
      }
      try {
        return await this.getTimelineResource(request, decoded, signal);
      } catch (error) {
        return { ok: false, error: safeError(error, signal) };
      }
    });
  }

  private async getTimelineResource(
    request: PullRequestTimelineRequest,
    decoded: Exclude<ReturnType<typeof decodeTimelineCursor>, undefined>,
    signal: AbortSignal,
  ): Promise<PullRequestTimelineResult> {
    const viewer = await this.getViewer(signal);
    const cacheKey = this.mutableCacheKey(viewer, request);
    const cached = this.readCachedMutable<PullRequestTimelineResult & { ok: true }>(cacheKey);
    if (cached) return cached;
    const remote = await this.client.listTimeline({ viewer, identity: request.identity, lane: request.lane,
      limit: request.limit, ...(decoded ? { cursor: decoded.cursor } : {}), signal });
    if (signal.aborted) return cancelledTimelineResult();
    const version = snapshotVersion(remote.snapshotMarker);
    const headVersion = snapshotVersion(remote.headMarker);
    if (timelineCursorVersionChanged(decoded, request.lane, version, headVersion)) {
      return staleCursorResult("The pull request Timeline changed while this page was loading.") as PullRequestTimelineResult;
    }
    this.recordIdentitySnapshot(request.identity, headVersion);
    const bounded = boundItemsByBytes(remote.items);
    const cursors = timelinePageCursors(request, remote, bounded.boundedData, version, headVersion);
    const fetchedAtMs = this.now();
    const result: PullRequestTimelineResult & { ok: true } = {
      ok: true, lane: request.lane, items: bounded.items, olderCursor: cursors.older, newerCursor: cursors.newer,
      hasMoreOlder: cursors.hasMoreOlder, hasMoreNewer: cursors.hasMoreNewer, snapshotVersion: version,
      fetchedAt: new Date(fetchedAtMs).toISOString(), staleAt: new Date(fetchedAtMs + CACHE_TTL_MS).toISOString(),
      boundedData: strongerBoundedData(remote.boundedData, bounded.boundedData),
    };
    this.writeCachedMutable(cacheKey, pullRequestIdentityKey(request.identity), result, fetchedAtMs + CACHE_TTL_MS);
    return result;
  }

  /** Load one bounded, filtered page of snapshot-qualified changed files. */
  async files(
    request: PullRequestFilesRequest,
    connection: object = DEFAULT_CONNECTION,
  ): Promise<PullRequestFilesResult> {
    return this.runOperation(connection, request.operationId, async (signal) => {
      try {
        return await this.getFilesResource(request, signal);
      } catch (error) {
        return { ok: false, error: safeError(error, signal) };
      }
    });
  }

  private async getFilesResource(
    request: PullRequestFilesRequest,
    signal: AbortSignal,
  ): Promise<PullRequestFilesResult> {
    const decoded = decodeFilesCursor(request);
    if (!decoded) return staleFilesCursorResult();
    const viewer = await this.getViewer(signal);
    const cacheKey = this.mutableCacheKey(viewer, request);
    const cached = this.readCachedMutable<PullRequestFilesResult & { ok: true }>(cacheKey);
    if (cached) return cached;
    const scan = await this.scanPullRequestFiles(viewer, request, decoded, signal);
    const fetchedAtMs = this.now();
    const result: PullRequestFilesResult & { ok: true } = {
      ok: true,
      items: scan.items,
      nextCursor: scan.nextState ? encodeFilesCursor(request, scan.nextState.page, scan.nextState.offset) : null,
      baseOid: request.baseOid,
      headOid: request.headOid,
      snapshotVersion: snapshotVersion(`${request.baseOid}\0${request.headOid}`),
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      staleAt: new Date(fetchedAtMs + CACHE_TTL_MS).toISOString(),
      boundedData: scan.boundedData,
    };
    this.writeCachedMutable(cacheKey, pullRequestIdentityKey(request.identity), result, fetchedAtMs + CACHE_TTL_MS);
    return result;
  }

  private async scanPullRequestFiles(
    viewer: PullRequestViewerContext,
    request: PullRequestFilesRequest,
    decoded: Exclude<ReturnType<typeof decodeFilesCursor>, null>,
    signal: AbortSignal,
  ): Promise<FileScanState> {
    const state: FileScanState = { items: [], page: decoded.page, offset: decoded.offset, nextState: null, boundedData: null, scannedPages: 0 };
    while (state.scannedPages < FILE_SCAN_MAX_PAGES) {
      state.nextState = null;
      const remote = await this.client.listFiles({ viewer, identity: request.identity, page: state.page, signal });
      this.assertFileScanSnapshot(request, remote, signal);
      if (appendMatchingFiles(state, remote, request)) break;
      state.scannedPages += 1;
      if (remote.providerLimitReached) {
        state.boundedData = { reason: "provider_limit" };
        break;
      }
      if (!remote.hasNextPage || state.page >= GITHUB_FILES_MAX_PAGES) break;
      state.page += 1;
      state.offset = 0;
      state.nextState = { page: state.page, offset: state.offset };
    }
    if (state.nextState && state.scannedPages >= FILE_SCAN_MAX_PAGES && state.items.length < request.limit) {
      state.boundedData = { reason: "catch_up_limit" };
    }
    return state;
  }

  private assertFileScanSnapshot(
    request: PullRequestFilesRequest,
    remote: Awaited<ReturnType<PullRequestRemoteClient["listFiles"]>>,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) throw new GithubPullRequestClientError("cancelled", "The pull request request was cancelled.");
    this.recordIdentitySnapshot(request.identity, snapshotVersion(remote.headOid), snapshotVersion(remote.baseOid));
    if (remote.baseOid !== request.baseOid || remote.headOid !== request.headOid) {
      throw new GithubPullRequestClientError("conflict", "The pull request comparison changed while files were loading.");
    }
  }

  /** Load one immutable, snapshot-qualified changed-file patch. */
  async patch(
    request: PullRequestPatchRequest,
    connection: object = DEFAULT_CONNECTION,
  ): Promise<PullRequestPatchResult> {
    return this.runOperation(connection, request.operationId, async (signal) => {
      try {
        const locator = decodePullRequestFileLocator(request.locator);
        if (!locator) {
          throw new GithubPullRequestClientError(
            "invalid_input",
            "The changed-file locator is invalid.",
          );
        }
        const viewer = await this.getViewer(signal);
        const cacheKey = this.patchCacheKey(viewer, request);
        const cached = this.readCachedPatch(cacheKey);
        if (cached) return cached;
        const remote = await this.loadSharedPatch(
          cacheKey,
          {
            viewer,
            identity: request.identity,
            baseOid: request.baseOid,
            headOid: request.headOid,
            position: locator.position,
            fingerprint: locator.fingerprint,
          },
          signal,
        );
        if (remote.kind === "snapshot_changed") {
          this.recordIdentitySnapshot(
            request.identity,
            snapshotVersion(remote.headOid),
            snapshotVersion(remote.baseOid),
          );
          return {
            ok: false,
            error: {
              code: "conflict",
              message: "The pull request comparison changed while the patch was loading.",
            },
          };
        }
        if (remote.baseOid !== request.baseOid || remote.headOid !== request.headOid) {
          throw new GithubPullRequestClientError(
            "remote_unavailable",
            "GitHub returned a mismatched pull request patch snapshot.",
          );
        }
        this.recordIdentitySnapshot(
          request.identity,
          snapshotVersion(remote.headOid),
          snapshotVersion(remote.baseOid),
        );
        const fetchedAtMs = this.now();
        const result = this.createPatchResult(request, remote, fetchedAtMs);
        this.writeCachedPatch(
          cacheKey,
          pullRequestIdentityKey(request.identity),
          result,
          fetchedAtMs + PATCH_CACHE_TTL_MS,
        );
        return result;
      } catch (error) {
        return { ok: false, error: safeError(error, signal) };
      }
    });
  }

  private createPatchResult(
    request: PullRequestPatchRequest,
    remote: Extract<PullRequestRemotePatchResult, { kind: "patch" }>,
    fetchedAtMs: number,
  ): PullRequestPatchResult & { ok: true } {
    const common = {
      ok: true as const,
      locator: request.locator,
      path: remote.file.path,
      previousPath: remote.file.previousPath,
      changeType: remote.file.changeType,
      blobOid: remote.file.blobOid,
      baseOid: remote.baseOid,
      headOid: remote.headOid,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      staleAt: new Date(fetchedAtMs + PATCH_CACHE_TTL_MS).toISOString(),
    };
    if (remote.status !== "available" && remote.status !== "generated") {
      return { ...common, status: remote.status, patch: null, parsedLineCount: null };
    }
    if (remote.patch === null || remote.parsedLineCount === null) {
      throw new GithubPullRequestClientError("remote_unavailable", "GitHub returned an incomplete pull request patch.");
    }
    return { ...common, status: remote.status, patch: remote.patch, parsedLineCount: remote.parsedLineCount };
  }

  /** Cancel one active operation owned by the same WebSocket connection. */
  cancel(connection: object, operationId: string): PullRequestCancelResult {
    const operation = this.operations.get(connection)?.get(operationId);
    if (!operation) return { ok: true, cancelled: false };
    operation.abort();
    this.operations.get(connection)?.delete(operationId);
    return { ok: true, cancelled: true };
  }

  /** Invalidate every cached read affected by a successful remote mutation. */
  invalidateAfterMutation(viewerNodeId: string, identity: PullRequestIdentity): void {
    for (const [key, cached] of this.listCache) {
      if (cached.viewerNodeId === viewerNodeId) this.listCache.delete(key);
    }
    const key = pullRequestIdentityKey(identity);
    this.identitySnapshots.delete(key);
    this.invalidateMutableIdentity(key);
    this.invalidatePatchIdentity(key);
  }

  private async getViewer(signal: AbortSignal): Promise<PullRequestViewerContext> {
    const now = this.now();
    if (this.viewerCache && now < this.viewerCache.staleAtMs) {
      if (signal.aborted) {
        throw new GithubPullRequestClientError(
          "cancelled",
          "The pull request request was cancelled.",
        );
      }
      return this.viewerCache.viewer;
    }
    if (!this.viewerInFlight) {
      const sharedController = new AbortController();
      const lookup = this.client.getViewer(sharedController.signal).then((viewer) => {
        this.viewerCache = { viewer, staleAtMs: this.now() + CACHE_TTL_MS };
        return viewer;
      });
      this.viewerInFlight = lookup;
      void lookup.then(
        () => {
          if (this.viewerInFlight === lookup) this.viewerInFlight = null;
        },
        () => {
          if (this.viewerInFlight === lookup) this.viewerInFlight = null;
        },
      );
    }
    return this.waitForViewer(this.viewerInFlight, signal);
  }

  private waitForViewer(
    lookup: Promise<PullRequestViewerContext>,
    signal: AbortSignal,
  ): Promise<PullRequestViewerContext> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        complete: (value: PullRequestViewerContext) => void,
        viewer: PullRequestViewerContext,
      ) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        complete(viewer);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = () => {
        fail(new GithubPullRequestClientError(
          "cancelled",
          "The pull request request was cancelled.",
        ));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void lookup.then(
        (viewer) => finish(resolve, viewer),
        (error: unknown) => fail(error),
      );
    });
  }

  private patchCacheKey(
    viewer: PullRequestViewerContext,
    request: PullRequestPatchRequest,
  ): string {
    return JSON.stringify({
      viewer: viewer.actor.providerNodeId,
      identity: request.identity,
      baseOid: request.baseOid,
      headOid: request.headOid,
      locator: request.locator,
    });
  }

  private readCachedPatch(key: string): (PullRequestPatchResult & { ok: true }) | null {
    const cached = this.patchCache.get(key);
    if (!cached) return null;
    if (this.now() >= cached.staleAtMs) {
      this.deleteCachedPatch(key, cached);
      return null;
    }
    this.patchCache.delete(key);
    this.patchCache.set(key, cached);
    return cached.result;
  }

  private writeCachedPatch(
    key: string,
    identityKey: string,
    result: PullRequestPatchResult & { ok: true },
    staleAtMs: number,
  ): void {
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const existing = this.patchCache.get(key);
    if (existing) this.deleteCachedPatch(key, existing);
    if (bytes > this.patchCacheMaxBytes) return;
    this.patchCache.set(key, { result, staleAtMs, bytes, identityKey });
    this.patchCacheBytes += bytes;
    while (this.patchCacheBytes > this.patchCacheMaxBytes) {
      const oldest = this.patchCache.entries().next().value as
        | [string, CachedPatchRead]
        | undefined;
      if (!oldest) break;
      this.deleteCachedPatch(oldest[0], oldest[1]);
    }
  }

  private deleteCachedPatch(key: string, cached: CachedPatchRead): void {
    if (!this.patchCache.delete(key)) return;
    this.patchCacheBytes = Math.max(0, this.patchCacheBytes - cached.bytes);
  }

  private loadSharedPatch(
    key: string,
    request: Omit<Parameters<PullRequestRemoteClient["getPatch"]>[0], "signal">,
    signal: AbortSignal,
  ): Promise<PullRequestRemotePatchResult> {
    let shared = this.patchFetches.get(key);
    if (shared?.controller.signal.aborted) {
      this.patchFetches.delete(key);
      shared = undefined;
    }
    if (!shared) {
      if (
        this.activePatchFetches >= this.patchFetchMaxConcurrency
        && this.queuedPatchFetches.length >= this.patchFetchMaxQueued
      ) {
        throw new GithubPullRequestClientError(
          "rate_limited",
          "Too many pull request patches are loading. Try again shortly.",
          1,
        );
      }
      const controller = new AbortController();
      let resolve!: (result: PullRequestRemotePatchResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<PullRequestRemotePatchResult>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      shared = {
        key,
        controller,
        promise,
        resolve,
        reject,
        request,
        state: "queued",
        waiters: 0,
        identityKey: pullRequestIdentityKey(request.identity),
      };
      this.patchFetches.set(key, shared);
      controller.signal.addEventListener("abort", () => {
        if (shared?.state !== "queued") return;
        shared.state = "settled";
        const queuedIndex = this.queuedPatchFetches.indexOf(shared);
        if (queuedIndex >= 0) this.queuedPatchFetches.splice(queuedIndex, 1);
        if (this.patchFetches.get(key) === shared) this.patchFetches.delete(key);
        shared.reject(new GithubPullRequestClientError(
          "cancelled",
          "The pull request request was cancelled.",
        ));
        this.drainPatchFetchQueue();
      }, { once: true });
      if (this.activePatchFetches < this.patchFetchMaxConcurrency) {
        this.startPatchFetch(shared);
      } else {
        this.queuedPatchFetches.push(shared);
      }
    }
    return this.waitForSharedPatch(shared, signal);
  }

  private startPatchFetch(shared: SharedPatchFetch): void {
    if (shared.state !== "queued") return;
    if (shared.controller.signal.aborted) {
      shared.reject(new GithubPullRequestClientError(
        "cancelled",
        "The pull request request was cancelled.",
      ));
      return;
    }
    shared.state = "active";
    this.activePatchFetches += 1;
    void Promise.resolve()
      .then(() => this.client.getPatch({
        ...shared.request,
        signal: shared.controller.signal,
      }))
      .then(shared.resolve, shared.reject)
      .finally(() => {
        shared.state = "settled";
        this.activePatchFetches = Math.max(0, this.activePatchFetches - 1);
        if (this.patchFetches.get(shared.key) === shared) {
          this.patchFetches.delete(shared.key);
        }
        this.drainPatchFetchQueue();
      });
  }

  private drainPatchFetchQueue(): void {
    while (
      this.activePatchFetches < this.patchFetchMaxConcurrency
      && this.queuedPatchFetches.length > 0
    ) {
      const shared = this.queuedPatchFetches.shift();
      if (!shared || shared.state !== "queued") continue;
      this.startPatchFetch(shared);
    }
  }

  private waitForSharedPatch(
    shared: SharedPatchFetch,
    signal: AbortSignal,
  ): Promise<PullRequestRemotePatchResult> {
    shared.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = (cancelShared: boolean) => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        shared.waiters = Math.max(0, shared.waiters - 1);
        if (cancelShared && shared.waiters === 0) shared.controller.abort();
        return true;
      };
      const onAbort = () => {
        if (!release(true)) return;
        reject(new GithubPullRequestClientError(
          "cancelled",
          "The pull request request was cancelled.",
        ));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void shared.promise.then(
        (result) => {
          if (release(false)) resolve(result);
        },
        (error: unknown) => {
          if (release(false)) reject(error);
        },
      );
    });
  }

  private cacheKey(viewer: PullRequestViewerContext, request: PullRequestListRequest): string {
    return JSON.stringify({
      viewer: viewer.actor.providerNodeId,
      provider: request.provider,
      relationships: [...request.relationships].sort(),
      states: [...request.states].sort(),
      search: request.search ?? "",
      limit: request.limit,
      cursor: request.cursor ?? "",
    });
  }

  private readCachedList(key: string): (PullRequestListResult & { ok: true }) | null {
    const cached = this.listCache.get(key);
    if (!cached) return null;
    if (this.now() >= cached.staleAtMs) {
      this.listCache.delete(key);
      return null;
    }
    this.listCache.delete(key);
    this.listCache.set(key, cached);
    return cached.result;
  }

  private writeCachedList(
    key: string,
    viewerNodeId: string,
    result: PullRequestListResult & { ok: true },
    staleAtMs: number,
  ): void {
    this.listCache.delete(key);
    this.listCache.set(key, { result, staleAtMs, viewerNodeId });
    while (this.listCache.size > this.cacheMaxEntries) {
      const oldestKey = this.listCache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.listCache.delete(oldestKey);
    }
  }

  private mutableCacheKey(
    viewer: PullRequestViewerContext,
    request: PullRequestGetRequest | PullRequestTimelineRequest | PullRequestFilesRequest,
  ): string {
    return JSON.stringify({
      viewer: viewer.actor.providerNodeId,
      identity: request.identity,
      lane: mutableResourceLane(request),
      limit: mutableRequestLimit(request),
      cursor: mutableRequestCursor(request),
      baseOid: mutableRequestBaseOid(request),
      headOid: mutableRequestHeadOid(request),
      search: mutableRequestSearch(request),
      changeTypes: mutableRequestChangeTypes(request),
    });
  }

  private readCachedMutable<T extends CachedMutableResult>(key: string): T | null {
    const cached = this.mutableCache.get(key);
    if (!cached) return null;
    if (this.now() >= cached.staleAtMs) {
      this.deleteCachedMutable(key, cached);
      return null;
    }
    this.mutableCache.delete(key);
    this.mutableCache.set(key, cached);
    return cached.result as T;
  }

  private writeCachedMutable(
    key: string,
    identity: string,
    result: CachedMutableResult,
    staleAtMs: number,
  ): void {
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const existing = this.mutableCache.get(key);
    if (existing) this.deleteCachedMutable(key, existing);
    if (bytes > this.detailCacheMaxBytes) return;
    this.mutableCache.set(key, {
      result,
      staleAtMs,
      bytes,
      identityKey: identity,
    });
    this.mutableCacheBytes += bytes;
    while (this.mutableCacheBytes > this.detailCacheMaxBytes) {
      const oldest = this.mutableCache.entries().next().value as
        | [string, CachedMutableRead]
        | undefined;
      if (!oldest) break;
      this.deleteCachedMutable(oldest[0], oldest[1]);
    }
  }

  private deleteCachedMutable(key: string, cached: CachedMutableRead): void {
    if (!this.mutableCache.delete(key)) return;
    this.mutableCacheBytes = Math.max(0, this.mutableCacheBytes - cached.bytes);
  }

  private recordIdentitySnapshot(
    identity: PullRequestIdentity,
    headVersion: string,
    baseVersion?: string,
  ): void {
    const key = pullRequestIdentityKey(identity);
    const now = this.now();
    this.evictStaleIdentitySnapshots(now);
    const previous = this.identitySnapshots.get(key);
    if (identitySnapshotChanged(previous, headVersion, baseVersion)) {
      this.invalidateMutableIdentity(key);
      this.invalidatePatchIdentity(key);
    }
    this.identitySnapshots.delete(key);
    this.identitySnapshots.set(key, nextIdentitySnapshot(previous, headVersion, baseVersion, now));
    this.enforceIdentitySnapshotLimit();
  }

  private evictStaleIdentitySnapshots(now: number): void {
    for (const [key, snapshot] of this.identitySnapshots) {
      if (now >= snapshot.staleAtMs) this.evictIdentitySnapshot(key);
    }
  }

  private enforceIdentitySnapshotLimit(): void {
    while (this.identitySnapshots.size > this.identitySnapshotMaxEntries) {
      const oldestKey = this.identitySnapshots.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.evictIdentitySnapshot(oldestKey);
    }
  }

  private evictIdentitySnapshot(key: string): void {
    if (!this.identitySnapshots.delete(key)) return;
    this.invalidateMutableIdentity(key);
  }

  private invalidateMutableIdentity(identityKey: string): void {
    for (const [cacheKey, cached] of this.mutableCache) {
      if (cached.identityKey === identityKey) this.deleteCachedMutable(cacheKey, cached);
    }
  }

  private invalidatePatchIdentity(identityKey: string): void {
    for (const [cacheKey, cached] of this.patchCache) {
      if (cached.identityKey === identityKey) this.deleteCachedPatch(cacheKey, cached);
    }
    for (const [fetchKey, shared] of this.patchFetches) {
      if (shared.identityKey !== identityKey) continue;
      shared.controller.abort();
      this.patchFetches.delete(fetchKey);
    }
  }

  private async runOperation<T>(
    connection: object,
    operationId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let connectionOperations = this.operations.get(connection);
    if (!connectionOperations) {
      connectionOperations = new Map();
      this.operations.set(connection, connectionOperations);
    }
    connectionOperations.get(operationId)?.abort();
    const controller = new AbortController();
    connectionOperations.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (connectionOperations.get(operationId) === controller) {
        connectionOperations.delete(operationId);
      }
    }
  }
}
