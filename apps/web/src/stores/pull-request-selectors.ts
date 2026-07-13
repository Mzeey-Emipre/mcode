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

/** Return keys that match the active local search and filter controls. */
export function filterPullRequestKeys(state: PullRequestFilterState): string[] {
  const search = state.search.trim().toLowerCase();
  return state.orderedKeys.filter((key) => {
    const item = state.entities[key];
    if (!item) return false;
    const repository = `${item.identity.owner}/${item.identity.repository}`;
    const author = item.author?.login ?? "unknown";
    const number = `#${item.identity.number}`;
    if (
      search &&
      ![item.title, repository, item.head.name, author, number].some((value) =>
        value.toLowerCase().includes(search),
      )
    ) {
      return false;
    }
    if (state.repositoryFilter && repository !== state.repositoryFilter)
      return false;
    if (state.authorFilter && author !== state.authorFilter) return false;
    if (
      state.reviewFilters.length > 0 &&
      !item.relationships.some((relationship) =>
        state.reviewFilters.includes(relationship),
      )
    ) {
      return false;
    }
    if (
      state.checkFilters.length > 0 &&
      !state.checkFilters.includes(item.checks.state)
    ) {
      return false;
    }
    return true;
  });
}

/** Build deterministic relationship groups without creating a second row list. */
export function buildPullRequestInboxListItems(
  relationship: PullRequestInboxRelationship,
  keys: string[],
  entities: Record<string, PullRequestSummary>,
): PullRequestInboxListItem[] {
  if (relationship === "authored") {
    return keys.flatMap((key) => {
      const item = entities[key];
      return item?.relationships.includes("authored")
        ? [{ type: "row" as const, key }]
        : [];
    });
  }

  const requested: string[] = [];
  const previouslyReviewed: string[] = [];
  const authored: string[] = [];
  for (const key of keys) {
    const item = entities[key];
    if (!item) continue;
    const isRequested = item.relationships.some(
      (value) =>
        value === "direct_review_requested" ||
        value === "team_review_requested",
    );
    if (isRequested) {
      requested.push(key);
    } else if (item.relationships.includes("reviewed")) {
      previouslyReviewed.push(key);
    } else if (
      relationship === "all" &&
      item.relationships.includes("authored")
    ) {
      authored.push(key);
    }
  }

  const items: PullRequestInboxListItem[] = [];
  if (requested.length > 0) {
    items.push({
      type: "header",
      key: "group:review-requested",
      id: "pull-request-group-review-requested",
      label: "Review requested",
      count: requested.length,
    });
    items.push(
      ...requested.map((key) => ({
        type: "row" as const,
        key,
        describedBy: "pull-request-group-review-requested" as const,
      })),
    );
  }
  if (previouslyReviewed.length > 0) {
    items.push({
      type: "header",
      key: "group:previously-reviewed",
      id: "pull-request-group-previously-reviewed",
      label: "Previously reviewed",
      count: previouslyReviewed.length,
    });
    items.push(
      ...previouslyReviewed.map((key) => ({
        type: "row" as const,
        key,
        describedBy: "pull-request-group-previously-reviewed" as const,
      })),
    );
  }
  if (authored.length > 0) {
    items.push({
      type: "header",
      key: "group:authored",
      id: "pull-request-group-authored",
      label: "Authored",
      count: authored.length,
    });
    items.push(
      ...authored.map((key) => ({
        type: "row" as const,
        key,
        describedBy: "pull-request-group-authored" as const,
      })),
    );
  }
  return items;
}
