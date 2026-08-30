import type { PullRequestSummary } from "@mcode/contracts";
import type {
  PullRequestInboxRelationship,
  PullRequestStoreState,
} from "./pullRequestStore";

/** One row or non-interactive group header in the flattened inbox viewport. */
export type PullRequestInboxListItem =
  | {
      type: "header";
      key:
        | "group:review-requested"
        | "group:previously-reviewed"
        | "group:authored";
      id:
        | "pull-request-group-review-requested"
        | "pull-request-group-previously-reviewed"
        | "pull-request-group-authored";
      label: "Review requested" | "Previously reviewed" | "Authored";
      count: number;
    }
  | {
      type: "row";
      key: string;
      describedBy?:
        | "pull-request-group-review-requested"
        | "pull-request-group-previously-reviewed"
        | "pull-request-group-authored";
    };

/** Select the normalized pull request row for one stable identity key. */
export function selectPullRequestByKey(key: string) {
  return (state: PullRequestStoreState): PullRequestSummary | undefined =>
    state.entities[key];
}

/** Select whether one pull request row is the keyboard selection. */
export function selectPullRequestIsSelected(key: string) {
  return (state: PullRequestStoreState): boolean => state.selectedKey === key;
}

/** Select whether the current inbox can load another page. */
export function selectPullRequestHasNextPage(
  state: PullRequestStoreState,
): boolean {
  return state.nextCursor !== null;
}

/** Select the machine-readable reason team review requests are unavailable. */
export function selectTeamRequestLimitation(
  state: PullRequestStoreState,
): string | null {
  const capability = state.capabilities?.teamRequests;
  if (capability && !capability.allowed)
    return capability.reason ?? "unsupported";
  const limitation = state.limitations.find(
    (item) => item.capability === "teamRequests",
  );
  return limitation?.reason ?? null;
}

type PullRequestFilterState = Pick<
  PullRequestStoreState,
  | "orderedKeys"
  | "entities"
  | "repositoryFilter"
  | "authorFilter"
  | "reviewFilters"
  | "checkFilters"
  | "search"
>;

type PullRequestRelationship = PullRequestSummary["relationships"][number];

function pullRequestSearchValues(item: PullRequestSummary): string[] {
  return [
    item.title,
    `${item.identity.owner}/${item.identity.repository}`,
    item.head.name,
    item.author?.login ?? "unknown",
    `#${item.identity.number}`,
  ];
}

function matchesSearch(item: PullRequestSummary, search: string): boolean {
  return !search || pullRequestSearchValues(item).some((value) => value.toLowerCase().includes(search));
}

function matchesRepository(
  item: PullRequestSummary,
  repositoryFilter: string | null,
): boolean {
  return !repositoryFilter || `${item.identity.owner}/${item.identity.repository}` === repositoryFilter;
}

function matchesAuthor(item: PullRequestSummary, authorFilter: string | null): boolean {
  return !authorFilter || (item.author?.login ?? "unknown") === authorFilter;
}

function matchesReviewFilters(
  item: PullRequestSummary,
  reviewFilters: readonly PullRequestRelationship[],
): boolean {
  return reviewFilters.length === 0 || item.relationships.some((relationship) => reviewFilters.includes(relationship));
}

function matchesCheckFilters(item: PullRequestSummary, checkFilters: readonly string[]): boolean {
  return checkFilters.length === 0 || checkFilters.includes(item.checks.state);
}

function matchesPullRequestFilters(
  item: PullRequestSummary,
  state: PullRequestFilterState,
  search: string,
): boolean {
  return (
    matchesSearch(item, search) &&
    matchesRepository(item, state.repositoryFilter) &&
    matchesAuthor(item, state.authorFilter) &&
    matchesReviewFilters(item, state.reviewFilters) &&
    matchesCheckFilters(item, state.checkFilters)
  );
}

/** Return keys that match the active local search and filter controls. */
export function filterPullRequestKeys(state: PullRequestFilterState): string[] {
  const search = state.search.trim().toLowerCase();
  return state.orderedKeys.filter((key) => {
    const item = state.entities[key];
    return item !== undefined && matchesPullRequestFilters(item, state, search);
  });
}

type PullRequestInboxGroup = Exclude<PullRequestInboxListItem, { type: "row" }> & {
  keys: string[];
};

function groupForRelationship(
  item: PullRequestSummary,
  relationship: PullRequestInboxRelationship,
): PullRequestInboxGroup["key"] | null {
  if (item.relationships.some((value) => value === "direct_review_requested" || value === "team_review_requested")) {
    return "group:review-requested";
  }
  if (item.relationships.includes("reviewed")) return "group:previously-reviewed";
  return relationship === "all" && item.relationships.includes("authored") ? "group:authored" : null;
}

function inboxGroups(): Record<PullRequestInboxGroup["key"], PullRequestInboxGroup> {
  return {
    "group:review-requested": {
      type: "header",
      key: "group:review-requested",
      id: "pull-request-group-review-requested",
      label: "Review requested",
      count: 0,
      keys: [],
    },
    "group:previously-reviewed": {
      type: "header",
      key: "group:previously-reviewed",
      id: "pull-request-group-previously-reviewed",
      label: "Previously reviewed",
      count: 0,
      keys: [],
    },
    "group:authored": {
      type: "header",
      key: "group:authored",
      id: "pull-request-group-authored",
      label: "Authored",
      count: 0,
      keys: [],
    },
  };
}

function groupItems(group: PullRequestInboxGroup): PullRequestInboxListItem[] {
  if (group.keys.length === 0) return [];
  return [
    { ...group, count: group.keys.length },
    ...group.keys.map((key) => ({ type: "row" as const, key, describedBy: group.id })),
  ];
}

function authoredItems(
  keys: readonly string[],
  entities: Record<string, PullRequestSummary>,
): PullRequestInboxListItem[] {
  return keys.flatMap((key) =>
    entities[key]?.relationships.includes("authored") ? [{ type: "row" as const, key }] : [],
  );
}

/** Build deterministic relationship groups without creating a second row list. */
export function buildPullRequestInboxListItems(
  relationship: PullRequestInboxRelationship,
  keys: string[],
  entities: Record<string, PullRequestSummary>,
): PullRequestInboxListItem[] {
  if (relationship === "authored") return authoredItems(keys, entities);
  const groups = inboxGroups();
  for (const key of keys) {
    const item = entities[key];
    if (!item) continue;
    const group = groupForRelationship(item, relationship);
    if (group) groups[group].keys.push(key);
  }
  return Object.values(groups).flatMap(groupItems);
}
