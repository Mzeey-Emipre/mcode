import type { PullRequestCodeStoreState } from "./pullRequestCodeStore";

const EMPTY_FILES: PullRequestCodeStoreState["entries"][string]["files"] = [];
const EMPTY_EXPANDED_PATHS: PullRequestCodeStoreState["entries"][string]["expandedPaths"] = {};
const EMPTY_QUERY: PullRequestCodeStoreState["entries"][string]["query"] = {
  search: "",
  changeTypes: [],
};

/** Select the active Code snapshot without subscribing to patch-lane churn. */
export function selectPullRequestCodeCore(state: PullRequestCodeStoreState) {
  const snapshotKey = state.activeSnapshotKey;
  const entry = snapshotKey ? state.entries[snapshotKey] : undefined;
  return {
    snapshotKey,
    entry: entry ?? null,
    files: entry?.files ?? EMPTY_FILES,
    filesLane: entry?.filesLane ?? null,
  };
}

/** Select file-tree presentation state for one Code snapshot. */
export function selectPullRequestCodeView(state: PullRequestCodeStoreState) {
  const snapshotKey = state.activeSnapshotKey;
  const entry = snapshotKey ? state.entries[snapshotKey] : undefined;
  return {
    activePath: entry?.activePath ?? null,
    expandedPaths: entry?.expandedPaths ?? EMPTY_EXPANDED_PATHS,
    viewMode: entry?.viewMode ?? "unified",
    fileTreeVisible: entry?.fileTreeVisible ?? true,
    query: entry?.query ?? EMPTY_QUERY,
  };
}

/** Create a fine-grained selector for one immutable patch lane. */
export function selectPullRequestPatchLane(patchKey: string) {
  return (state: PullRequestCodeStoreState) => state.patches[patchKey] ?? null;
}
