import type {
  PullRequestIdentity,
  PullRequestSummary,
  PullRequestTimelineItem,
} from "@mcode/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPullRequestInboxListItems,
  filterPullRequestKeys,
} from "../pull-request-selectors";
import { selectPullRequestCodeCore } from "../pull-request-code-selectors";
import { selectPullRequestTimelineResources } from "../pull-request-detail-selectors";
import { usePullRequestCodeStore } from "../pullRequestCodeStore";
import {
  getPullRequestDetailKey,
  usePullRequestDetailStore,
} from "../pullRequestDetailStore";
import { getPullRequestKey, usePullRequestStore } from "../pullRequestStore";

const PERFORMANCE_P95_MAX_MS = 2;
const SAMPLE_COUNT = 400;
const WARMUP_COUNT = 50;
const IDENTITY: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "REPO_PERFORMANCE_UNIT",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 468,
};

function makeSummary(index: number): PullRequestSummary {
  return {
    identity: { ...IDENTITY, number: index + 1 },
    url: `https://github.com/Mzeey-Empire/mcode/pull/${index + 1}`,
    title: `Performance pull request ${index + 1}`,
    author: {
      providerNodeId: `ACTOR_${index}`,
      login: `author-${index % 10}`,
      avatarUrl: null,
      profileUrl: null,
    },
    state: "open",
    readiness: "ready",
    head: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: `perf-${index + 1}`,
      oid: "b".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "a".repeat(40),
    },
    relationships: [index % 2 === 0 ? "direct_review_requested" : "reviewed"],
    checks: { state: index % 3 === 0 ? "pending" : "passing" },
    commentCount: index % 7,
    additions: index + 1,
    deletions: index % 11,
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

function makeTimelineItem(index: number): PullRequestTimelineItem {
  return {
    kind: "opened",
    providerNodeId: `TIMELINE_${index}`,
    occurredAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
    actor: null,
    url: null,
  };
}

function percentile95(action: () => void): number {
  for (let index = 0; index < WARMUP_COUNT; index += 1) action();
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const startedAt = performance.now();
    action();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe("pull request selector and store performance", () => {
  beforeEach(() => {
    usePullRequestStore.getState().reset();
    usePullRequestDetailStore.setState({ entries: {}, activeKey: null });
    usePullRequestCodeStore.setState({
      entries: {},
      patches: {},
      activeSnapshotKey: null,
      patchPresentationRevision: 0,
    });
  });

  it("keeps 1,000-row filtering and grouping below the 2 ms p95 budget", () => {
    const summaries = Array.from({ length: 1_000 }, (_, index) => makeSummary(index));
    const entities = Object.fromEntries(
      summaries.map((summary) => [getPullRequestKey(summary), summary]),
    );
    const orderedKeys = Object.keys(entities);
    usePullRequestStore.setState({
      entities,
      orderedKeys,
      selectedKey: orderedKeys[0] ?? null,
      status: "ready",
    });
    const state = usePullRequestStore.getState();

    const filterP95 = percentile95(() => {
      filterPullRequestKeys(state);
    });
    const groupingP95 = percentile95(() => {
      buildPullRequestInboxListItems("reviewing", orderedKeys, entities);
    });
    const selectionUpdateP95 = percentile95(() => {
      usePullRequestStore.getState().moveSelection(1);
    });

    expect(filterP95).toBeLessThan(PERFORMANCE_P95_MAX_MS);
    expect(groupingP95).toBeLessThan(PERFORMANCE_P95_MAX_MS);
    expect(selectionUpdateP95).toBeLessThan(PERFORMANCE_P95_MAX_MS);
  });

  it("keeps 1,000-event Timeline selection and lane updates below 2 ms p95", () => {
    usePullRequestDetailStore.getState().open(IDENTITY);
    const key = getPullRequestDetailKey(IDENTITY);
    const timeline = Array.from(
      { length: 1_000 },
      (_, index) => makeTimelineItem(index),
    );
    usePullRequestDetailStore.setState((state) => {
      const entry = state.entries[key];
      if (!entry) throw new Error("Timeline performance entry was not opened");
      return {
        entries: {
          ...state.entries,
          [key]: { ...entry, timeline },
        },
      };
    });
    const selector = selectPullRequestTimelineResources(key);
    const selectorP95 = percentile95(() => {
      selector(usePullRequestDetailStore.getState());
    });
    const laneUpdateP95 = percentile95(() => {
      usePullRequestDetailStore.setState((state) => {
        const entry = state.entries[key];
        if (!entry) return state;
        return {
          entries: {
            ...state.entries,
            [key]: {
              ...entry,
              lanes: {
                ...entry.lanes,
                timelineNewer: {
                  ...entry.lanes.timelineNewer,
                  generation: entry.lanes.timelineNewer.generation + 1,
                },
              },
            },
          },
        };
      });
    });

    expect(selectorP95).toBeLessThan(PERFORMANCE_P95_MAX_MS);
    expect(laneUpdateP95).toBeLessThan(PERFORMANCE_P95_MAX_MS);
  });

  it("keeps a 500-file Code selector below the 2 ms p95 budget", () => {
    const snapshotKey = usePullRequestCodeStore.getState().activateSnapshot({
      viewerNodeId: "VIEWER_PERFORMANCE_UNIT",
      identity: IDENTITY,
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
    });
    const files = Array.from({ length: 500 }, (_, index) => ({
      locator: `FILE_${index}`,
      path: `src/file-${index}.ts`,
      previousPath: null,
      changeType: "modified" as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      blobOid: (index + 1).toString(16).padStart(40, "0"),
      patchStatus: "available" as const,
    }));
    usePullRequestCodeStore.setState((state) => {
      const entry = state.entries[snapshotKey];
      if (!entry) throw new Error("Code performance snapshot was not activated");
      return {
        entries: {
          ...state.entries,
          [snapshotKey]: { ...entry, files },
        },
      };
    });

    const selectorP95 = percentile95(() => {
      selectPullRequestCodeCore(usePullRequestCodeStore.getState());
    });

    expect(selectorP95).toBeLessThan(PERFORMANCE_P95_MAX_MS);
  });
});
