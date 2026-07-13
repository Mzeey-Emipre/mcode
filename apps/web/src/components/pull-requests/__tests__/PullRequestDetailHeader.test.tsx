import type {
  PullRequestDetail,
  PullRequestSummary as PullRequestSummaryRecord,
} from "@mcode/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
      avatarUrl: null,
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
  it("keeps pull request identity and merge context visible", () => {
    render(<PullRequestDetailHeader detail={detail()} />);

    expect(
      screen.getByRole("heading", {
        name: "Keep pull request state legible across surfaces",
      }),
    ).toBeVisible();
    expect(screen.getByText("Mzeey-Empire/mcode")).toBeVisible();
    expect(screen.getByText("#42")).toBeVisible();
    expect(screen.getByText("@octocat")).toBeVisible();
    expect(screen.getByText("Open")).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.getByText("Mergeable")).toBeVisible();
    expect(screen.getByLabelText("Base branch main")).toBeVisible();
    expect(
      screen.getByLabelText("Head branch feature/pr-detail"),
    ).toHaveTextContent("contributor:feature/pr-detail");
    expect(screen.getByLabelText("128 additions")).toHaveTextContent("+128");
    expect(screen.getByLabelText("34 deletions")).toHaveTextContent("−34");
    expect(screen.getByLabelText("7 changed files")).toHaveTextContent(
      "7 files",
    );
    expect(
      document.querySelector('time[datetime="2026-07-11T12:00:00.000Z"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open in browser" }),
    ).toHaveAttribute("href", "https://github.com/Mzeey-Empire/mcode/pull/42");
  });

  it("exposes narrow back and close callback seams", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <PullRequestDetailHeader
        detail={detail()}
        isNarrow
        showBack
        onBack={onBack}
        onClose={onClose}
      />,
    );

    const back = screen.getByRole("button", { name: "Back to pull requests" });
    expect(back).toHaveTextContent("Pull requests");
    expect(screen.getByTestId("pull-request-detail-context")).toHaveTextContent(
      "Mzeey-Empire/mcode#42",
    );
    expect(
      back.compareDocumentPosition(
        screen.getByTestId("pull-request-detail-context"),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      screen.getByTestId("pull-request-detail-context").compareDocumentPosition(
        screen.getByRole("heading", {
          name: "Keep pull request state legible across surfaces",
        }),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await user.click(back);
    expect(onBack).toHaveBeenCalledOnce();
    await user.click(
      screen.getByRole("button", { name: "Close pull request detail" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
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
    expect(screen.getByText("Mzeey-Empire/mcode")).toBeVisible();
    expect(screen.getByText("#42")).toBeVisible();
    expect(screen.getByText("@octocat")).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.getByLabelText("Base branch main")).toBeVisible();
    expect(
      screen.getByLabelText("Head branch feature/pr-detail"),
    ).toBeVisible();
    expect(screen.getByLabelText("128 additions")).toBeVisible();
    expect(screen.getByLabelText("34 deletions")).toBeVisible();
    expect(screen.queryByText("Mergeable")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("7 changed files")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in browser" }),
    ).toHaveAttribute("href", fallback.url);

    rerender(<PullRequestDetailHeader summaryFallback={fallback} />);
    expect(screen.getByText("Mzeey-Empire/mcode")).toBeVisible();
  });

  it.each([
    "https://user:secret@github.com/Mzeey-Empire/mcode/pull/42",
    "javascript:alert(1)",
    "/Mzeey-Empire/mcode/pull/42",
  ])("omits the browser action for unsafe URL %s", (url) => {
    const unsafeDetail = detail();
    unsafeDetail.url = url;

    render(<PullRequestDetailHeader detail={unsafeDetail} />);

    expect(
      screen.queryByRole("link", { name: "Open in browser" }),
    ).not.toBeInTheDocument();
  });
});
