import type { PullRequestCodeStoreState } from "./pullRequestCodeStore";

const EMPTY_FILES: PullRequestCodeStoreState["entries"][string]["files"] = [];
const EMPTY_EXPANDED_PATHS: PullRequestCodeStoreState["entries"][string]["expandedPaths"] = {};
const EMPTY_QUERY: PullRequestCodeStoreState["entries"][string]["query"] = {
  search: "",
  changeTypes: [],
};

function activeEntry(state: PullRequestCodeStoreState) {
  return state.activeSnapshotKey ? state.entries[state.activeSnapshotKey] : undefined;
}

function codeCore(state: PullRequestCodeStoreState, entry: ReturnType<typeof activeEntry>) {
  return {
    snapshotKey: state.activeSnapshotKey,
    entry: entry ?? null,
    files: entry?.files ?? EMPTY_FILES,
    filesLane: entry?.filesLane ?? null,
  };
}

function codeView(entry: ReturnType<typeof activeEntry>) {
  if (!entry) {
    return {
      activePath: null,
      expandedPaths: EMPTY_EXPANDED_PATHS,
      viewMode: "unified" as const,
      fileTreeVisible: true,
      query: EMPTY_QUERY,
    };
  }
  return {
    activePath: entry.activePath,
    expandedPaths: entry.expandedPaths,
    viewMode: entry.viewMode,
    fileTreeVisible: entry.fileTreeVisible,
    query: entry.query,
  };
}

/** Select the active Code snapshot without subscribing to patch-lane churn. */
export function selectPullRequestCodeCore(state: PullRequestCodeStoreState) {
  return codeCore(state, activeEntry(state));
}

/** Select file-tree presentation state for one Code snapshot. */
export function selectPullRequestCodeView(state: PullRequestCodeStoreState) {
  return codeView(activeEntry(state));
}

/** Create a fine-grained selector for one immutable patch lane. */
export function selectPullRequestPatchLane(patchKey: string) {
  return (state: PullRequestCodeStoreState) => state.patches[patchKey] ?? null;
}
