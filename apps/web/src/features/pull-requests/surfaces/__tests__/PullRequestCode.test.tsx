import type {
  PullRequestFile,
  PullRequestDetail,
  PullRequestFilesResult,
  PullRequestGetResult,
  PullRequestIdentity,
  PullRequestPatchResult,
  PullRequestReviewThread,
} from "@mcode/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestDetailKey,
  usePullRequestDetailStore,
} from "@/features/pull-requests/state/pullRequestDetailStore";
import { usePullRequestCodeStore } from "@/features/pull-requests/state/pullRequestCodeStore";
import { usePullRequestStore } from "@/features/pull-requests/state/pullRequestStore";
import type { PullRequestTransport } from "@/transport/pull-requests";

const layout = vi.hoisted(() => ({ codeWidth: 0 }));

vi.mock("@/hooks/useElementWidth", () => ({
  useElementWidth: () => layout.codeWidth,
}));

vi.mock("../PullRequestDiffViewport", () => ({
  PullRequestDiffViewport: ({
    files,
    reviewThreads,
    commentsComplete,
    baseOid,
    headOid,
  }: {
    files: PullRequestFile[];
    reviewThreads: PullRequestReviewThread[];
    commentsComplete: boolean;
    baseOid: string;
    headOid: string;
  }) => (
    <div
      data-testid="code-viewport-seam"
      data-files={files.length}
      data-threads={reviewThreads.length}
      data-comments-complete={String(commentsComplete)}
      data-base={baseOid}
      data-head={headOid}
    />
  ),
}));

import { PullRequestCode } from "../PullRequestCode";

const IDENTITY: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "REPO_1",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};
const IDENTITY_KEY = getPullRequestDetailKey(IDENTITY);
const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);
const FRESHNESS = {
  snapshotVersion: "snapshot-1",
  fetchedAt: "2026-07-11T12:00:00.000Z",
  staleAt: "2026-07-11T12:00:30.000Z",
  boundedData: null,
} as const;

const DETAIL: PullRequestDetail = {
  identity: IDENTITY,
  providerNodeId: "PR_1",
  url: "https://github.com/Mzeey-Empire/mcode/pull/42",
  title: "Review Code",
  body: "",
  author: null,
  state: "open",
  readiness: "ready",
  head: {
    owner: "Mzeey-Empire",
    repository: "mcode",
    name: "feature",
    oid: HEAD_OID,
  },
  base: {
    owner: "Mzeey-Empire",
    repository: "mcode",
    name: "main",
    oid: BASE_OID,
  },
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  createdAt: FRESHNESS.fetchedAt,
  updatedAt: FRESHNESS.fetchedAt,
  mergeability: "mergeable",
  mergeMethods: ["merge", "squash"],
  defaultMergeMethod: "squash",
  reviewDecision: "review_required",
  reviewers: [],
  checks: { state: "passing" },
  checkCount: 1,
  commentCount: 0,
  reviewThreadCount: 0,
};

function file(index: number): PullRequestFile {
  return {
    locator: `file_${index}`,
    path: `apps/web/src/file-${index}.ts`,
    previousPath: null,
    changeType: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    blobOid: index.toString(16).padStart(40, "0"),
    patchStatus: "available",
  };
}

function filesResult(
  items: PullRequestFile[],
  nextCursor: string | null = null,
): PullRequestFilesResult {
  return {
    ok: true,
    items,
    nextCursor,
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    ...FRESHNESS,
  };
}

function thread(index: number): PullRequestReviewThread {
  return {
    kind: "review_thread",
    providerNodeId: `THREAD_${index}`,
    path: file(1).path,
    line: index,
    startLine: null,
    side: "right",
    startSide: null,
    originalLine: index,
    originalStartLine: null,
    subjectType: "line",
    commitOid: HEAD_OID,
    headOid: HEAD_OID,
    isResolved: false,
    isOutdated: false,
    createdAt: `2026-07-11T12:00:0${index}.000Z`,
    updatedAt: `2026-07-11T12:00:0${index}.000Z`,
    totalCount: 0,
    comments: [],
  };
}

function commentsResult(
  items: PullRequestReviewThread[],
  nextCursor: string | null,
): PullRequestGetResult {
  return {
    ok: true,
    resource: "comments",
    items,
    nextCursor,
    ...FRESHNESS,
  };
}

function patchResult(
  item: PullRequestFile,
  status: "available" | "generated" | "binary" | "unavailable" | "too_large",
): PullRequestPatchResult {
  const common = {
    ok: true as const,
    locator: item.locator,
    path: item.path,
    previousPath: item.previousPath,
    changeType: item.changeType,
    blobOid: item.blobOid,
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    fetchedAt: FRESHNESS.fetchedAt,
    staleAt: FRESHNESS.staleAt,
  };
  if (status === "available" || status === "generated") {
    const patch = "@@ -1 +1 @@\n-before\n+after";
    return {
      ...common,
      status,
      patch,
      parsedLineCount: patch.split("\n").length,
    };
  }
  return { ...common, status, patch: null, parsedLineCount: null };
}

function fakeTransport(
  overrides: Partial<PullRequestTransport> = {},
): PullRequestTransport {
  const base: PullRequestTransport = {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false }),
    get: vi.fn().mockResolvedValue(commentsResult([], null)),
    timeline: vi.fn().mockResolvedValue({ ok: false }),
    files: vi.fn().mockResolvedValue(filesResult([file(1)])),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: true }),
  };
  return { ...base, ...overrides };
}

function renderCode(transport: PullRequestTransport, isNarrow = false) {
  usePullRequestDetailStore.getState().open(IDENTITY, transport);
  return render(
    <PullRequestCode
      identity={IDENTITY}
      identityKey={IDENTITY_KEY}
      baseOid={BASE_OID}
      headOid={HEAD_OID}
      isNarrow={isNarrow}
      transport={transport}
      detail={DETAIL}
    />,
  );
}

describe("PullRequestCode", () => {
  beforeEach(() => {
    layout.codeWidth = 0;
    usePullRequestCodeStore.setState({
      entries: {},
      patches: {},
      activeSnapshotKey: null,
    });
    usePullRequestDetailStore.setState({ entries: {}, activeKey: null });
    usePullRequestStore.setState({
      viewer: {
        providerNodeId: "VIEWER_1",
        login: "reviewer",
        avatarUrl: null,
        profileUrl: null,
      },
    });
  });

  it("loads files with both OIDs and exhausts review threads without opening Summary", async () => {
    const get = vi
      .fn()
      .mockImplementation(async (request) =>
        request.cursor
          ? commentsResult([thread(2)], null)
          : commentsResult([thread(1)], "comments-2"),
      );
    const files = vi.fn().mockResolvedValue(filesResult([file(1)]));
    const transport = fakeTransport({ get, files });
    renderCode(transport);

    const viewport = await screen.findByTestId("code-viewport-seam");
    await waitFor(() =>
      expect(viewport).toHaveAttribute("data-comments-complete", "true"),
    );
    expect(viewport).toHaveAttribute("data-files", "1");
    expect(viewport).toHaveAttribute("data-threads", "2");
    expect(viewport).toHaveAttribute("data-base", BASE_OID);
    expect(viewport).toHaveAttribute("data-head", HEAD_OID);
    expect(get).toHaveBeenCalledTimes(2);
    expect(
      get.mock.calls.every(([request]) => request.resource === "comments"),
    ).toBe(true);
    expect(files).toHaveBeenCalledWith(
      expect.objectContaining({ baseOid: BASE_OID, headOid: HEAD_OID }),
    );
  });

  it("continues top-level review threads while preserving embedded-comment bounds", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        ...commentsResult([thread(1)], "comments-2"),
        boundedData: { reason: "record_limit" as const },
      })
      .mockResolvedValueOnce(commentsResult([thread(2)], null));
    const transport = fakeTransport({ get });
    renderCode(transport);

    const viewport = await screen.findByTestId("code-viewport-seam");
    await waitFor(() => expect(viewport).toHaveAttribute("data-threads", "2"));
    expect(viewport).toHaveAttribute("data-comments-complete", "false");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("stops review-thread pagination when GitHub repeats a cursor", async () => {
    const get = vi
      .fn()
      .mockImplementation(async (request) =>
        request.cursor
          ? commentsResult([thread(2)], "comments-repeat")
          : commentsResult([thread(1)], "comments-repeat"),
      );
    const transport = fakeTransport({ get });
    renderCode(transport);

    const viewport = await screen.findByTestId("code-viewport-seam");
    expect(
      await screen.findByText(
        "Review thread loading stopped because GitHub repeated a page cursor. Some threads may be missing.",
      ),
    ).toBeVisible();
    expect(viewport).toHaveAttribute("data-threads", "2");
    expect(viewport).toHaveAttribute("data-comments-complete", "false");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("recovers a failed append cursor after a root comments refresh", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(commentsResult([thread(1)], "comments-retry"))
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "remote_unavailable", message: "Append failed" },
      })
      .mockResolvedValueOnce(commentsResult([thread(1)], "comments-retry"))
      .mockResolvedValueOnce(commentsResult([thread(2)], null));
    const transport = fakeTransport({ get });
    renderCode(transport);

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => {
      await usePullRequestDetailStore.getState().loadComments({ transport });
    });

    const viewport = await screen.findByTestId("code-viewport-seam");
    await waitFor(() => expect(viewport).toHaveAttribute("data-threads", "2"));
    expect(viewport).toHaveAttribute("data-comments-complete", "true");
    expect(
      screen.queryByText(
        "Review thread loading stopped because GitHub repeated a page cursor. Some threads may be missing.",
      ),
    ).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("starts a fresh cursor generation after replacing stalled root comments", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(commentsResult([thread(1)], "comments-repeat"))
      .mockResolvedValueOnce(commentsResult([thread(2)], "comments-repeat"))
      .mockResolvedValueOnce(commentsResult([thread(1)], "comments-repeat"))
      .mockResolvedValueOnce(commentsResult([thread(2)], null));
    const transport = fakeTransport({ get });
    renderCode(transport);

    expect(
      await screen.findByText(
        "Review thread loading stopped because GitHub repeated a page cursor. Some threads may be missing.",
      ),
    ).toBeVisible();
    await act(async () => {
      await usePullRequestDetailStore.getState().loadComments({ transport });
    });

    const viewport = await screen.findByTestId("code-viewport-seam");
    await waitFor(() =>
      expect(viewport).toHaveAttribute("data-comments-complete", "true"),
    );
    expect(
      screen.queryByText("Review thread loading stopped"),
    ).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("keeps the changed-files navigator right of the diff and restores it", async () => {
    const transport = fakeTransport();
    renderCode(transport);
    await screen.findByTestId("code-viewport-seam");

    expect(screen.getByTestId("pull-request-code-toolbar")).toHaveAttribute(
      "data-layout",
      "wide",
    );
    const navigator = screen.getByTestId("pull-request-changed-files-pane");
    const viewport = screen.getByTestId("code-viewport-seam");
    expect(viewport.compareDocumentPosition(navigator)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Hide changed files" }),
    );
    expect(
      screen.queryByTestId("pull-request-changed-files-pane"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Show changed files" }),
    );
    expect(screen.getByTestId("pull-request-changed-files-pane")).toBeVisible();
  });

  it("uses one stateful control for the diff layout", async () => {
    const transport = fakeTransport();
    renderCode(transport);
    await screen.findByTestId("code-viewport-seam");

    expect(
      screen.queryByRole("button", { name: "Use unified diff layout" }),
    ).not.toBeInTheDocument();
    const layoutButton = screen.getByRole("button", {
      name: "Use split diff layout",
    });
    await userEvent.click(layoutButton);
    expect(
      screen.getByRole("button", { name: "Use unified diff layout" }),
    ).toBeVisible();
  });

  it("toggles every file diff between expanded and collapsed", async () => {
    const transport = fakeTransport();
    renderCode(transport);
    await screen.findByTestId("code-viewport-seam");

    const collapseButton = screen.getByRole("button", {
      name: "Collapse all file diffs",
    });
    await userEvent.click(collapseButton);
    const expandButton = screen.getByRole("button", {
      name: "Expand all file diffs",
    });
    await userEvent.click(expandButton);
    expect(
      screen.getByRole("button", { name: "Collapse all file diffs" }),
    ).toBeVisible();
  });

  it("floats the reusable file view over the narrow Code workspace", async () => {
    const transport = fakeTransport();
    renderCode(transport, true);

    expect(await screen.findByTestId("code-viewport-seam")).toBeInTheDocument();
    const toolbar = screen.getByTestId("pull-request-code-toolbar");
    const actionsRow = screen.getByTestId("pull-request-code-actions-row");
    expect(toolbar).toHaveAttribute("data-layout", "compact");
    expect(toolbar).toHaveTextContent("feature");
    expect(toolbar).toHaveTextContent("main");
    expect(actionsRow).toContainElement(
      screen.getByRole("button", { name: "Collapse all file diffs" }),
    );
    expect(
      screen.queryByRole("button", { name: "Submit review" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("pull-request-review-footer"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Choose a changed file" }),
    ).not.toBeInTheDocument();
    const navigator = screen.getByTestId("pull-request-changed-files-pane");
    expect(navigator).toBeVisible();
    expect(navigator.parentElement).toHaveClass("absolute", "right-0");
    expect(
      screen.getByRole("textbox", { name: "Search changed files" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "Filter changed files by status",
      }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Hide changed files" }),
    );
    expect(
      screen.queryByTestId("pull-request-changed-files-pane"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Show changed files" }),
    );
    expect(screen.getByTestId("pull-request-changed-files-pane")).toBeVisible();
  });

  it("docks the reusable file view when the Code workspace can fit it", async () => {
    layout.codeWidth = 900;
    const transport = fakeTransport();
    renderCode(transport, true);

    expect(await screen.findByTestId("code-viewport-seam")).toBeInTheDocument();
    const toolbar = screen.getByTestId("pull-request-code-toolbar");
    expect(toolbar).toHaveAttribute("data-layout", "wide");
    expect(toolbar).toHaveTextContent("feature");
    expect(toolbar).toHaveTextContent("main");
    expect(
      screen.queryByRole("button", { name: "Choose a changed file" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("pull-request-changed-files-pane")).toBeVisible();
    expect(
      screen.getByRole("separator", {
        name: "Resize Pull request changed files",
      }),
    ).toBeVisible();
  });

  it("moves the file view between docked and floating layouts as the workspace resizes", async () => {
    layout.codeWidth = 900;
    const transport = fakeTransport();
    const rendered = renderCode(transport, true);

    expect(await screen.findByTestId("code-viewport-seam")).toBeInTheDocument();
    const navigator = screen.getByTestId("pull-request-changed-files-pane");
    expect(navigator.parentElement).not.toHaveClass("absolute");

    layout.codeWidth = 700;
    rendered.rerender(
      <PullRequestCode
        identity={IDENTITY}
        identityKey={IDENTITY_KEY}
        baseOid={BASE_OID}
        headOid={HEAD_OID}
        isNarrow
        transport={transport}
        detail={DETAIL}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("pull-request-changed-files-pane").parentElement,
      ).toHaveClass("absolute", "right-0"),
    );
    expect(screen.getByTestId("pull-request-code-toolbar")).toHaveAttribute(
      "data-layout",
      "compact",
    );
  });

  it("keeps orphan review context visible when the ready file view is empty", async () => {
    const removedThread: PullRequestReviewThread = {
      ...thread(1),
      providerNodeId: "THREAD_REMOVED",
      path: "src/removed.ts",
      isOutdated: true,
    };
    const transport = fakeTransport({
      files: vi.fn().mockResolvedValue(filesResult([])),
      get: vi.fn().mockResolvedValue(commentsResult([removedThread], null)),
    });
    renderCode(transport);

    const viewport = await screen.findByTestId("code-viewport-seam");
    expect(viewport).toHaveAttribute("data-files", "0");
    expect(viewport).toHaveAttribute("data-threads", "1");
    expect(screen.getByRole("status")).toHaveTextContent(
      "No changed files match this view.",
    );
  });

  it.each([
    ["generated", "Generated"],
    ["binary", "Binary"],
    ["too_large", "Too large"],
  ] as const)(
    "updates the desktop file tree from %s patch evidence",
    async (status, label) => {
      const item = file(1);
      const transport = fakeTransport({
        patch: vi.fn().mockResolvedValue(patchResult(item, status)),
      });
      renderCode(transport);

      await userEvent.click(
        await screen.findByRole("treeitem", { name: `Modified ${item.path}` }),
      );

      expect(await screen.findByText(label, { exact: true })).toBeVisible();
    },
  );

  it("updates the narrow floating file view from immutable patch evidence", async () => {
    const item = file(1);
    const transport = fakeTransport({
      patch: vi.fn().mockResolvedValue(patchResult(item, "generated")),
    });
    renderCode(transport, true);

    await userEvent.click(
      await screen.findByRole("treeitem", { name: `Modified ${item.path}` }),
    );

    expect(await screen.findByText("Generated", { exact: true })).toBeVisible();
  });

  it("offers explicit continuation until a filtered search is complete", async () => {
    const files = vi.fn().mockImplementation(async (request) => {
      if (request.search === "store" && request.cursor) {
        return filesResult([file(2)]);
      }
      if (request.search === "store") return filesResult([file(1)], "search-2");
      return filesResult([file(1)]);
    });
    const transport = fakeTransport({ files });
    renderCode(transport);
    await screen.findByTestId("code-viewport-seam");

    await userEvent.type(
      screen.getByRole("textbox", { name: "Search changed files" }),
      "store",
    );
    const continueButton = await screen.findByRole("button", {
      name: "Search remaining files",
    });
    await userEvent.click(continueButton);

    await waitFor(() =>
      expect(
        files.mock.calls.some(([request]) => request.cursor === "search-2"),
      ).toBe(true),
    );
    expect(
      usePullRequestCodeStore.getState().entries[
        usePullRequestCodeStore.getState().activeSnapshotKey!
      ]?.filesLane.complete,
    ).toBe(true);
  });
});
