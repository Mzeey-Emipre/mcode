import type {
  PullRequestBoundedDataMarker,
  PullRequestCheck,
  PullRequestConversationItem,
  PullRequestDetail,
  PullRequestError,
  PullRequestGetResource,
  PullRequestIdentity,
  PullRequestTimelineItem,
} from "@mcode/contracts";
import { create } from "zustand";
import {
  getPullRequestTransport,
  type PullRequestTransport,
} from "@/transport/pull-requests";

const MAX_DETAIL_ENTRIES = 25;
const MAX_DETAIL_RECORDS = 1_000;
const MAX_DETAIL_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 8 * 1024 * 1024;
const TIMELINE_CATCH_UP_PAGES = 4;
const DETAIL_PAGE_SIZE = 30;

/** Independently cancellable pull request detail read lane. */
export type PullRequestDetailLane =
  | "detail"
  | "checks"
  | "comments"
  | "timelineInitial"
  | "timelineOlder"
  | "timelineNewer";

/** Request status for one pull request detail read lane. */
export type PullRequestDetailLaneStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refreshing"
  | "error";

/** Freshness, cancellation, and bounded-data state owned by one read lane. */
export interface PullRequestDetailLaneState {
  status: PullRequestDetailLaneStatus;
  operationId: string | null;
  generation: number;
  error: PullRequestError | null;
  stale: boolean;
  fetchedAt: number | null;
  staleAt: number | null;
  boundedData: PullRequestBoundedDataMarker | null;
}

/** Incremental UTF-8 byte estimates for one cached pull request identity. */
export interface PullRequestDetailByteSizes {
  base: number;
  detail: number;
  checks: number;
  comments: number;
  timeline: number;
}

/** One bounded, independently refreshed pull request detail cache entry. */
export interface PullRequestDetailEntry {
  identity: PullRequestIdentity;
  detail: PullRequestDetail | null;
  checks: PullRequestCheck[];
  checksNextCursor: string | null;
  comments: PullRequestConversationItem[];
  commentsNextCursor: string | null;
  timeline: PullRequestTimelineItem[];
  olderCursor: string | null;
  newerCursor: string | null;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  lanes: Record<PullRequestDetailLane, PullRequestDetailLaneState>;
  lastAccessedAt: number;
  byteSizes: PullRequestDetailByteSizes;
  estimatedBytes: number;
}

/** Public state and actions for bounded pull request detail reads. */
export interface PullRequestDetailStoreState {
  entries: Record<string, PullRequestDetailEntry>;
  activeKey: string | null;
  /** Open one identity and cancel only operations owned by the previously open identity. */
  open: (identity: PullRequestIdentity, transport?: PullRequestTransport) => void;
  /** Close detail and cancel only operations owned by the open identity. */
  close: (transport?: PullRequestTransport) => void;
  /** Mark an entry as recently used without changing the active identity. */
  touch: (key: string) => void;
  /** Load or refresh the persistent detail core for the open identity. */
  loadDetail: (transport?: PullRequestTransport) => Promise<void>;
  /** Load or append the checks lane for the open identity. */
  loadChecks: (options?: PullRequestPageLoadOptions) => Promise<void>;
  /** Load or append the comments lane for the open identity. */
  loadComments: (options?: PullRequestPageLoadOptions) => Promise<void>;
  /** Load the most recent Timeline page for the open identity. */
  loadTimeline: (transport?: PullRequestTransport) => Promise<void>;
  /** Prepend one older Timeline page for the open identity. */
  loadOlderTimeline: (transport?: PullRequestTransport) => Promise<void>;
  /** Catch up newer Timeline pages, capped at four pages per active refresh. */
  catchUpTimeline: (transport?: PullRequestTransport) => Promise<void>;
  /** Refresh stale loaded lanes for the open identity without overlapping a lane. */
  refreshActive: (options?: PullRequestRefreshOptions) => Promise<void>;
  /** Mark one identity stale and refresh every loaded lane after a remote mutation. */
  invalidateAfterMutation: (
    identity: PullRequestIdentity,
    transport?: PullRequestTransport,
  ) => Promise<void>;
  /** Cancel every active lane owned by the open identity. */
  cancelActive: (transport?: PullRequestTransport) => Promise<void>;
  /** Cancel every active lane owned by one cached identity. */
  cancelEntry: (key: string, transport?: PullRequestTransport) => Promise<void>;
  /** Clear the bounded detail cache and cancel its active operations. */
  reset: (transport?: PullRequestTransport) => void;
}

/** Options for a checks or comments page load. */
export interface PullRequestPageLoadOptions {
  append?: boolean;
  transport?: PullRequestTransport;
}

/** Options for refreshing the selected pull request detail. */
export interface PullRequestRefreshOptions {
  force?: boolean;
  transport?: PullRequestTransport;
}

interface StartedLane {
  key: string;
  identity: PullRequestIdentity;
  operationId: string;
  generation: number;
}

interface Freshness {
  fetchedAt: string;
  staleAt: string;
  boundedData: PullRequestBoundedDataMarker | null;
}

const BOUNDED_DATA_PRIORITY: Record<
  PullRequestBoundedDataMarker["reason"],
  number
> = {
  catch_up_limit: 1,
  record_limit: 2,
  byte_limit: 3,
  provider_limit: 4,
};

function strongerBoundedData(
  current: PullRequestBoundedDataMarker | null,
  next: PullRequestBoundedDataMarker | null,
): PullRequestBoundedDataMarker | null {
  if (!current) return next;
  if (!next) return current;
  return BOUNDED_DATA_PRIORITY[next.reason] >
    BOUNDED_DATA_PRIORITY[current.reason]
    ? next
    : current;
}

let operationSequence = 0;

/** Return the stable cache key for a provider-neutral pull request identity. */
export function getPullRequestDetailKey(identity: PullRequestIdentity): string {
  return `${identity.provider}:${identity.repositoryNodeId}:${identity.number}`;
}

function emptyLane(): PullRequestDetailLaneState {
  return {
    status: "idle",
    operationId: null,
    generation: 0,
    error: null,
    stale: false,
    fetchedAt: null,
    staleAt: null,
    boundedData: null,
  };
}

function createEntry(identity: PullRequestIdentity): PullRequestDetailEntry {
  const entry: PullRequestDetailEntry = {
    identity,
    detail: null,
    checks: [],
    checksNextCursor: null,
    comments: [],
    commentsNextCursor: null,
    timeline: [],
    olderCursor: null,
    newerCursor: null,
    hasMoreOlder: false,
    hasMoreNewer: false,
    lanes: {
      detail: emptyLane(),
      checks: emptyLane(),
      comments: emptyLane(),
      timelineInitial: emptyLane(),
      timelineOlder: emptyLane(),
      timelineNewer: emptyLane(),
    },
    lastAccessedAt: Date.now(),
    byteSizes: { base: 0, detail: 0, checks: 2, comments: 2, timeline: 2 },
    estimatedBytes: 0,
  };
  return withByteSizes(entry);
}

function operationId(lane: PullRequestDetailLane): string {
  operationSequence += 1;
  return `pr-${lane}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function laneHasData(entry: PullRequestDetailEntry, lane: PullRequestDetailLane): boolean {
  if (lane === "detail") {
    return entry.detail !== null && entry.lanes.detail.fetchedAt !== null;
  }
  if (lane === "checks" || lane === "comments") {
    return entry.lanes[lane].fetchedAt !== null;
  }
  return (
    entry.lanes.timelineInitial.fetchedAt !== null ||
    entry.lanes[lane].fetchedAt !== null
  );
}

function estimateValueBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function estimateBaseBytes(entry: PullRequestDetailEntry): number {
  return estimateValueBytes({
    identity: entry.identity,
    checksNextCursor: entry.checksNextCursor,
    commentsNextCursor: entry.commentsNextCursor,
    olderCursor: entry.olderCursor,
    newerCursor: entry.newerCursor,
  });
}

function withByteSizes(
  entry: PullRequestDetailEntry,
  updates: Partial<Omit<PullRequestDetailByteSizes, "base">> = {},
): PullRequestDetailEntry {
  const byteSizes: PullRequestDetailByteSizes = {
    ...entry.byteSizes,
    ...updates,
    base: estimateBaseBytes(entry),
  };
  return {
    ...entry,
    byteSizes,
    estimatedBytes:
      byteSizes.base +
      byteSizes.detail +
      byteSizes.checks +
      byteSizes.comments +
      byteSizes.timeline,
  };
}

function entryRecordCount(entry: PullRequestDetailEntry): number {
  const nestedReviewComments = entry.comments.reduce(
    (total, item) => total + (item.kind === "review_thread" ? item.comments.length : 0),
    0,
  );
  const nestedTimelineComments = entry.timeline.reduce(
    (total, item) => total + (item.kind === "review_thread" ? item.comments.length : 0),
    0,
  );
  return (
    entry.checks.length +
    entry.comments.length +
    nestedReviewComments +
    entry.timeline.length +
    nestedTimelineComments
  );
}

function activeOperationIds(entry: PullRequestDetailEntry | undefined): string[] {
  if (!entry) return [];
  return Object.values(entry.lanes).flatMap((lane) =>
    lane.operationId ? [lane.operationId] : [],
  );
}

function clearOperations(entry: PullRequestDetailEntry): PullRequestDetailEntry {
  const lanes = Object.fromEntries(
    Object.entries(entry.lanes).map(([name, lane]) => [
      name,
      {
        ...lane,
        operationId: null,
        generation: lane.generation + (lane.operationId ? 1 : 0),
        status: laneHasData(entry, name as PullRequestDetailLane) ? "ready" : "idle",
      },
    ]),
  ) as Record<PullRequestDetailLane, PullRequestDetailLaneState>;
  return { ...entry, lanes };
}

function invalidateHeadDependentLanes(entry: PullRequestDetailEntry): {
  entry: PullRequestDetailEntry;
  operationIds: string[];
} {
  const dependentLanes: PullRequestDetailLane[] = [
    "checks",
    "comments",
    "timelineInitial",
    "timelineOlder",
    "timelineNewer",
  ];
  const operationIds = dependentLanes.flatMap((name) => {
    const id = entry.lanes[name].operationId;
    return id ? [id] : [];
  });
  const lanes = { ...entry.lanes };
  for (const name of dependentLanes) {
    lanes[name] = {
      ...emptyLane(),
      generation: entry.lanes[name].generation + 1,
    };
  }
  const invalidated: PullRequestDetailEntry = {
    ...entry,
    checks: [],
    checksNextCursor: null,
    comments: [],
    commentsNextCursor: null,
    timeline: [],
    olderCursor: null,
    newerCursor: null,
    hasMoreOlder: false,
    hasMoreNewer: false,
    lanes,
    byteSizes: {
      ...entry.byteSizes,
      checks: 2,
      comments: 2,
      timeline: 2,
    },
  };
  return { entry: withByteSizes(invalidated), operationIds };
}

async function cancelOperations(
  ids: readonly string[],
  transport: PullRequestTransport,
): Promise<void> {
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        await transport.cancel({ operationId: id });
      } catch {
        // Local identity changes must remain responsive when cancellation races disconnect.
      }
    }),
  );
}

function evictEntries(
  entries: Record<string, PullRequestDetailEntry>,
  protectedKey: string | null,
): { entries: Record<string, PullRequestDetailEntry>; operationIds: string[] } {
  const next = { ...entries };
  const operationIds: string[] = [];
  const totalBytes = () =>
    Object.values(next).reduce((total, entry) => total + entry.estimatedBytes, 0);
  const totalRecords = () =>
    Object.values(next).reduce((total, entry) => total + entryRecordCount(entry), 0);
  const candidates = () =>
    Object.entries(next)
      .filter(([key]) => key !== protectedKey)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);

  while (
    Object.keys(next).length > MAX_DETAIL_ENTRIES ||
    totalBytes() > MAX_DETAIL_BYTES ||
    totalRecords() > MAX_DETAIL_RECORDS
  ) {
    const oldest = candidates()[0];
    if (!oldest) break;
    operationIds.push(...activeOperationIds(oldest[1]));
    delete next[oldest[0]];
  }
  return { entries: next, operationIds };
}

function normalizeError(error: unknown): PullRequestError {
  return {
    code: "remote_unavailable",
    message:
      error instanceof Error
        ? error.message.slice(0, 512)
        : "Pull request detail is unavailable.",
  };
}

function laneStillOwns(
  started: StartedLane,
  laneName: PullRequestDetailLane,
): boolean {
  const entry = usePullRequestDetailStore.getState().entries[started.key];
  if (!entry) return false;
  const lane = entry.lanes[laneName];
  return (
    lane?.operationId === started.operationId &&
    lane.generation === started.generation
  );
}

function beginLane(laneName: PullRequestDetailLane): StartedLane | null {
  const state = usePullRequestDetailStore.getState();
  const key = state.activeKey;
  const entry = key ? state.entries[key] : undefined;
  if (!key || !entry || entry.lanes[laneName].operationId) return null;

  const id = operationId(laneName);
  const generation = entry.lanes[laneName].generation + 1;
  usePullRequestDetailStore.setState({
    entries: {
      ...state.entries,
      [key]: {
        ...entry,
        lastAccessedAt: Date.now(),
        lanes: {
          ...entry.lanes,
          [laneName]: {
            ...entry.lanes[laneName],
            status: laneHasData(entry, laneName) ? "refreshing" : "loading",
            operationId: id,
            generation,
            error: null,
          },
        },
      },
    },
  });
  return { key, identity: entry.identity, operationId: id, generation };
}

function currentLane(
  started: StartedLane,
  laneName: PullRequestDetailLane,
): { state: PullRequestDetailStoreState; entry: PullRequestDetailEntry } | null {
  const state = usePullRequestDetailStore.getState();
  const entry = state.entries[started.key];
  const lane = entry?.lanes[laneName];
  if (
    !entry ||
    lane?.operationId !== started.operationId ||
    lane.generation !== started.generation
  ) {
    return null;
  }
  return { state, entry };
}

function stoppedEntry(
  entry: PullRequestDetailEntry,
  laneName: PullRequestDetailLane,
  marker: PullRequestBoundedDataMarker,
): PullRequestDetailEntry {
  const stopped: PullRequestDetailEntry = {
    ...entry,
    ...(laneName === "checks" ? { checksNextCursor: null } : {}),
    ...(laneName === "comments" ? { commentsNextCursor: null } : {}),
    ...(laneName === "timelineOlder" ? { olderCursor: null, hasMoreOlder: false } : {}),
    ...(laneName === "timelineNewer"
      ? { newerCursor: null, hasMoreNewer: false }
      : {}),
    lanes: {
      ...entry.lanes,
      [laneName]: {
        ...entry.lanes[laneName],
        status: laneHasData(entry, laneName) ? "ready" : "idle",
        operationId: null,
        error: null,
        stale: laneName === "timelineNewer" && marker.reason === "catch_up_limit",
        boundedData: marker,
      },
    },
  };
  return withByteSizes(stopped);
}

function commitCandidate(
  started: StartedLane,
  laneName: PullRequestDetailLane,
  candidate: PullRequestDetailEntry,
  freshness: Freshness,
  options: { keepOperation?: boolean; forceMarker?: PullRequestBoundedDataMarker | null } = {},
): boolean {
  const current = currentLane(started, laneName);
  if (!current) return false;
  const marker = options.forceMarker === undefined
    ? freshness.boundedData
    : options.forceMarker;
  const completed = withByteSizes({
    ...candidate,
    lastAccessedAt: Date.now(),
    lanes: {
      ...candidate.lanes,
      [laneName]: {
        ...candidate.lanes[laneName],
        status: "ready",
        operationId: options.keepOperation ? started.operationId : null,
        error: null,
        stale: marker?.reason === "catch_up_limit",
        fetchedAt: Date.parse(freshness.fetchedAt),
        staleAt: Date.parse(freshness.staleAt),
        boundedData: marker,
      },
    },
  });

  const recordLimit = entryRecordCount(completed) > MAX_DETAIL_RECORDS;
  const byteLimit = completed.estimatedBytes > MAX_IDENTITY_BYTES;
  if (recordLimit || byteLimit) {
    const bounded = stoppedEntry(current.entry, laneName, {
      reason: recordLimit ? "record_limit" : "byte_limit",
    });
    usePullRequestDetailStore.setState({
      entries: { ...current.state.entries, [started.key]: bounded },
    });
    return false;
  }

  const bounded = evictEntries(
    { ...current.state.entries, [started.key]: completed },
    current.state.activeKey,
  );
  usePullRequestDetailStore.setState({ entries: bounded.entries });
  if (bounded.operationIds.length > 0) {
    void cancelOperations(bounded.operationIds, getPullRequestTransport());
  }
  return true;
}

function failLane(
  started: StartedLane,
  laneName: PullRequestDetailLane,
  error: PullRequestError,
): void {
  const current = currentLane(started, laneName);
  if (!current) return;
  const entry = current.entry;
  usePullRequestDetailStore.setState({
    entries: {
      ...current.state.entries,
      [started.key]: {
        ...entry,
        lanes: {
          ...entry.lanes,
          [laneName]: {
            ...entry.lanes[laneName],
            status: "error",
            operationId: null,
            error,
            stale: laneHasData(entry, laneName),
          },
        },
      },
    },
  });
}

function mergeByIdWithBytes<T>(
  current: readonly T[],
  incoming: readonly T[],
  currentBytes: number,
  replace: boolean,
  id: (item: T) => string,
  compare: (left: T, right: T) => number,
): { items: T[]; bytes: number } {
  const merged = new Map(
    (replace ? [] : current).map((item) => [id(item), item]),
  );
  let bytes = replace ? 2 : currentBytes;
  for (const item of incoming) {
    const key = id(item);
    const previous = merged.get(key);
    if (previous) bytes -= estimateValueBytes(previous) + 1;
    merged.set(key, item);
    bytes += estimateValueBytes(item) + 1;
  }
  return { items: [...merged.values()].sort(compare), bytes };
}

function compareTimestampedIds(
  leftTimestamp: string,
  leftId: string,
  rightTimestamp: string,
  rightId: string,
): number {
  const time = Date.parse(leftTimestamp) - Date.parse(rightTimestamp);
  return time === 0 ? leftId.localeCompare(rightId) : time;
}

function compareTimeline(left: PullRequestTimelineItem, right: PullRequestTimelineItem): number {
  return compareTimestampedIds(
    left.occurredAt,
    left.providerNodeId,
    right.occurredAt,
    right.providerNodeId,
  );
}

function compareConversation(
  left: PullRequestConversationItem,
  right: PullRequestConversationItem,
): number {
  return compareTimestampedIds(
    left.createdAt,
    left.providerNodeId,
    right.createdAt,
    right.providerNodeId,
  );
}

async function loadResource(
  resource: PullRequestGetResource,
  append: boolean,
  transportOverride?: PullRequestTransport,
): Promise<void> {
  const laneName = resource;
  const before = usePullRequestDetailStore.getState();
  const entry = before.activeKey ? before.entries[before.activeKey] : undefined;
  if (!entry) return;
  const cursor =
    resource === "checks" ? entry.checksNextCursor : entry.commentsNextCursor;
  if (append && !cursor) return;

  const started = beginLane(laneName);
  if (!started) return;
  const transport = transportOverride ?? getPullRequestTransport();
  try {
    const result = resource === "detail"
      ? await transport.get({
          operationId: started.operationId,
          identity: started.identity,
          resource: "detail",
        })
      : await transport.get({
          operationId: started.operationId,
          identity: started.identity,
          resource,
          limit: DETAIL_PAGE_SIZE,
          ...(append && cursor ? { cursor } : {}),
        });
    const current = currentLane(started, laneName);
    if (!current) return;
    if (!result.ok) {
      failLane(started, laneName, result.error);
      return;
    }
    if (result.resource !== resource) {
      failLane(started, laneName, {
        code: "remote_unavailable",
        message: "The pull request resource response did not match the request.",
      });
      return;
    }

    let candidate = current.entry;
    let invalidatedOperationIds: string[] = [];
    if (result.resource === "detail") {
      if (
        candidate.detail &&
        candidate.detail.head.oid !== result.item.head.oid
      ) {
        const invalidated = invalidateHeadDependentLanes(candidate);
        candidate = invalidated.entry;
        invalidatedOperationIds = invalidated.operationIds;
      }
      candidate = withByteSizes(
        { ...candidate, detail: result.item },
        { detail: estimateValueBytes(result.item) },
      );
    } else if (result.resource === "checks") {
      const merged = mergeByIdWithBytes(
        candidate.checks,
        result.items,
        candidate.byteSizes.checks,
        !append,
        (item) => item.providerNodeId,
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.providerNodeId.localeCompare(right.providerNodeId),
      );
      candidate = withByteSizes({
        ...candidate,
        checks: merged.items,
        checksNextCursor: result.nextCursor,
      }, { checks: merged.bytes });
    } else {
      const merged = mergeByIdWithBytes(
        candidate.comments,
        result.items,
        candidate.byteSizes.comments,
        !append,
        (item) => item.providerNodeId,
        compareConversation,
      );
      candidate = withByteSizes({
        ...candidate,
        comments: merged.items,
        commentsNextCursor: result.nextCursor,
      }, { comments: merged.bytes });
    }
    const committed = commitCandidate(started, laneName, candidate, result, {
      forceMarker: append
        ? strongerBoundedData(
            current.entry.lanes[laneName].boundedData,
            result.boundedData,
          )
        : result.boundedData,
    });
    if (committed && invalidatedOperationIds.length > 0) {
      void cancelOperations(invalidatedOperationIds, transport);
    }
  } catch (error) {
    failLane(started, laneName, normalizeError(error));
  }
}

async function loadTimelineInitial(transportOverride?: PullRequestTransport): Promise<void> {
  const started = beginLane("timelineInitial");
  if (!started) return;
  const transport = transportOverride ?? getPullRequestTransport();
  try {
    const result = await transport.timeline({
      operationId: started.operationId,
      identity: started.identity,
      lane: "initial",
      limit: DETAIL_PAGE_SIZE,
    });
    const current = currentLane(started, "timelineInitial");
    if (!current) return;
    if (!result.ok) {
      failLane(started, "timelineInitial", result.error);
      return;
    }
    const merged = mergeByIdWithBytes(
      [],
      result.items,
      2,
      true,
      (item) => item.providerNodeId,
      compareTimeline,
    );
    const candidate = withByteSizes({
      ...current.entry,
      timeline: merged.items,
      olderCursor: result.olderCursor,
      newerCursor: result.newerCursor,
      hasMoreOlder: result.hasMoreOlder,
      hasMoreNewer: result.hasMoreNewer,
    }, { timeline: merged.bytes });
    commitCandidate(started, "timelineInitial", candidate, result);
  } catch (error) {
    failLane(started, "timelineInitial", normalizeError(error));
  }
}

async function loadTimelineOlder(transportOverride?: PullRequestTransport): Promise<void> {
  const before = usePullRequestDetailStore.getState();
  const entry = before.activeKey ? before.entries[before.activeKey] : undefined;
  if (!entry?.olderCursor || !entry.hasMoreOlder) return;
  const started = beginLane("timelineOlder");
  if (!started) return;
  const transport = transportOverride ?? getPullRequestTransport();
  try {
    const result = await transport.timeline({
      operationId: started.operationId,
      identity: started.identity,
      lane: "older",
      cursor: entry.olderCursor,
      limit: DETAIL_PAGE_SIZE,
    });
    const current = currentLane(started, "timelineOlder");
    if (!current) return;
    if (!result.ok) {
      failLane(started, "timelineOlder", result.error);
      return;
    }
    const merged = mergeByIdWithBytes(
      current.entry.timeline,
      result.items,
      current.entry.byteSizes.timeline,
      false,
      (item) => item.providerNodeId,
      compareTimeline,
    );
    const candidate = withByteSizes({
      ...current.entry,
      timeline: merged.items,
      olderCursor: result.olderCursor,
      newerCursor: result.newerCursor ?? current.entry.newerCursor,
      hasMoreOlder: result.hasMoreOlder,
      hasMoreNewer: current.entry.hasMoreNewer || result.hasMoreNewer,
    }, { timeline: merged.bytes });
    commitCandidate(started, "timelineOlder", candidate, result);
  } catch (error) {
    failLane(started, "timelineOlder", normalizeError(error));
  }
}

async function catchUpTimeline(transportOverride?: PullRequestTransport): Promise<void> {
  const before = usePullRequestDetailStore.getState();
  const initialEntry = before.activeKey ? before.entries[before.activeKey] : undefined;
  if (!initialEntry) return;
  if (!initialEntry.newerCursor) {
    await loadTimelineInitial(transportOverride);
    return;
  }
  const started = beginLane("timelineNewer");
  if (!started) return;
  const transport = transportOverride ?? getPullRequestTransport();
  let newerItems: PullRequestTimelineItem[] = [];
  let candidate: PullRequestDetailEntry | null = null;
  let cursor = initialEntry.newerCursor;
  let freshness: Freshness | null = null;

  try {
    for (let page = 0; page < TIMELINE_CATCH_UP_PAGES; page += 1) {
      const result = await transport.timeline({
        operationId: started.operationId,
        identity: started.identity,
        lane: "newer",
        cursor,
        limit: DETAIL_PAGE_SIZE,
      });
      if (!laneStillOwns(started, "timelineNewer")) return;
      if (!result.ok) {
        failLane(started, "timelineNewer", result.error);
        return;
      }

      const accumulated = mergeByIdWithBytes(
        newerItems,
        result.items,
        2,
        false,
        (item) => item.providerNodeId,
        compareTimeline,
      );
      newerItems = accumulated.items;
      const current = currentLane(started, "timelineNewer");
      if (!current) return;
      const merged = mergeByIdWithBytes(
        current.entry.timeline,
        newerItems,
        current.entry.byteSizes.timeline,
        false,
        (item) => item.providerNodeId,
        compareTimeline,
      );
      const nextCandidate = withByteSizes({
        ...current.entry,
        timeline: merged.items,
        newerCursor: result.newerCursor ?? cursor,
        hasMoreNewer: result.hasMoreNewer,
      }, { timeline: merged.bytes });
      if (
        entryRecordCount(nextCandidate) > MAX_DETAIL_RECORDS ||
        nextCandidate.estimatedBytes > MAX_IDENTITY_BYTES
      ) {
        const reason = entryRecordCount(nextCandidate) > MAX_DETAIL_RECORDS
          ? "record_limit"
          : "byte_limit";
        usePullRequestDetailStore.setState({
          entries: {
            ...current.state.entries,
            [started.key]: stoppedEntry(current.entry, "timelineNewer", { reason }),
          },
        });
        return;
      }

      candidate = nextCandidate;
      cursor = candidate.newerCursor ?? cursor;
      freshness = result;
      if (!result.hasMoreNewer) {
        commitCandidate(started, "timelineNewer", candidate, result, {
          forceMarker: result.boundedData?.reason === "catch_up_limit"
            ? null
            : result.boundedData,
        });
        return;
      }
    }

    if (freshness && candidate) {
      commitCandidate(started, "timelineNewer", candidate, freshness, {
        forceMarker: { reason: "catch_up_limit" },
      });
    }
  } catch (error) {
    failLane(started, "timelineNewer", normalizeError(error));
  }
}

function laneIsStale(lane: PullRequestDetailLaneState, now: number): boolean {
  return lane.stale || lane.staleAt === null || now >= lane.staleAt;
}

/** Normalized byte-bounded cache for pull request Summary and Timeline reads. */
export const usePullRequestDetailStore = create<PullRequestDetailStoreState>((set, get) => ({
  entries: {},
  activeKey: null,
  open: (identity, transportOverride) => {
    const state = get();
    const key = getPullRequestDetailKey(identity);
    const previous = state.activeKey ? state.entries[state.activeKey] : undefined;
    const cancelIds = state.activeKey === key ? [] : activeOperationIds(previous);
    const nextEntries = { ...state.entries };
    if (state.activeKey && state.activeKey !== key && previous) {
      nextEntries[state.activeKey] = clearOperations(previous);
    }
    const current = nextEntries[key] ?? createEntry(identity);
    nextEntries[key] = { ...current, identity, lastAccessedAt: Date.now() };
    const bounded = evictEntries(nextEntries, key);
    set({ activeKey: key, entries: bounded.entries });
    if (cancelIds.length > 0 || bounded.operationIds.length > 0) {
      void cancelOperations(
        [...cancelIds, ...bounded.operationIds],
        transportOverride ?? getPullRequestTransport(),
      );
    }
  },
  close: (transportOverride) => {
    const state = get();
    const entry = state.activeKey ? state.entries[state.activeKey] : undefined;
    const cancelIds = activeOperationIds(entry);
    set({
      activeKey: null,
      entries:
        state.activeKey && entry
          ? { ...state.entries, [state.activeKey]: clearOperations(entry) }
          : state.entries,
    });
    if (cancelIds.length > 0) {
      void cancelOperations(cancelIds, transportOverride ?? getPullRequestTransport());
    }
  },
  touch: (key) =>
    set((state) => {
      const entry = state.entries[key];
      return entry
        ? { entries: { ...state.entries, [key]: { ...entry, lastAccessedAt: Date.now() } } }
        : state;
    }),
  loadDetail: (transport) => loadResource("detail", false, transport),
  loadChecks: (options) =>
    loadResource("checks", options?.append ?? false, options?.transport),
  loadComments: (options) =>
    loadResource("comments", options?.append ?? false, options?.transport),
  loadTimeline: (transport) => loadTimelineInitial(transport),
  loadOlderTimeline: (transport) => loadTimelineOlder(transport),
  catchUpTimeline: (transport) => catchUpTimeline(transport),
  refreshActive: async (options) => {
    const state = get();
    const entry = state.activeKey ? state.entries[state.activeKey] : undefined;
    if (!entry) return;
    const now = Date.now();
    const force = options?.force ?? false;
    const transport = options?.transport;
    const tasks: Promise<void>[] = [];
    if (force || laneIsStale(entry.lanes.detail, now)) {
      tasks.push(loadResource("detail", false, transport));
    }
    if (
      entry.lanes.checks.fetchedAt !== null &&
      (force || laneIsStale(entry.lanes.checks, now))
    ) {
      tasks.push(loadResource("checks", false, transport));
    }
    if (
      entry.lanes.comments.fetchedAt !== null &&
      (force || laneIsStale(entry.lanes.comments, now))
    ) {
      tasks.push(loadResource("comments", false, transport));
    }
    const timelineStale =
      laneIsStale(entry.lanes.timelineInitial, now) ||
      laneIsStale(entry.lanes.timelineNewer, now);
    if (entry.lanes.timelineInitial.fetchedAt !== null && (force || timelineStale)) {
      tasks.push(catchUpTimeline(transport));
    }
    await Promise.all(tasks);
  },
  invalidateAfterMutation: async (identity, transport) => {
    const key = getPullRequestDetailKey(identity);
    const entry = get().entries[key];
    if (!entry) return;
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          ...entry,
          lanes: Object.fromEntries(
            Object.entries(entry.lanes).map(([name, lane]) => [
              name,
              { ...lane, stale: true, staleAt: 0 },
            ]),
          ) as Record<PullRequestDetailLane, PullRequestDetailLaneState>,
        },
      },
    }));
    if (get().activeKey === key) {
      await get().refreshActive({ force: true, transport });
    }
  },
  cancelActive: async (transportOverride) => {
    const state = get();
    if (!state.activeKey) return;
    await get().cancelEntry(state.activeKey, transportOverride);
  },
  cancelEntry: async (key, transportOverride) => {
    const state = get();
    const entry = state.entries[key];
    if (!entry) return;
    const ids = activeOperationIds(entry);
    set({ entries: { ...state.entries, [key]: clearOperations(entry) } });
    await cancelOperations(ids, transportOverride ?? getPullRequestTransport());
  },
  reset: (transportOverride) => {
    const state = get();
    const ids = Object.values(state.entries).flatMap(activeOperationIds);
    set({ entries: {}, activeKey: null });
    if (ids.length > 0) {
      void cancelOperations(ids, transportOverride ?? getPullRequestTransport());
    }
  },
}));
