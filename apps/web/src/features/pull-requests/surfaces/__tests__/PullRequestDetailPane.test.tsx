import type {
  PullRequestCapabilitiesResult,
  PullRequestDetail,
  PullRequestGetResult,
  PullRequestIdentity,
  PullRequestSummary,
} from "@mcode/contracts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestDetailKey,
  usePullRequestDetailStore,
} from "@/features/pull-requests/state/pullRequestDetailStore";
import {
  getPullRequestMutationLaneKey,
  usePullRequestMutationStore,
  type PullRequestMutationLane,
} from "@/features/pull-requests/state/pullRequestMutationStore";
import { usePullRequestStore } from "@/features/pull-requests/state/pullRequestStore";
import type { PullRequestTransport } from "@/transport/pull-requests";
import type { PullRequestReviewTaskTransport } from "@/transport/pull-request-review-task";
import { clearCommands, getCommand } from "@/lib/command-registry";

vi.mock("../PullRequestCode", () => ({
  PullRequestCode: ({
    baseOid,
    headOid,
  }: {
    baseOid: string;
    headOid: string;
  }) => (
    <div data-testid="pull-request-code-panel">
      {baseOid.slice(0, 4)}:{headOid.slice(0, 4)}
    </div>
  ),
}));

vi.mock("../PullRequestForkDialog", () => ({
  PullRequestForkDialog: ({ mode }: { mode: string }) => (
    <div role="dialog" aria-label="Fork pull request">
      {mode}
    </div>
  ),
}));

import { PullRequestDetailPane } from "../PullRequestDetailPane";

const identity: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 1,
};

function summary(): PullRequestSummary {
  return {
    identity,
    url: "https://github.com/Mzeey-Empire/mcode/pull/1",
    title: "Persistent summary header",
    author: null,
    state: "open",
    readiness: "ready",
    head: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "codex/detail",
      oid: "a".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "b".repeat(40),
    },
    relationships: ["authored"],
    checks: { state: "pending" },
    commentCount: 0,
    additions: 8,
    deletions: 2,
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

function detail(headOid: string | null = "a".repeat(40)): PullRequestDetail {
  return {
    ...summary(),
    head: { ...summary().head, oid: headOid },
    providerNodeId: "PR_1",
    body: "Read-only detail body",
    changedFiles: 2,
    createdAt: "2026-07-11T11:00:00.000Z",
    mergeability: "mergeable",
    mergeMethods: ["merge", "squash"],
    defaultMergeMethod: "squash",
    reviewDecision: "review_required",
    reviewers: [],
    checkCount: 2,
    reviewThreadCount: 0,
  };
}

function freshness() {
  const fetchedAt = Date.now();
  return {
    snapshotVersion: "snapshot-1",
    fetchedAt: new Date(fetchedAt).toISOString(),
    staleAt: new Date(fetchedAt + 30_000).toISOString(),
    boundedData: null,
  } as const;
}

function detailResult(
  headOid: string | null = "a".repeat(40),
): PullRequestGetResult {
  return {
    ok: true,
    resource: "detail",
    item: detail(headOid),
    ...freshness(),
  };
}

function fakeTransport(
  overrides: Partial<PullRequestTransport> = {},
): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false }),
    get: vi.fn().mockResolvedValue(detailResult()),
    timeline: vi.fn().mockResolvedValue({
      ok: true,
      lane: "initial",
      items: [],
      olderCursor: null,
      newerCursor: "timeline-end",
      hasMoreOlder: false,
      hasMoreNewer: false,
      ...freshness(),
    }),
    files: vi.fn().mockResolvedValue({ ok: false }),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: true }),
    ...overrides,
  };
}

function renderPane(
  transport: PullRequestTransport,
  reviewTaskTransport?: PullRequestReviewTaskTransport,
) {
  usePullRequestDetailStore.getState().open(identity, transport);
  return render(
    <PullRequestDetailPane
      identityKey={getPullRequestDetailKey(identity)}
      summaryFallback={summary()}
      isNarrow={false}
      onClose={vi.fn()}
      transport={transport}
      reviewTaskTransport={reviewTaskTransport}
    />,
  );
}

function outcomeUnknownLane(): PullRequestMutationLane {
  const error = {
    code: "conflict" as const,
    conflictReason: "outcome_unknown" as const,
    message: "The remote outcome could not be confirmed.",
  };
  return {
    effect: "comment",
    status: "error",
    idempotencyKey: "unknown-comment-receipt",
    request: null,
    error,
    result: { ok: false, error },
    draftSnapshotKey: null,
    updatedAt: 1,
  };
}

describe("PullRequestDetailPane", () => {
  beforeEach(() => {
    usePullRequestDetailStore.setState({ entries: {}, activeKey: null });
    usePullRequestMutationStore.setState({ lanes: {}, commentDrafts: {} });
    usePullRequestStore.getState().reset();
    clearCommands();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the inbox summary header visible while detail loads and after failure", async () => {
    let resolveDetail!: (result: PullRequestGetResult) => void;
    const transport = fakeTransport({
      get: vi.fn().mockImplementation(
        () =>
          new Promise<PullRequestGetResult>((resolve) => {
            resolveDetail = resolve;
          }),
      ),
    });
    renderPane(transport);

    expect(
      screen.getByRole("heading", { name: "Persistent summary header" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Loading pull request detail")).toBeVisible();
    resolveDetail({
      ok: false,
      error: { code: "remote_unavailable", message: "Detail failed" },
    });

    expect(await screen.findByText("Detail failed")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Persistent summary header" }),
    ).toBeVisible();
  });

  it("loads capability status for the visible detail actions", async () => {
    const capabilityResult: PullRequestCapabilitiesResult = {
      ok: true,
      viewer: {
        providerNodeId: "viewer-node",
        login: "mcode-reviewer",
        avatarUrl: null,
        profileUrl: null,
      },
      capabilities: {
        read: { allowed: true },
        teamRequests: { allowed: true },
        comment: { allowed: true },
        review: { allowed: true },
        readiness: { allowed: true },
        close: { allowed: true },
        merge: { allowed: true },
        reviewWorktree: { allowed: true },
      },
      fetchedAt: "2026-07-11T12:00:00.000Z",
      staleAt: "2099-07-11T12:00:30.000Z",
    };
    const getCapabilities = vi.fn().mockResolvedValue(capabilityResult);
    const transport = fakeTransport({ getCapabilities });

    renderPane(transport);

    await waitFor(() => expect(getCapabilities).toHaveBeenCalledOnce());
    expect(usePullRequestStore.getState().viewer?.login).toBe("mcode-reviewer");
    expect(usePullRequestStore.getState().capabilities?.merge).toEqual({
      allowed: true,
    });
  });

  it("surfaces a bounded description marker from the detail lane", async () => {
    const transport = fakeTransport({
      get: vi.fn().mockResolvedValue({
        ...detailResult(),
        boundedData: { reason: "byte_limit" },
      }),
    });
    renderPane(transport);

    expect(
      await screen.findByText(
        "Description truncated at the remote data limit.",
      ),
    ).toBeVisible();
  });

  it("loads checks when the default-open section mounts and reuses the result", async () => {
    let resolveChecks!: (result: PullRequestGetResult) => void;
    const transport = fakeTransport({
      get: vi.fn().mockImplementation((request) => {
        if (request.resource === "detail")
          return Promise.resolve(detailResult());
        if (request.resource === "checks") {
          return new Promise<PullRequestGetResult>((resolve) => {
            resolveChecks = resolve;
          });
        }
        return Promise.resolve({ ok: false });
      }),
    });
    renderPane(transport);
    await waitFor(() =>
      expect(
        vi
          .mocked(transport.get)
          .mock.calls.some(([request]) => request.resource === "detail"),
      ).toBe(true),
    );
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", {
      name: "Checks, 0 loaded of 2",
    });
    expect(await screen.findByText("Loading checks")).toBeVisible();
    expect(
      vi
        .mocked(transport.get)
        .mock.calls.filter(([request]) => request.resource === "checks"),
    ).toHaveLength(1);

    resolveChecks({
      ok: true,
      resource: "checks",
      items: [],
      nextCursor: null,
      ...freshness(),
    });
    expect(await screen.findByText("No checks reported.")).toBeVisible();
    await user.click(trigger);
    await user.click(trigger);
    expect(
      vi
        .mocked(transport.get)
        .mock.calls.filter(([request]) => request.resource === "checks"),
    ).toHaveLength(1);
  });

  it("uses roving detail tabs and loads Timeline on keyboard activation", async () => {
    const transport = fakeTransport();
    renderPane(transport);
    const summaryTab = await screen.findByRole("tab", { name: "summary" });
    const timelineTab = screen.getByRole("tab", { name: "timeline" });
    expect(summaryTab).toHaveAttribute("aria-selected", "true");
    expect(summaryTab).toHaveAttribute("tabindex", "0");

    summaryTab.focus();
    fireEvent.keyDown(summaryTab, { key: "ArrowRight" });
    expect(timelineTab).toHaveFocus();
    expect(timelineTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(transport.timeline).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(timelineTab, { key: "Home" });
    expect(summaryTab).toHaveFocus();
    expect(summaryTab).toHaveAttribute("aria-selected", "true");
  });

  it("places page tabs before Summary content and exposes an icon-only browser action", async () => {
    const transport = fakeTransport();
    renderPane(transport);

    const tabs = await screen.findByRole("tablist", {
      name: "Pull request detail views",
    });
    const heading = screen.getByRole("heading", {
      name: "Persistent summary header",
    });
    expect(tabs.compareDocumentPosition(heading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    const browserAction = screen.getByRole("link", { name: "Open in browser" });
    expect(browserAction).not.toHaveTextContent("Open in browser");
    expect(screen.getAllByLabelText("Base branch main")).toHaveLength(1);
  });

  it("lazy-loads Code with the immutable base and head snapshot", async () => {
    const transport = fakeTransport();
    renderPane(transport);
    const codeTab = await screen.findByRole("tab", { name: "code" });

    await userEvent.click(codeTab);

    expect(
      await screen.findByTestId("pull-request-code-panel"),
    ).toHaveTextContent("bbbb:aaaa");
    expect(codeTab).toHaveAttribute("aria-selected", "true");
    const submitReview = screen.getByRole("button", {
      name: "Submit review",
    });
    expect(submitReview.closest("header")).toHaveAttribute(
      "aria-label",
      "Pull request detail",
    );
    expect(submitReview.querySelector("svg")).not.toBeInTheDocument();
  });

  it("reloads an active Timeline after a detail refresh advances the head", async () => {
    let headOid = "a".repeat(40);
    const transport = fakeTransport({
      get: vi
        .fn()
        .mockImplementation(() => Promise.resolve(detailResult(headOid))),
    });
    renderPane(transport);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "timeline" }));
    await waitFor(() => expect(transport.timeline).toHaveBeenCalledTimes(1));

    headOid = "c".repeat(40);
    await act(async () => {
      await usePullRequestDetailStore.getState().loadDetail(transport);
    });

    await waitFor(() => expect(transport.timeline).toHaveBeenCalledTimes(2));
    const entry =
      usePullRequestDetailStore.getState().entries[
        getPullRequestDetailKey(identity)
      ];
    expect(entry?.detail?.head.oid).toBe(headOid);
    expect(entry?.lanes.timelineInitial.fetchedAt).not.toBeNull();
  });

  it("reveals fork actions only after the local worktree capability is known", async () => {
    const transport = fakeTransport({
      getCapabilities: vi.fn(
        () =>
          new Promise<PullRequestCapabilitiesResult>(() => {
            // Keep the capability read pending so the unknown state is stable.
          }),
      ),
    });
    const reviewTaskTransport: PullRequestReviewTaskTransport = {
      createReviewTask: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "workspace_mapping_missing",
          message: "No matching project",
        },
      }),
      reviewLink: vi.fn().mockResolvedValue(null),
    };
    const user = userEvent.setup();
    const view = renderPane(transport, reviewTaskTransport);
    await screen.findByText("Read-only detail body", undefined, {
      timeout: 3_000,
    });
    const actionsButton = screen.getByRole("button", {
      name: "Pull request actions",
    });
    await user.click(actionsButton);
    await screen.findByRole("menuitem", { name: "Refresh" });
    expect(screen.queryByRole("menuitem", { name: "Fork" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(actionsButton).toHaveAttribute("aria-expanded", "false"),
    );

    act(() => {
      usePullRequestStore.setState({
        capabilities: {
          read: { allowed: true },
          teamRequests: { allowed: false, reason: "missing_scope" },
          comment: { allowed: false, reason: "not_implemented" },
          review: { allowed: false, reason: "not_implemented" },
          readiness: { allowed: false, reason: "not_implemented" },
          close: { allowed: false, reason: "not_implemented" },
          merge: { allowed: false, reason: "not_implemented" },
          reviewWorktree: { allowed: true },
        },
      });
    });

    await vi.waitFor(() => {
      expect(getCommand("pullRequests.reviewChangeStack")).toBeDefined();
    });

    await user.click(actionsButton);
    const action = await screen.findByRole(
      "menuitem",
      { name: "Fork" },
      { timeout: 3_000 },
    );
    expect(action).not.toHaveAttribute("aria-disabled", "true");
    await user.click(action);
    expect(
      screen.getByRole("dialog", { name: "Fork pull request" }),
    ).toHaveTextContent("foreground");
    expect(getCommand("pullRequests.reviewChangeStack")).toBeDefined();
    act(() => getCommand("pullRequests.reviewChangeStack")?.handler());
    expect(reviewTaskTransport.createReviewTask).not.toHaveBeenCalled();
    view.unmount();
    expect(getCommand("pullRequests.reviewChangeStack")).toBeUndefined();
  });

  it("disables pull request forking and omits its command when head OID is missing", async () => {
    usePullRequestStore.setState({
      capabilities: {
        read: { allowed: true },
        teamRequests: { allowed: true },
        comment: { allowed: true },
        review: { allowed: true },
        readiness: { allowed: true },
        close: { allowed: true },
        merge: { allowed: true },
        reviewWorktree: { allowed: true },
      },
    });
    const transport = fakeTransport({
      get: vi.fn().mockResolvedValue(detailResult(null)),
    });
    renderPane(transport);

    await screen.findByText("Read-only detail body");
    await userEvent.click(
      screen.getByRole("button", { name: "Pull request actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Fork" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(getCommand("pullRequests.reviewChangeStack")).toBeUndefined();
  });

  it("polls every thirty seconds only while visible and focused, then refreshes once on resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const transport = fakeTransport({
      get: vi.fn().mockImplementation(() => Promise.resolve(detailResult())),
    });
    renderPane(transport);
    await act(async () => {
      await Promise.resolve();
    });
    const detailCalls = () =>
      vi
        .mocked(transport.get)
        .mock.calls.filter(([request]) => request.resource === "detail");
    expect(detailCalls()).toHaveLength(1);
    const receiptKey = getPullRequestMutationLaneKey(identity, "comment");
    usePullRequestMutationStore.setState({
      lanes: { [receiptKey]: outcomeUnknownLane() },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(detailCalls()).toHaveLength(2);
    expect(
      usePullRequestMutationStore.getState().lanes[receiptKey],
    ).toBeDefined();

    focused = false;
    fireEvent.blur(window);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(detailCalls()).toHaveLength(2);

    focused = true;
    fireEvent.focus(window);
    await act(async () => {
      await Promise.resolve();
    });
    expect(detailCalls()).toHaveLength(3);
    expect(
      usePullRequestMutationStore.getState().lanes[receiptKey],
    ).toBeDefined();
  });

  it("acknowledges an unknown outcome only after a successful header refresh", async () => {
    let detailAttempt = 0;
    const get = vi.fn().mockImplementation((request) => {
      if (request.resource !== "detail") return Promise.resolve({ ok: false });
      detailAttempt += 1;
      if (detailAttempt === 2) {
        return Promise.resolve({
          ok: false,
          error: { code: "remote_unavailable", message: "Refresh failed" },
        });
      }
      return Promise.resolve(detailResult());
    });
    const transport = fakeTransport({ get });
    renderPane(transport);
    await screen.findByText("Read-only detail body");
    const receiptKey = getPullRequestMutationLaneKey(identity, "comment");
    const receipt = outcomeUnknownLane();
    usePullRequestMutationStore.setState({ lanes: { [receiptKey]: receipt } });
    const clickRefresh = async (): Promise<void> => {
      await userEvent.click(
        screen.getByRole("button", { name: "Pull request actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Refresh" }),
      );
    };

    await clickRefresh();
    await vi.waitFor(() =>
      expect(
        get.mock.calls.filter(([request]) => request.resource === "detail"),
      ).toHaveLength(2),
    );
    expect(usePullRequestMutationStore.getState().lanes[receiptKey]).toEqual(
      receipt,
    );

    await clickRefresh();
    await vi.waitFor(() => {
      expect(
        get.mock.calls.filter(([request]) => request.resource === "detail"),
      ).toHaveLength(3);
      expect(
        usePullRequestMutationStore.getState().lanes[receiptKey],
      ).toBeUndefined();
    });
  });
});
