import type {
  PullRequestDetail,
  PullRequestSummary as PullRequestSummaryRecord,
} from "@mcode/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PullRequestDetailHeader } from "../PullRequestDetailHeader";

function detail(): PullRequestDetail {
  return {
    identity: {
      provider: "github",
      repositoryNodeId: "repo-node",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 42,
    },
    providerNodeId: "pull-request-node",
    url: "https://github.com/Mzeey-Empire/mcode/pull/42",
    title: "Keep pull request state legible across surfaces",
    body: "Remote description",
    author: {
      providerNodeId: "actor-node",
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231",
      profileUrl: "https://github.com/octocat",
    },
    state: "open",
    readiness: "ready",
    head: {
      owner: "contributor",
      repository: "mcode",
      name: "feature/pr-detail",
      oid: "a".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "b".repeat(40),
    },
    additions: 128,
    deletions: 34,
    changedFiles: 7,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
    mergeability: "mergeable",
    mergeMethods: ["merge", "squash"],
    defaultMergeMethod: "squash",
    reviewDecision: "review_required",
    reviewers: [],
    checks: { state: "passing" },
    checkCount: 4,
    commentCount: 3,
    reviewThreadCount: 1,
  };
}

function summaryFallback(): PullRequestSummaryRecord {
  const value = detail();
  return {
    identity: value.identity,
    url: value.url,
    title: value.title,
    author: value.author,
    state: value.state,
    readiness: value.readiness,
    head: value.head,
    base: value.base,
    relationships: ["authored"],
    checks: value.checks,
    commentCount: value.commentCount,
    additions: value.additions,
    deletions: value.deletions,
    updatedAt: value.updatedAt,
  };
}

describe("PullRequestDetailHeader", () => {
  it("presents pull request identity and status once", () => {
    render(<PullRequestDetailHeader detail={detail()} />);

    expect(
      screen.getByRole("heading", {
        name: "Keep pull request state legible across surfaces",
      }),
    ).toBeVisible();
    expect(screen.getByText("octocat")).toBeVisible();
    expect(screen.getByRole("img", { name: "octocat" })).toHaveAttribute(
      "src",
      "https://avatars.githubusercontent.com/u/583231",
    );
    expect(screen.getByText("Ready for review")).toBeVisible();
    expect(screen.getByText("Mergeable")).toBeVisible();
    expect(screen.getByLabelText("Base branch main")).toBeVisible();
    expect(
      screen.getByLabelText("Head branch feature/pr-detail"),
    ).toHaveTextContent("feature/pr-detail");
    expect(screen.getByLabelText("128 additions")).toHaveTextContent("+128");
    expect(screen.getByLabelText("34 deletions")).toHaveTextContent("−34");
    expect(screen.getByText("No reviewers")).toBeVisible();
    expect(screen.getByText("4 comments")).toBeVisible();
    expect(screen.getByText("Checks successful")).toBeVisible();
    expect(
      document.querySelector('time[datetime="2026-07-11T12:00:00.000Z"]'),
    ).not.toBeNull();
  });

  it("keeps inbox identity visible while detail is loading or unavailable", () => {
    const fallback = summaryFallback();
    const { rerender } = render(
      <PullRequestDetailHeader detail={null} summaryFallback={fallback} />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Keep pull request state legible across surfaces",
      }),
    ).toBeVisible();
    expect(screen.getByText("octocat")).toBeVisible();
    expect(screen.getByText("Ready for review")).toBeVisible();
    expect(screen.getByLabelText("Base branch main")).toBeVisible();
    expect(
      screen.getByLabelText("Head branch feature/pr-detail"),
    ).toBeVisible();
    expect(screen.getByLabelText("128 additions")).toBeVisible();
    expect(screen.getByLabelText("34 deletions")).toBeVisible();
    expect(screen.queryByText("Mergeable")).not.toBeInTheDocument();
    expect(screen.getByText("Loading")).toBeVisible();

    rerender(<PullRequestDetailHeader summaryFallback={fallback} />);
    expect(screen.getByText("octocat")).toBeVisible();
  });
});
