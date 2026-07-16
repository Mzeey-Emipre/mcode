import type { PullRequestIdentity } from "@mcode/contracts";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  selectPullRequestCommentDraft,
  selectPullRequestMutationLane,
} from "../pull-request-mutation-selectors";
import {
  getPullRequestMutationLaneKey,
  usePullRequestMutationStore,
} from "../pullRequestMutationStore";

const identity: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};

describe("pull request mutation selectors", () => {
  beforeEach(() => {
    usePullRequestMutationStore.setState({ lanes: {}, commentDrafts: {} });
  });

  it("keeps unrelated effect and identity subscribers render-stable", () => {
    const renders = { comment: 0, review: 0, otherDraft: 0 };
    const other = { ...identity, repositoryNodeId: "R_other", number: 43 };

    function CommentProbe() {
      const lane = usePullRequestMutationStore(
        selectPullRequestMutationLane(identity, "comment"),
      );
      renders.comment += 1;
      return <span>comment:{lane.status}</span>;
    }
    function ReviewProbe() {
      const lane = usePullRequestMutationStore(
        selectPullRequestMutationLane(identity, "review"),
      );
      renders.review += 1;
      return <span>review:{lane.status}</span>;
    }
    function OtherDraftProbe() {
      const body = usePullRequestMutationStore(selectPullRequestCommentDraft(other));
      renders.otherDraft += 1;
      return <span>other:{body}</span>;
    }

    render(
      <>
        <CommentProbe />
        <ReviewProbe />
        <OtherDraftProbe />
      </>,
    );
    expect(screen.getByText("comment:idle")).toBeVisible();
    const initial = { ...renders };

    act(() => {
      const laneKey = getPullRequestMutationLaneKey(identity, "comment");
      usePullRequestMutationStore.setState((state) => ({
        lanes: {
          ...state.lanes,
          [laneKey]: {
            effect: "comment",
            status: "error",
            idempotencyKey: crypto.randomUUID(),
            request: null,
            error: { code: "rate_limited", message: "Slow down" },
            result: null,
            draftSnapshotKey: null,
            updatedAt: 1,
          },
        },
      }));
    });
    expect(renders.comment).toBe(initial.comment + 1);
    expect(renders.review).toBe(initial.review);
    expect(renders.otherDraft).toBe(initial.otherDraft);

    act(() => {
      usePullRequestMutationStore.getState().setCommentDraft(identity, "Local text");
    });
    expect(renders.review).toBe(initial.review);
    expect(renders.otherDraft).toBe(initial.otherDraft);
  });
});
