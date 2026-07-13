import type { PullRequestIdentity } from "@mcode/contracts";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useShallow } from "zustand/shallow";
import {
  selectPullRequestDetailCore,
  selectPullRequestSummaryResources,
  selectPullRequestTimelineResources,
} from "../pull-request-detail-selectors";
import {
  getPullRequestDetailKey,
  usePullRequestDetailStore,
} from "../pullRequestDetailStore";

const identity: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 1,
};

describe("pull request detail selectors", () => {
  beforeEach(() => {
    usePullRequestDetailStore.setState({ entries: {}, activeKey: null });
    usePullRequestDetailStore.getState().open(identity);
  });

  it("does not rerender unrelated core, Summary, or Timeline subscribers", () => {
    const key = getPullRequestDetailKey(identity);
    const renders = { core: 0, summary: 0, timeline: 0 };

    function CoreProbe() {
      const core = usePullRequestDetailStore(
        useShallow(selectPullRequestDetailCore(key)),
      );
      renders.core += 1;
      return <span>core:{String(core.exists)}</span>;
    }

    function SummaryProbe() {
      const summary = usePullRequestDetailStore(
        useShallow(selectPullRequestSummaryResources(key)),
      );
      renders.summary += 1;
      return <span>checks:{summary.checks.length}</span>;
    }

    function TimelineProbe() {
      const timeline = usePullRequestDetailStore(
        useShallow(selectPullRequestTimelineResources(key)),
      );
      renders.timeline += 1;
      return <span>events:{timeline.items.length}</span>;
    }

    render(
      <>
        <CoreProbe />
        <SummaryProbe />
        <TimelineProbe />
      </>,
    );
    expect(screen.getByText("core:true")).toBeVisible();
    const initial = { ...renders };

    act(() => {
      usePullRequestDetailStore.setState((state) => {
        const entry = state.entries[key]!;
        return {
          entries: {
            ...state.entries,
            [key]: {
              ...entry,
              lanes: {
                ...entry.lanes,
                timelineNewer: {
                  ...entry.lanes.timelineNewer,
                  stale: true,
                },
              },
            },
          },
        };
      });
    });

    expect(renders.core).toBe(initial.core);
    expect(renders.summary).toBe(initial.summary);
    expect(renders.timeline).toBe(initial.timeline + 1);
    const afterTimeline = { ...renders };

    act(() => {
      usePullRequestDetailStore.setState((state) => {
        const entry = state.entries[key]!;
        return {
          entries: {
            ...state.entries,
            [key]: {
              ...entry,
              lanes: {
                ...entry.lanes,
                comments: {
                  ...entry.lanes.comments,
                  stale: true,
                },
              },
            },
          },
        };
      });
    });

    expect(renders.core).toBe(afterTimeline.core);
    expect(renders.summary).toBe(afterTimeline.summary + 1);
    expect(renders.timeline).toBe(afterTimeline.timeline);
  });
});
