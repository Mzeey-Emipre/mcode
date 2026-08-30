import type { PullRequestDetailStoreState } from "./pullRequestDetailStore";

function detailEntry(state: PullRequestDetailStoreState, key: string) {
  return state.entries[key];
}

function detailCore(entry: ReturnType<typeof detailEntry>) {
  return {
    exists: Boolean(entry),
    detail: entry?.detail ?? null,
    lane: entry?.lanes.detail ?? null,
  };
}

function summaryResources(entry: ReturnType<typeof detailEntry>) {
  if (!entry) {
    return {
      checks: EMPTY_ARRAY,
      checksNextCursor: null,
      comments: EMPTY_ARRAY,
      commentsNextCursor: null,
      checksLane: null,
      commentsLane: null,
    };
  }
  return {
    checks: entry.checks,
    checksNextCursor: entry.checksNextCursor,
    comments: entry.comments,
    commentsNextCursor: entry.commentsNextCursor,
    checksLane: entry.lanes.checks,
    commentsLane: entry.lanes.comments,
  };
}

function timelineResources(entry: ReturnType<typeof detailEntry>) {
  if (!entry) {
    return {
      items: EMPTY_ARRAY,
      hasMoreOlder: false,
      hasMoreNewer: false,
      initialLane: null,
      olderLane: null,
      newerLane: null,
    };
  }
  return {
    items: entry.timeline,
    hasMoreOlder: entry.hasMoreOlder,
    hasMoreNewer: entry.hasMoreNewer,
    initialLane: entry.lanes.timelineInitial,
    olderLane: entry.lanes.timelineOlder,
    newerLane: entry.lanes.timelineNewer,
  };
}

/** Select only persistent-header state for one pull request detail identity. */
export function selectPullRequestDetailCore(key: string) {
  return (state: PullRequestDetailStoreState) => detailCore(detailEntry(state, key));
}

/** Select only Summary resources and lane metadata for one pull request identity. */
export function selectPullRequestSummaryResources(key: string) {
  return (state: PullRequestDetailStoreState) => summaryResources(detailEntry(state, key));
}

/** Select only Timeline data and lane metadata for one pull request identity. */
export function selectPullRequestTimelineResources(key: string) {
  return (state: PullRequestDetailStoreState) => timelineResources(detailEntry(state, key));
}

const EMPTY_ARRAY: readonly never[] = [];
