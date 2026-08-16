import type { PullRequestReviewLink } from "@mcode/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePullRequestReviewLink } from "../usePullRequestReviewLink";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { PullRequestReviewTaskTransport } from "@/transport/pull-request-review-task";

const reviewLink: PullRequestReviewLink = {
  identity: {
    provider: "github",
    repositoryNodeId: "R_repo",
    owner: "Mzeey-Empire",
    repository: "mcode",
    number: 42,
  },
  pullRequestUrl: "https://github.com/Mzeey-Empire/mcode/pull/42",
  pullRequestState: "open",
  threadId: "thread-review",
  worktreeId: "7f07bf4f-43d5-4377-a780-fd2ed546d625",
  workspaceId: "workspace-1",
  worktreePath: "C:/src/mcode-review",
  worktreeManaged: true,
  checkoutState: "named",
  localBranch: "feature/review",
  headOid: "a".repeat(40),
  pushRemote: "origin",
  pushRef: "feature/review",
};

function Probe({
  enabled,
  transport,
}: {
  enabled: boolean;
  transport: PullRequestReviewTaskTransport;
}) {
  const link = usePullRequestReviewLink("thread-review", enabled, transport);
  return <span>{link ? `PR #${link.identity.number}` : "No link"}</span>;
}

describe("usePullRequestReviewLink", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ threads: [], prUrlsByThreadId: {} });
  });

  it("loads by thread only while Overview is open and records the URL before thread load", async () => {
    const transport: PullRequestReviewTaskTransport = {
      createReviewTask: vi.fn(),
      reviewLink: vi.fn().mockResolvedValue(reviewLink),
    };
    const view = render(<Probe enabled={false} transport={transport} />);

    expect(transport.reviewLink).not.toHaveBeenCalled();
    view.rerender(<Probe enabled transport={transport} />);

    expect(await screen.findByText("PR #42")).toBeVisible();
    expect(transport.reviewLink).toHaveBeenCalledWith({ threadId: "thread-review" });
    await waitFor(() =>
      expect(useWorkspaceStore.getState().prUrlsByThreadId["thread-review"]).toBe(
        reviewLink.pullRequestUrl,
      ),
    );
  });
});
