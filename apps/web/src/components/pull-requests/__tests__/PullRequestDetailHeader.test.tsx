import type {
  PullRequestDetail,
  PullRequestSummary as PullRequestSummaryRecord,
} from "@mcode/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  it("presents pull request status and review metadata", () => {
    const { container } = render(
      <PullRequestDetailHeader detail={detail()} />,
    );

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
    expect(container.querySelector(".lucide-message-circle")).toBeVisible();
    expect(screen.getByText("Checks successful")).toBeVisible();
    expect(
      container.querySelector('[data-check-state="passing"]'),
    ).toHaveClass("rounded-full", "border-[var(--diff-add-strong)]");
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

  it("uses a circular status ring for failed checks", () => {
    const failed = detail();
    failed.checks = { state: "failing" };

    const { container } = render(<PullRequestDetailHeader detail={failed} />);

    expect(screen.getByText("Failing checks")).toBeVisible();
    expect(
      container.querySelector('[data-check-state="failing"]'),
    ).toHaveClass("rounded-full", "border-[var(--diff-remove-strong)]");
  });

  it("shows reviewer identities on hover with review state indicators", async () => {
    const reviewed = detail();
    reviewed.reviewers = [
      {
        target: {
          kind: "user",
          actor: {
            providerNodeId: "reviewer-node",
            login: "reviewer",
            avatarUrl: "https://avatars.githubusercontent.com/u/1",
            profileUrl: "https://github.com/reviewer",
          },
        },
        state: "approved",
        submittedAt: "2026-07-11T12:00:00.000Z",
      },
      {
        target: {
          kind: "team",
          providerNodeId: "team-node",
          organization: "Mzeey-Empire",
          slug: "reviewers",
        },
        state: "requested",
        submittedAt: null,
      },
    ];

    const { container } = render(
      <TooltipProvider delay={0}>
        <PullRequestDetailHeader detail={reviewed} />
      </TooltipProvider>,
    );

    const reviewer = screen.getByLabelText("reviewer, Approved");
    expect(screen.getByLabelText("Mzeey-Empire/reviewers, Review requested")).toBeVisible();
    expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-review-state="approved"]'),
    ).toHaveClass("bg-[var(--diff-add-strong)]");
    expect(
      container.querySelector('[data-review-state="requested"]'),
    ).toHaveClass("bg-primary");

    await userEvent.hover(reviewer);
    expect(await screen.findByText("reviewer")).toBeVisible();
    expect(screen.getByText("· Approved")).toBeVisible();
  });
});
