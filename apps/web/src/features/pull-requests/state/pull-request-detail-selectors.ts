import type { PullRequestDetailStoreState } from "./pullRequestDetailStore";

/** Select only persistent-header state for one pull request detail identity. */
export function selectPullRequestDetailCore(key: string) {
  return (state: PullRequestDetailStoreState) => {
    const entry = state.entries[key];
    return {
      exists: Boolean(entry),
      detail: entry?.detail ?? null,
      lane: entry?.lanes.detail ?? null,
    };
  };
}

/** Select only Summary resources and lane metadata for one pull request identity. */
export function selectPullRequestSummaryResources(key: string) {
  return (state: PullRequestDetailStoreState) => {
    const entry = state.entries[key];
    return {
      checks: entry?.checks ?? EMPTY_ARRAY,
      checksNextCursor: entry?.checksNextCursor ?? null,
      comments: entry?.comments ?? EMPTY_ARRAY,
      commentsNextCursor: entry?.commentsNextCursor ?? null,
      checksLane: entry?.lanes.checks ?? null,
      commentsLane: entry?.lanes.comments ?? null,
    };
  };
}

/** Select only Timeline data and lane metadata for one pull request identity. */
export function selectPullRequestTimelineResources(key: string) {
  return (state: PullRequestDetailStoreState) => {
    const entry = state.entries[key];
    return {
      items: entry?.timeline ?? EMPTY_ARRAY,
      hasMoreOlder: entry?.hasMoreOlder ?? false,
      hasMoreNewer: entry?.hasMoreNewer ?? false,
      initialLane: entry?.lanes.timelineInitial ?? null,
      olderLane: entry?.lanes.timelineOlder ?? null,
      newerLane: entry?.lanes.timelineNewer ?? null,
    };
  };
}

const EMPTY_ARRAY: readonly never[] = [];
