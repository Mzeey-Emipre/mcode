import { z } from "zod";
import type {
  PullRequestRelationship,
  PullRequestState,
  PullRequestSummary,
} from "@mcode/contracts";

const githubActorSchema = z.object({
  id: z.string().min(1).max(256),
  login: z.string().min(1).max(1_024),
  avatarUrl: z.string().max(4_096).nullable().optional(),
  url: z.string().max(4_096).nullable().optional(),
});

const githubRequestedReviewerSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("User"),
    id: z.string().min(1).max(256),
    login: z.string().min(1).max(1_024),
  }),
  z.object({
    __typename: z.literal("Team"),
    id: z.string().min(1).max(256),
    slug: z.string().min(1).max(1_024),
    organization: z.object({ login: z.string().min(1).max(1_024) }),
  }),
]);

const githubPullRequestNodeSchema = z.object({
  id: z.string().min(1).max(256),
  number: z.number().int().positive().max(2_147_483_647),
  url: z.string().max(4_096),
  title: z.string().max(65_536),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().datetime({ offset: true }),
  author: githubActorSchema.nullable(),
  repository: z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(1_024),
    owner: z.object({ login: z.string().min(1).max(1_024) }),
  }),
  headRefName: z.string().min(1).max(1_024),
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable(),
  headRepository: z
    .object({
      name: z.string().min(1).max(1_024),
      owner: z.object({ login: z.string().min(1).max(1_024) }),
    })
    .nullable(),
  baseRefName: z.string().min(1).max(1_024),
  baseRefOid: z.string().regex(/^[0-9a-f]{40,64}$/i).nullable(),
  comments: z.object({
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            statusCheckRollup: z.object({ state: z.string().max(64) }).nullable(),
          }),
        }),
      )
      .max(1),
  }),
  reviewRequests: z.object({
    nodes: z
      .array(
        z.object({
          requestedReviewer: githubRequestedReviewerSchema.nullable(),
        }),
      )
      .max(50),
  }),
});

/** Parsed GitHub pull request node with unknown provider fields removed. */
export type GithubPullRequestNode = z.infer<typeof githubPullRequestNodeSchema>;

/** Parse a hostile GitHub GraphQL node into the bounded normalization input. */
export function parseGithubPullRequestNode(input: unknown): GithubPullRequestNode | null {
  const parsed = githubPullRequestNodeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Map a GitHub pull request lifecycle value to the provider-neutral state. */
export function normalizeGithubPullRequestState(
  state: GithubPullRequestNode["state"],
): PullRequestState {
  switch (state) {
    case "OPEN":
      return "open";
    case "CLOSED":
      return "closed";
    case "MERGED":
      return "merged";
  }
}

/** Map a GitHub status rollup value to the compact inbox check state. */
export function normalizeGithubCheckState(
  state: string | null | undefined,
): PullRequestSummary["checks"]["state"] {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "ERROR":
    case "FAILURE":
      return "failing";
    case "EXPECTED":
    case "PENDING":
      return "pending";
    case "NEUTRAL":
      return "neutral";
    default:
      return "unknown";
  }
}

/** Resolve direct and team review-request relationships from GitHub reviewer nodes. */
export function normalizeGithubRequestedRelationships(
  node: GithubPullRequestNode,
  viewerLogin: string,
  teamRequestsAllowed: boolean,
  viewerTeamNodeIds: ReadonlySet<string>,
): PullRequestRelationship[] {
  const requestedReviewers = node.reviewRequests.nodes
    .map((entry) => entry.requestedReviewer)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const direct = requestedReviewers.some(
    (reviewer) =>
      reviewer.__typename === "User" &&
      reviewer.login.localeCompare(viewerLogin, undefined, { sensitivity: "accent" }) === 0,
  );
  const team = teamRequestsAllowed && requestedReviewers.some(
    (reviewer) =>
      reviewer.__typename === "Team" && viewerTeamNodeIds.has(reviewer.id),
  );

  const relationships: PullRequestRelationship[] = [];
  if (direct || (requestedReviewers.length === 0 && !team)) {
    relationships.push("direct_review_requested");
  }
  if (team) relationships.push("team_review_requested");
  return relationships;
}

function normalizeGithubPullRequestAuthor(
  author: GithubPullRequestNode["author"],
): PullRequestSummary["author"] {
  if (!author) return null;
  return {
    providerNodeId: author.id,
    login: author.login.slice(0, 100),
    avatarUrl: author.avatarUrl ?? null,
    profileUrl: author.url ?? null,
  };
}

/** Normalize one GitHub GraphQL node into the bounded provider-neutral inbox row. */
export function normalizeGithubPullRequest(
  node: GithubPullRequestNode,
  relationships: PullRequestRelationship[],
): PullRequestSummary | null {
  if (relationships.length === 0) return null;

  const title = node.title.slice(0, 512);
  const owner = node.repository.owner.login.slice(0, 100);
  const repository = node.repository.name.slice(0, 100);
  const headOwner = node.headRepository?.owner.login.slice(0, 100) ?? null;
  const headRepository = node.headRepository?.name.slice(0, 100) ?? null;
  const statusRollup = node.commits.nodes.at(0)?.commit.statusCheckRollup?.state;

  return {
    identity: {
      provider: "github",
      repositoryNodeId: node.repository.id,
      owner,
      repository,
      number: node.number,
    },
    url: node.url,
    title,
    author: normalizeGithubPullRequestAuthor(node.author),
    state: normalizeGithubPullRequestState(node.state),
    readiness: node.isDraft ? "draft" : "ready",
    head: {
      owner: headOwner,
      repository: headRepository,
      name: node.headRefName.slice(0, 255),
      oid: node.headRefOid,
    },
    base: {
      owner,
      repository,
      name: node.baseRefName.slice(0, 255),
      oid: node.baseRefOid,
    },
    relationships,
    checks: { state: normalizeGithubCheckState(statusRollup) },
    commentCount: node.comments.totalCount,
    additions: node.additions,
    deletions: node.deletions,
    updatedAt: node.updatedAt,
  };
}
