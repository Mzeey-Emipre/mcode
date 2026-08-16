import type {
  PullRequestDetail,
  PullRequestGetResult,
  PullRequestIdentity,
  PullRequestTimelineItem,
  PullRequestTimelineResult,
} from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  getPullRequestDetailKey,
  usePullRequestDetailStore,
} from "../pullRequestDetailStore";

const FRESHNESS = {
  snapshotVersion: "snapshot-1",
  fetchedAt: "2026-07-11T12:00:00.000Z",
  staleAt: "2026-07-11T12:00:30.000Z",
  boundedData: null,
} as const;

function identity(number: number): PullRequestIdentity {
  return {
    provider: "github",
    repositoryNodeId: "R_repo",
    owner: "Mzeey-Empire",
    repository: "mcode",
    number,
  };
}

function detail(value: PullRequestIdentity, title = `Pull request ${value.number}`): PullRequestDetail {
  return {
    identity: value,
    providerNodeId: `PR_${value.number}`,
    url: `https://github.com/Mzeey-Empire/mcode/pull/${value.number}`,
    title,
    body: "Read-only detail",
    author: null,
    state: "open",
    readiness: "ready",
    head: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: `codex/pr-${value.number}`,
      oid: "a".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "b".repeat(40),
    },
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    createdAt: "2026-07-11T11:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
    mergeability: "mergeable",
    mergeMethods: ["merge", "squash"],
    defaultMergeMethod: "squash",
    reviewDecision: "review_required",
    reviewers: [],
    checks: { state: "pending" },
    checkCount: 2,
    commentCount: 1,
    reviewThreadCount: 0,
  };
}

function detailResult(value: PullRequestIdentity, title?: string): PullRequestGetResult {
  return {
    ok: true,
    resource: "detail",
    item: detail(value, title),
    ...FRESHNESS,
  };
}

function timelineItem(number: number, occurredAt: string): PullRequestTimelineItem {
  return {
    kind: "opened",
    providerNodeId: `EV_${number}`,
    occurredAt,
    actor: null,
    url: null,
  };
}

function timelineResult(options: {
  lane: "initial" | "older" | "newer";
  items: PullRequestTimelineItem[];
  olderCursor?: string | null;
  newerCursor?: string | null;
  hasMoreOlder?: boolean;
  hasMoreNewer?: boolean;
}): PullRequestTimelineResult {
  return {
    ok: true,
    lane: options.lane,
    items: options.items,
    olderCursor: options.olderCursor ?? null,
    newerCursor: options.newerCursor ?? null,
    hasMoreOlder: options.hasMoreOlder ?? false,
    hasMoreNewer: options.hasMoreNewer ?? false,
    ...FRESHNESS,
    boundedData: options.hasMoreNewer ? { reason: "catch_up_limit" } : null,
  };
}

function fakeTransport(overrides: Partial<PullRequestTransport> = {}): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false }),
    get: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "remote_unavailable", message: "Unavailable" },
    }),
    timeline: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "remote_unavailable", message: "Unavailable" },
    }),
    files: vi.fn().mockResolvedValue({ ok: false }),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: true }),
    ...overrides,
  };
}

describe("pullRequestDetailStore", () => {
  beforeEach(() => {
    usePullRequestDetailStore.setState({ entries: {}, activeKey: null });
  });

  it("ignores an old identity response and cancels only its owned operation", async () => {
    let resolveFirst!: (result: PullRequestGetResult) => void;
    const firstResult = new Promise<PullRequestGetResult>((resolve) => {
      resolveFirst = resolve;
    });
    const transport = fakeTransport({
      get: vi
        .fn()
        .mockImplementationOnce(() => firstResult)
        .mockResolvedValueOnce(detailResult(identity(2))),
    });

    usePullRequestDetailStore.getState().open(identity(1), transport);
    const pending = usePullRequestDetailStore.getState().loadDetail(transport);
    await vi.waitFor(() => expect(transport.get).toHaveBeenCalledTimes(1));

    usePullRequestDetailStore.getState().open(identity(2), transport);
    await vi.waitFor(() => expect(transport.cancel).toHaveBeenCalledTimes(1));
    await usePullRequestDetailStore.getState().loadDetail(transport);
    resolveFirst(detailResult(identity(1), "Late result"));
    await pending;

    const state = usePullRequestDetailStore.getState();
    expect(state.activeKey).toBe(getPullRequestDetailKey(identity(2)));
    expect(state.entries[state.activeKey!]?.detail?.identity.number).toBe(2);
    expect(state.entries[getPullRequestDetailKey(identity(1))]?.detail).toBeNull();
  });

  it("preserves the last successful detail when a refresh fails", async () => {
    const transport = fakeTransport({
      get: vi
        .fn()
        .mockResolvedValueOnce(detailResult(identity(1), "Last success"))
        .mockResolvedValueOnce({
          ok: false,
          error: { code: "rate_limited", message: "Rate limited" },
        }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);

    await usePullRequestDetailStore.getState().loadDetail(transport);
    await usePullRequestDetailStore.getState().loadDetail(transport);

    const entry = usePullRequestDetailStore.getState().entries[getPullRequestDetailKey(identity(1))]!;
    expect(entry.detail?.title).toBe("Last success");
    expect(entry.lanes.detail).toMatchObject({
      status: "error",
      stale: true,
      error: { code: "rate_limited" },
    });
  });

  it("keeps an empty successful lane loaded and stale when its refresh fails", async () => {
    const transport = fakeTransport({
      get: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          resource: "checks",
          items: [],
          nextCursor: null,
          ...FRESHNESS,
        })
        .mockResolvedValueOnce({
          ok: false,
          error: { code: "remote_unavailable", message: "Refresh failed" },
        }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);

    await usePullRequestDetailStore.getState().loadChecks({ transport });
    let entry = usePullRequestDetailStore.getState().entries[getPullRequestDetailKey(identity(1))]!;
    expect(entry.lanes.checks).toMatchObject({ status: "ready", stale: false });
    expect(entry.lanes.checks.fetchedAt).not.toBeNull();

    await usePullRequestDetailStore.getState().loadChecks({ transport });
    entry = usePullRequestDetailStore.getState().entries[getPullRequestDetailKey(identity(1))]!;
    expect(entry.checks).toEqual([]);
    expect(entry.lanes.checks).toMatchObject({ status: "error", stale: true });
  });

  it("preserves an earlier bounded comments marker across later clean pages", async () => {
    const transport = fakeTransport({
      get: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          resource: "comments",
          items: [],
          nextCursor: "comments-next",
          ...FRESHNESS,
          boundedData: { reason: "record_limit" },
        })
        .mockResolvedValueOnce({
          ok: true,
          resource: "comments",
          items: [],
          nextCursor: null,
          ...FRESHNESS,
        }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);

    await usePullRequestDetailStore.getState().loadComments({ transport });
    await usePullRequestDetailStore
      .getState()
      .loadComments({ append: true, transport });

    const entry = usePullRequestDetailStore.getState().entries[
      getPullRequestDetailKey(identity(1))
    ]!;
    expect(entry.commentsNextCursor).toBeNull();
    expect(entry.lanes.comments.boundedData).toEqual({ reason: "record_limit" });
  });

  it("invalidates head-dependent data and cancels its in-flight lanes on head change", async () => {
    let detailReads = 0;
    let resolveComments!: (result: PullRequestGetResult) => void;
    const pendingComments = new Promise<PullRequestGetResult>((resolve) => {
      resolveComments = resolve;
    });
    const transport = fakeTransport({
      get: vi.fn().mockImplementation(async (request) => {
        if (request.resource === "detail") {
          detailReads += 1;
          const item = detail(identity(1));
          item.head = { ...item.head, oid: (detailReads === 1 ? "a" : "c").repeat(40) };
          return { ok: true, resource: "detail", item, ...FRESHNESS };
        }
        if (request.resource === "checks") {
          return {
            ok: true,
            resource: "checks",
            items: [{
              providerNodeId: "CHECK_1",
              kind: "check_run",
              name: "Unit tests",
              state: "passing",
              isRequired: null,
              detailsUrl: null,
              startedAt: null,
              completedAt: null,
              updatedAt: "2026-07-11T12:00:00.000Z",
            }],
            nextCursor: "checks-next",
            ...FRESHNESS,
          };
        }
        return pendingComments;
      }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);
    await usePullRequestDetailStore.getState().loadDetail(transport);
    await usePullRequestDetailStore.getState().loadChecks({ transport });
    const commentsLoad = usePullRequestDetailStore.getState().loadComments({ transport });
    await vi.waitFor(() => expect(transport.get).toHaveBeenCalledTimes(3));

    await usePullRequestDetailStore.getState().loadDetail(transport);
    await vi.waitFor(() => expect(transport.cancel).toHaveBeenCalledTimes(1));
    resolveComments({
      ok: true,
      resource: "comments",
      items: [],
      nextCursor: null,
      ...FRESHNESS,
    });
    await commentsLoad;

    const entry = usePullRequestDetailStore.getState().entries[getPullRequestDetailKey(identity(1))]!;
    expect(entry.detail?.head.oid).toBe("c".repeat(40));
    expect(entry.checks).toEqual([]);
    expect(entry.checksNextCursor).toBeNull();
    expect(entry.comments).toEqual([]);
    expect(entry.timeline).toEqual([]);
    expect(entry.lanes.checks.fetchedAt).toBeNull();
    expect(entry.lanes.comments.fetchedAt).toBeNull();
  });

  it("sorts Timeline ties by provider ID and catches up at most four pages", async () => {
    let newerPage = 0;
    const transport = fakeTransport({
      timeline: vi.fn().mockImplementation(async (request) => {
        if (request.lane === "initial") {
          return timelineResult({
            lane: "initial",
            items: [
              timelineItem(2, "2026-07-11T12:00:00.000Z"),
              timelineItem(1, "2026-07-11T12:00:00.000Z"),
            ],
            newerCursor: "cursor-0",
          });
        }
        newerPage += 1;
        return timelineResult({
          lane: "newer",
          items: [timelineItem(newerPage + 2, `2026-07-11T12:0${newerPage}:00.000Z`)],
          newerCursor: `cursor-${newerPage}`,
          hasMoreNewer: true,
        });
      }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);

    await usePullRequestDetailStore.getState().loadTimeline(transport);
    await usePullRequestDetailStore.getState().catchUpTimeline(transport);

    const entry = usePullRequestDetailStore.getState().entries[getPullRequestDetailKey(identity(1))]!;
    expect(transport.timeline).toHaveBeenCalledTimes(5);
    expect(entry.timeline.map((item) => item.providerNodeId)).toEqual([
      "EV_1",
      "EV_2",
      "EV_3",
      "EV_4",
      "EV_5",
      "EV_6",
    ]);
    expect(entry.newerCursor).toBe("cursor-4");
    expect(entry.lanes.timelineNewer).toMatchObject({
      stale: true,
      boundedData: { reason: "catch_up_limit" },
    });
  });

  it("rebases newer Timeline success onto concurrent lane updates", async () => {
    let resolveNewer!: (result: PullRequestTimelineResult) => void;
    const newerResult = new Promise<PullRequestTimelineResult>((resolve) => {
      resolveNewer = resolve;
    });
    const transport = fakeTransport({
      get: vi.fn().mockImplementation(async (request) => {
        if (request.resource === "detail") return detailResult(identity(1), "Concurrent detail");
        if (request.resource === "checks") {
          return {
            ok: true,
            resource: "checks",
            items: [{
              providerNodeId: "CHECK_concurrent",
              kind: "check_run",
              name: "Concurrent check",
              state: "passing",
              isRequired: null,
              detailsUrl: null,
              startedAt: null,
              completedAt: null,
              updatedAt: "2026-07-11T12:00:00.000Z",
            }],
            nextCursor: null,
            ...FRESHNESS,
          };
        }
        return {
          ok: true,
          resource: "comments",
          items: [{
            kind: "issue_comment",
            providerNodeId: "COMMENT_concurrent",
            author: null,
            body: "Concurrent comment",
            createdAt: "2026-07-11T12:00:00.000Z",
            updatedAt: "2026-07-11T12:00:00.000Z",
            url: null,
          }],
          nextCursor: null,
          ...FRESHNESS,
        };
      }),
      timeline: vi.fn().mockImplementation(async (request) => {
        if (request.lane === "initial") {
          return timelineResult({
            lane: "initial",
            items: [timelineItem(1, "2026-07-11T11:00:00.000Z")],
            olderCursor: "older-1",
            newerCursor: "newer-1",
            hasMoreOlder: true,
          });
        }
        if (request.lane === "older") {
          return timelineResult({
            lane: "older",
            items: [timelineItem(0, "2026-07-11T10:00:00.000Z")],
            olderCursor: "older-final",
          });
        }
        return newerResult;
      }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);
    await usePullRequestDetailStore.getState().loadTimeline(transport);
    const catchingUp = usePullRequestDetailStore.getState().catchUpTimeline(transport);
    await vi.waitFor(() => expect(transport.timeline).toHaveBeenCalledTimes(2));

    await usePullRequestDetailStore.getState().loadDetail(transport);
    await usePullRequestDetailStore.getState().loadChecks({ transport });
    await usePullRequestDetailStore.getState().loadComments({ transport });
    await usePullRequestDetailStore.getState().loadOlderTimeline(transport);
    resolveNewer(timelineResult({
      lane: "newer",
      items: [timelineItem(2, "2026-07-11T13:00:00.000Z")],
      newerCursor: "newer-final",
    }));
    await catchingUp;

    const entry = usePullRequestDetailStore.getState().entries[
      getPullRequestDetailKey(identity(1))
    ]!;
    expect(entry.detail?.title).toBe("Concurrent detail");
    expect(entry.checks.map((item) => item.providerNodeId)).toEqual(["CHECK_concurrent"]);
    expect(entry.comments.map((item) => item.providerNodeId)).toEqual(["COMMENT_concurrent"]);
    expect(entry.timeline.map((item) => item.providerNodeId)).toEqual([
      "EV_0",
      "EV_1",
      "EV_2",
    ]);
    expect(entry.olderCursor).toBe("older-final");
    expect(entry.newerCursor).toBe("newer-final");
    expect(entry.lanes).toMatchObject({
      detail: { status: "ready", fetchedAt: expect.any(Number) },
      checks: { status: "ready", fetchedAt: expect.any(Number) },
      comments: { status: "ready", fetchedAt: expect.any(Number) },
      timelineOlder: { status: "ready", fetchedAt: expect.any(Number) },
      timelineNewer: { status: "ready", fetchedAt: expect.any(Number) },
    });
  });

  it("orders offset timestamps by instant with provider-ID ties", async () => {
    const comments = [
      { id: 3, timestamp: "2026-07-11T10:00:00-05:00" },
      { id: 2, timestamp: "2026-07-11T12:00:00Z" },
      { id: 1, timestamp: "2026-07-11T15:00:00Z" },
    ];
    const transport = fakeTransport({
      get: vi.fn().mockResolvedValue({
        ok: true,
        resource: "comments",
        items: comments.map(({ id, timestamp }) => ({
          kind: "issue_comment" as const,
          providerNodeId: `COMMENT_${id}`,
          author: null,
          body: `Comment ${id}`,
          createdAt: timestamp,
          updatedAt: timestamp,
          url: null,
        })),
        nextCursor: null,
        ...FRESHNESS,
      }),
      timeline: vi.fn().mockResolvedValue(timelineResult({
        lane: "initial",
        items: comments.map(({ id, timestamp }) => timelineItem(id, timestamp)),
      })),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);

    await usePullRequestDetailStore.getState().loadComments({ transport });
    await usePullRequestDetailStore.getState().loadTimeline(transport);

    const entry = usePullRequestDetailStore.getState().entries[
      getPullRequestDetailKey(identity(1))
    ]!;
    expect(entry.comments.map((item) => item.providerNodeId)).toEqual([
      "COMMENT_2",
      "COMMENT_1",
      "COMMENT_3",
    ]);
    expect(entry.timeline.map((item) => item.providerNodeId)).toEqual([
      "EV_2",
      "EV_1",
      "EV_3",
    ]);
  });

  it("stops checks pagination before the one-thousand-record cap", async () => {
    let page = 0;
    const transport = fakeTransport({
      get: vi.fn().mockImplementation(async () => {
        const start = page * 30;
        const length = page === 33 ? 10 : 30;
        page += 1;
        return {
          ok: true,
          resource: "checks",
          items: Array.from({ length }, (_, index) => ({
            providerNodeId: `CHECK_${start + index}`,
            kind: "check_run" as const,
            name: `Check ${start + index}`,
            state: "passing" as const,
            isRequired: null,
            detailsUrl: null,
            startedAt: null,
            completedAt: null,
            updatedAt: "2026-07-11T12:00:00.000Z",
          })),
          nextCursor: `cursor-${page}`,
          ...FRESHNESS,
        };
      }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);

    await usePullRequestDetailStore.getState().loadChecks({ transport });
    for (let index = 0; index < 32; index += 1) {
      await usePullRequestDetailStore.getState().loadChecks({ append: true, transport });
    }
    const mergeStartedAt = performance.now();
    await usePullRequestDetailStore.getState().loadChecks({ append: true, transport });
    const mergeDurationMs = performance.now() - mergeStartedAt;
    await usePullRequestDetailStore.getState().loadChecks({ append: true, transport });

    const entry = usePullRequestDetailStore.getState().entries[getPullRequestDetailKey(identity(1))]!;
    expect(entry.checks).toHaveLength(1_000);
    expect(entry.checksNextCursor).toBeNull();
    expect(entry.lanes.checks.boundedData).toEqual({ reason: "record_limit" });
    expect(mergeDurationMs).toBeLessThan(2);
  });

  it("retains one thousand Timeline events alongside core detail metadata", async () => {
    const transport = fakeTransport({
      get: vi.fn().mockResolvedValue(detailResult(identity(1))),
      timeline: vi.fn().mockImplementation(async (request) => {
        const end = request.lane === "initial" ? 1_000 : Number(request.cursor);
        const start = Math.max(0, end - 30);
        return timelineResult({
          lane: request.lane,
          items: Array.from({ length: end - start }, (_, offset) => {
            const index = start + offset;
            return timelineItem(
              index,
              new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
            );
          }),
          olderCursor: start > 0 ? String(start) : null,
          newerCursor: request.lane === "initial" ? "newest" : null,
          hasMoreOlder: start > 0,
        });
      }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);
    await usePullRequestDetailStore.getState().loadDetail(transport);
    await usePullRequestDetailStore.getState().loadTimeline(transport);

    for (let page = 0; page < 40; page += 1) {
      const entry = usePullRequestDetailStore.getState().entries[
        getPullRequestDetailKey(identity(1))
      ]!;
      if (!entry.hasMoreOlder) break;
      await usePullRequestDetailStore.getState().loadOlderTimeline(transport);
    }

    const entry = usePullRequestDetailStore.getState().entries[
      getPullRequestDetailKey(identity(1))
    ]!;
    expect(entry.detail?.providerNodeId).toBe("PR_1");
    expect(entry.timeline).toHaveLength(1_000);
    expect(entry.hasMoreOlder).toBe(false);
    expect(entry.lanes.timelineOlder.boundedData).toBeNull();
    expect(transport.timeline).toHaveBeenCalledTimes(34);
  });

  it("stops comments pagination before one identity exceeds eight MiB", async () => {
    let page = 0;
    const body = "x".repeat(64 * 1024);
    const transport = fakeTransport({
      get: vi.fn().mockImplementation(async () => {
        const start = page * 30;
        page += 1;
        return {
          ok: true,
          resource: "comments",
          items: Array.from({ length: 30 }, (_, index) => ({
            kind: "issue_comment" as const,
            providerNodeId: `COMMENT_${start + index}`,
            author: null,
            body,
            createdAt: `2026-07-11T12:${String(index).padStart(2, "0")}:00.000Z`,
            updatedAt: `2026-07-11T12:${String(index).padStart(2, "0")}:00.000Z`,
            url: null,
          })),
          nextCursor: `cursor-${page}`,
          ...FRESHNESS,
        };
      }),
    });
    usePullRequestDetailStore.getState().open(identity(1), transport);

    await usePullRequestDetailStore.getState().loadComments({ transport });
    for (let index = 0; index < 4; index += 1) {
      await usePullRequestDetailStore.getState().loadComments({ append: true, transport });
    }

    const entry = usePullRequestDetailStore.getState().entries[getPullRequestDetailKey(identity(1))]!;
    expect(entry.comments.length).toBeGreaterThan(0);
    expect(entry.estimatedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(entry.commentsNextCursor).toBeNull();
    expect(entry.lanes.comments.boundedData).toEqual({ reason: "byte_limit" });
  });

  it("evicts the oldest inactive identity while protecting the open entry", () => {
    const transport = fakeTransport();
    for (let number = 1; number <= 26; number += 1) {
      usePullRequestDetailStore.getState().open(identity(number), transport);
    }

    const state = usePullRequestDetailStore.getState();
    expect(Object.keys(state.entries)).toHaveLength(25);
    expect(state.entries[getPullRequestDetailKey(identity(1))]).toBeUndefined();
    expect(state.entries[getPullRequestDetailKey(identity(26))]).toBeDefined();
    expect(state.activeKey).toBe(getPullRequestDetailKey(identity(26)));
  });

  it("caps normalized records across identities while protecting the open entry", async () => {
    const transport = fakeTransport({
      get: vi.fn().mockImplementation(async (request) => ({
        ok: true,
        resource: "checks",
        items: Array.from({ length: 350 }, (_, index) => ({
          providerNodeId: `CHECK_${request.identity.number}_${index}`,
          kind: "check_run" as const,
          name: `Check ${request.identity.number}-${index}`,
          state: "passing" as const,
          isRequired: null,
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-07-11T12:00:00.000Z",
        })),
        nextCursor: null,
        ...FRESHNESS,
      })),
    });
    for (const number of [1, 2, 3]) {
      usePullRequestDetailStore.getState().open(identity(number), transport);
      await usePullRequestDetailStore.getState().loadChecks({ transport });
    }

    const state = usePullRequestDetailStore.getState();
    expect(state.entries[getPullRequestDetailKey(identity(1))]).toBeUndefined();
    expect(state.entries[getPullRequestDetailKey(identity(2))]?.checks).toHaveLength(350);
    expect(state.entries[getPullRequestDetailKey(identity(3))]?.checks).toHaveLength(350);
    expect(state.activeKey).toBe(getPullRequestDetailKey(identity(3)));
    expect(
      Object.values(state.entries).reduce(
        (total, entry) => total + entry.checks.length,
        0,
      ),
    ).toBeLessThanOrEqual(1_000);
  });
});
