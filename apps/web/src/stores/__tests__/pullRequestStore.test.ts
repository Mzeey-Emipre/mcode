import type {
  PullRequestCapabilitiesResult,
  PullRequestListRequest,
  PullRequestListResult,
  PullRequestRelationship,
  PullRequestSummary,
} from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  filterPullRequestKeys,
  selectTeamRequestLimitation,
} from "../pull-request-selectors";
import {
  getPullRequestKey,
  getRelationshipsForInboxTab,
  usePullRequestStore,
} from "../pullRequestStore";

function summary(
  number: number,
  relationships: PullRequestRelationship[] = ["authored"],
): PullRequestSummary {
  return {
    identity: {
      provider: "github",
      repositoryNodeId: "repo-node",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number,
    },
    url: `https://github.com/Mzeey-Empire/mcode/pull/${number}`,
    title: `Pull request ${number}`,
    author: {
      providerNodeId: "actor-node",
      login: "reviewer",
      avatarUrl: null,
      profileUrl: null,
    },
    state: "open",
    readiness: "ready",
    head: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: `feature-${number}`,
      oid: null,
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: null,
    },
    relationships,
    checks: { state: "passing" },
    commentCount: 0,
    additions: number,
    deletions: 0,
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

function listResult(
  items: PullRequestSummary[],
  nextCursor: string | null = null,
): PullRequestListResult {
  return {
    ok: true,
    items,
    nextCursor,
    snapshotVersion: "snapshot-1",
    fetchedAt: "2026-07-11T12:00:00.000Z",
    staleAt: "2099-07-11T12:00:30.000Z",
    limitations: [],
  };
}

function capabilitiesResult(teamAllowed = true): PullRequestCapabilitiesResult {
  const allowed = { allowed: true as const };
  return {
    ok: true,
    viewer: {
      providerNodeId: "viewer-node",
      login: "viewer",
      avatarUrl: null,
      profileUrl: null,
    },
    capabilities: {
      read: allowed,
      teamRequests: teamAllowed
        ? allowed
        : { allowed: false, reason: "missing_scope" },
      comment: allowed,
      review: allowed,
      readiness: allowed,
      close: allowed,
      merge: allowed,
      reviewWorktree: allowed,
    },
    fetchedAt: "2026-07-11T12:00:00.000Z",
    staleAt: "2099-07-11T12:00:30.000Z",
  };
}

function fakeTransport(
  list: (request: PullRequestListRequest) => Promise<PullRequestListResult>,
  teamAllowed = true,
): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue(capabilitiesResult(teamAllowed)),
    list: vi.fn(list),
    get: vi.fn().mockResolvedValue({ ok: false }),
    timeline: vi.fn().mockResolvedValue({ ok: false }),
    files: vi.fn().mockResolvedValue({ ok: false }),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: true }),
  };
}

describe("pullRequestStore", () => {
  beforeEach(() => {
    usePullRequestStore.getState().reset();
  });

  it("maps relationship tabs to deterministic provider queries", () => {
    expect(getRelationshipsForInboxTab("authored")).toEqual(["authored"]);
    expect(getRelationshipsForInboxTab("reviewing")).toEqual([
      "direct_review_requested",
      "team_review_requested",
      "reviewed",
    ]);
    expect(getRelationshipsForInboxTab("all")).toEqual([
      "authored",
      "direct_review_requested",
      "team_review_requested",
      "reviewed",
    ]);
  });

  it("uses one RPC per page and merges duplicate relationships", async () => {
    const transport = fakeTransport(
      vi
        .fn()
        .mockResolvedValueOnce(listResult([summary(1, ["authored"])], "next"))
        .mockResolvedValueOnce(
          listResult([summary(1, ["direct_review_requested"]), summary(2)]),
        ),
    );

    await usePullRequestStore.getState().loadFirstPage(transport);
    usePullRequestStore.getState().setRelationship("authored");
    await usePullRequestStore.getState().loadNextPage(transport);

    expect(transport.list).toHaveBeenCalledTimes(2);
    expect(transport.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: "next",
        relationships: getRelationshipsForInboxTab("all"),
      }),
    );
    expect(usePullRequestStore.getState().orderedKeys).toHaveLength(2);
    expect(usePullRequestStore.getState().loadedRelationship).toBe("all");
    const first =
      usePullRequestStore.getState().entities[getPullRequestKey(summary(1))];
    expect(first?.relationships).toEqual([
      "authored",
      "direct_review_requested",
    ]);
  });

  it("retains normalized rows and selection after the response-page cache rolls over", async () => {
    let pageNumber = 0;
    const transport = fakeTransport(
      vi.fn().mockImplementation(async () => {
        pageNumber += 1;
        const firstNumber = (pageNumber - 1) * 30 + 1;
        const items =
          pageNumber === 11
            ? [
                summary(1, ["direct_review_requested"]),
                ...Array.from({ length: 29 }, (_, index) =>
                  summary(301 + index),
                ),
              ]
            : Array.from({ length: 30 }, (_, index) =>
                summary(firstNumber + index),
              );
        return listResult(
          items,
          pageNumber < 11 ? `cursor-${pageNumber}` : null,
        );
      }),
    );

    await usePullRequestStore.getState().loadFirstPage(transport);
    const firstKey = getPullRequestKey(summary(1));
    usePullRequestStore.getState().setSelectedKey(firstKey);
    for (let page = 2; page <= 11; page += 1) {
      await usePullRequestStore.getState().loadNextPage(transport);
    }

    const state = usePullRequestStore.getState();
    expect(transport.list).toHaveBeenCalledTimes(11);
    expect(state.pages).toHaveLength(10);
    expect(state.orderedKeys).toHaveLength(329);
    expect(state.entities[firstKey]?.relationships).toEqual([
      "authored",
      "direct_review_requested",
    ]);
    expect(state.selectedKey).toBe(firstKey);
  });

  it("retains the newest bounded results and stops pagination at the normalized cap", async () => {
    let pageNumber = 0;
    const transport = fakeTransport(
      vi.fn().mockImplementation(async () => {
        pageNumber += 1;
        const firstNumber = (pageNumber - 1) * 30 + 1;
        return listResult(
          Array.from({ length: 30 }, (_, index) =>
            summary(firstNumber + index),
          ),
          `cursor-${pageNumber}`,
        );
      }),
    );

    await usePullRequestStore.getState().loadFirstPage(transport);
    for (let page = 2; page <= 34; page += 1) {
      await usePullRequestStore.getState().loadNextPage(transport);
    }
    await usePullRequestStore.getState().loadNextPage(transport);

    const state = usePullRequestStore.getState();
    expect(transport.list).toHaveBeenCalledTimes(34);
    expect(state.pages).toHaveLength(10);
    expect(state.orderedKeys).toHaveLength(1_000);
    expect(state.entities[getPullRequestKey(summary(1))]).toBeDefined();
    expect(state.entities[getPullRequestKey(summary(1_000))]).toBeDefined();
    expect(state.entities[getPullRequestKey(summary(1_001))]).toBeUndefined();
    expect(state.nextCursor).toBeNull();
  });

  it("keeps a newer query when an older response arrives late", async () => {
    let resolveFirst!: (result: PullRequestListResult) => void;
    let resolveSecond!: (result: PullRequestListResult) => void;
    const transport = fakeTransport(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<PullRequestListResult>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<PullRequestListResult>((resolve) => {
              resolveSecond = resolve;
            }),
        ),
    );

    const firstLoad = usePullRequestStore.getState().loadFirstPage(transport);
    await vi.waitFor(() => expect(transport.list).toHaveBeenCalledTimes(1));
    usePullRequestStore.getState().setSearch("new query");
    const secondLoad = usePullRequestStore.getState().loadFirstPage(transport);
    await vi.waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));
    resolveSecond(listResult([summary(2)]));
    await secondLoad;
    resolveFirst(listResult([summary(1)]));
    await firstLoad;

    expect(transport.cancel).toHaveBeenCalledTimes(1);
    expect(usePullRequestStore.getState().orderedKeys).toEqual([
      getPullRequestKey(summary(2)),
    ]);
  });

  it("preserves loaded rows and marks them stale when refresh fails", async () => {
    const transport = fakeTransport(
      vi
        .fn()
        .mockResolvedValueOnce(listResult([summary(1)]))
        .mockResolvedValueOnce({
          ok: false,
          error: { code: "rate_limited", message: "Rate limit reached" },
        }),
    );

    await usePullRequestStore.getState().loadFirstPage(transport);
    await usePullRequestStore.getState().loadFirstPage(transport);

    expect(usePullRequestStore.getState()).toMatchObject({
      orderedKeys: [getPullRequestKey(summary(1))],
      stale: true,
      status: "error",
      error: { code: "rate_limited" },
    });
  });

  it("exposes missing team scope as a capability limitation", async () => {
    const transport = fakeTransport(async () => listResult([]), false);

    await usePullRequestStore.getState().loadCapabilities(transport);

    expect(selectTeamRequestLimitation(usePullRequestStore.getState())).toBe(
      "missing_scope",
    );
  });

  it("turns a failed capability read into a typed unavailable state", async () => {
    const transport = fakeTransport(async () => listResult([]));
    vi.mocked(transport.getCapabilities).mockResolvedValue({
      ok: false,
      error: {
        code: "unauthenticated",
        message: "GitHub authentication is required",
      },
    });

    await usePullRequestStore.getState().loadCapabilities(transport);

    expect(usePullRequestStore.getState().capabilities?.merge).toEqual({
      allowed: false,
      reason: "unauthenticated",
    });
  });

  it("keeps the newest capability generation when an older read resolves late", async () => {
    let resolveFirst!: (result: PullRequestCapabilitiesResult) => void;
    let resolveSecond!: (result: PullRequestCapabilitiesResult) => void;
    const transport = fakeTransport(async () => listResult([]));
    vi.mocked(transport.getCapabilities)
      .mockImplementationOnce(
        () =>
          new Promise<PullRequestCapabilitiesResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<PullRequestCapabilitiesResult>((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const firstLoad = usePullRequestStore
      .getState()
      .loadCapabilities(transport);
    await vi.waitFor(() =>
      expect(transport.getCapabilities).toHaveBeenCalledTimes(1),
    );
    const firstOperationId = vi.mocked(transport.getCapabilities).mock
      .calls[0]?.[0].operationId;
    const secondLoad = usePullRequestStore
      .getState()
      .loadCapabilities(transport);
    await vi.waitFor(() =>
      expect(transport.getCapabilities).toHaveBeenCalledTimes(2),
    );
    const newer = capabilitiesResult();
    if (!newer.ok) throw new Error("Expected capability success fixture");
    resolveSecond({
      ...newer,
      viewer: {
        ...newer.viewer,
        providerNodeId: "viewer-new",
        login: "viewer-new",
      },
    });
    await secondLoad;
    resolveFirst(capabilitiesResult());
    await firstLoad;

    expect(transport.cancel).toHaveBeenCalledWith({
      operationId: firstOperationId,
    });
    expect(usePullRequestStore.getState().viewer).toMatchObject({
      login: "viewer-new",
    });
  });

  it("keeps a capability read alive while the inbox list refreshes", async () => {
    let resolveCapabilities!: (
      result: PullRequestCapabilitiesResult,
    ) => void;
    let resolveList!: (result: PullRequestListResult) => void;
    const transport = fakeTransport(
      () =>
        new Promise<PullRequestListResult>((resolve) => {
          resolveList = resolve;
        }),
    );
    vi.mocked(transport.getCapabilities).mockImplementation(
      () =>
        new Promise<PullRequestCapabilitiesResult>((resolve) => {
          resolveCapabilities = resolve;
        }),
    );

    const capabilitiesLoad = usePullRequestStore
      .getState()
      .loadCapabilities(transport);
    await vi.waitFor(() =>
      expect(transport.getCapabilities).toHaveBeenCalledOnce(),
    );
    const listLoad = usePullRequestStore.getState().loadFirstPage(transport);
    await vi.waitFor(() => expect(transport.list).toHaveBeenCalledOnce());

    resolveList(listResult([summary(1)]));
    await listLoad;
    resolveCapabilities(capabilitiesResult());
    await capabilitiesLoad;

    expect(usePullRequestStore.getState().viewer).toMatchObject({
      login: "viewer",
    });
    expect(usePullRequestStore.getState().capabilities?.merge).toEqual({
      allowed: true,
    });
  });

  it("filters normalized rows by repository, author, review state, and checks", () => {
    const first = summary(1, ["authored"]);
    const second: PullRequestSummary = {
      ...summary(2, ["direct_review_requested"]),
      identity: {
        ...summary(2).identity,
        repositoryNodeId: "other-repo-node",
        owner: "example",
        repository: "other",
      },
      author: {
        providerNodeId: "other-actor",
        login: "other-author",
        avatarUrl: null,
        profileUrl: null,
      },
      checks: { state: "failing" },
    };
    const firstKey = getPullRequestKey(first);
    const secondKey = getPullRequestKey(second);
    usePullRequestStore.setState({
      entities: { [firstKey]: first, [secondKey]: second },
      orderedKeys: [firstKey, secondKey],
      repositoryFilter: "example/other",
      authorFilter: "other-author",
      reviewFilters: ["direct_review_requested"],
      checkFilters: ["failing"],
    });

    expect(filterPullRequestKeys(usePullRequestStore.getState())).toEqual([
      secondKey,
    ]);
  });
});
