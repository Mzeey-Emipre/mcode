import type {
  PullRequestCheck,
  PullRequestConversationItem,
  PullRequestDetail,
} from "@mcode/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePullRequestMutationStore } from "@/features/pull-requests/state/pullRequestMutationStore";
import { PullRequestSummary } from "../PullRequestSummary";

const virtualizerProbe = vi.hoisted(() => ({
  options: [] as Array<{
    count: number;
    overscan: number;
    estimateSize: (index: number) => number;
    getItemKey: (index: number) => unknown;
  }>,
  measureElement: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    overscan: number;
    estimateSize: (index: number) => number;
    getItemKey: (index: number) => unknown;
  }) => {
    virtualizerProbe.options.push(options);
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 12) }, (_, index) => ({
          index,
          key: options.getItemKey(index),
          start: index * options.estimateSize(index),
        })),
      getTotalSize: () => options.count * options.estimateSize(0),
      measureElement: virtualizerProbe.measureElement,
    };
  },
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
    viewportRef,
  }: {
    children: React.ReactNode;
    className?: string;
    viewportRef?: React.Ref<HTMLDivElement>;
  }) => (
    <div
      ref={viewportRef}
      className={className}
      data-testid="summary-resource-viewport"
    >
      {children}
    </div>
  ),
}));

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
    title: "Pull request detail",
    body: "**Remote** pull request context.",
    author: {
      providerNodeId: "author-node",
      login: "author",
      avatarUrl: null,
      profileUrl: null,
    },
    state: "open",
    readiness: "ready",
    head: {
      owner: "contributor",
      repository: "mcode",
      name: "feature/detail",
      oid: "a".repeat(40),
    },
    base: {
      owner: "Mzeey-Empire",
      repository: "mcode",
      name: "main",
      oid: "b".repeat(40),
    },
    additions: 12,
    deletions: 4,
    changedFiles: 2,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
    mergeability: "unknown",
    mergeMethods: ["merge"],
    defaultMergeMethod: "merge",
    reviewDecision: "review_required",
    reviewers: [
      {
        target: {
          kind: "user",
          actor: {
            providerNodeId: "reviewer-node",
            login: "reviewer",
            avatarUrl: null,
            profileUrl: null,
          },
        },
        state: "requested",
        submittedAt: null,
      },
      {
        target: {
          kind: "team",
          providerNodeId: "team-node",
          organization: "Mzeey-Empire",
          slug: "maintainers",
        },
        state: "pending",
        submittedAt: null,
      },
    ],
    checks: { state: "passing" },
    checkCount: 4,
    commentCount: 3,
    reviewThreadCount: 1,
  };
}

function checks(): PullRequestCheck[] {
  return [
    {
      providerNodeId: "check-1",
      kind: "check_run",
      name: "Web verification",
      state: "passing",
      isRequired: true,
      detailsUrl: "https://github.com/Mzeey-Empire/mcode/actions/runs/1",
      startedAt: "2026-07-11T11:00:00.000Z",
      completedAt: "2026-07-11T11:02:00.000Z",
      updatedAt: "2026-07-11T11:02:00.000Z",
    },
    {
      providerNodeId: "check-2",
      kind: "status_context",
      name: "Review policy",
      state: "pending",
      isRequired: null,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-07-11T11:03:00.000Z",
    },
  ];
}

function comments(): PullRequestConversationItem[] {
  return [
    {
      kind: "issue_comment",
      providerNodeId: "comment-1",
      author: {
        providerNodeId: "commenter-node",
        login: "commenter",
        avatarUrl: null,
        profileUrl: null,
      },
      body: "**Please verify** the narrow layout.",
      createdAt: "2026-07-11T11:04:00.000Z",
      updatedAt: "2026-07-11T11:04:00.000Z",
      url: null,
    },
    {
      kind: "review_thread",
      providerNodeId: "thread-1",
      path: "apps/web/src/app/App.tsx",
      line: 42,
      startLine: null,
      side: "right",
      startSide: null,
      originalLine: 42,
      originalStartLine: null,
      subjectType: "line",
      commitOid: "b".repeat(40),
      headOid: "b".repeat(40),
      isResolved: false,
      isOutdated: false,
      createdAt: "2026-07-11T11:05:00.000Z",
      updatedAt: "2026-07-11T11:06:00.000Z",
      totalCount: 3,
      comments: [
        {
          providerNodeId: "review-comment-1",
          author: null,
          body: "`aria-posinset` must remain stable.",
          createdAt: "2026-07-11T11:05:00.000Z",
          updatedAt: "2026-07-11T11:05:00.000Z",
          url: null,
        },
      ],
    },
  ];
}

function manyChecks(count: number): PullRequestCheck[] {
  return Array.from({ length: count }, (_, index) => ({
    providerNodeId: `check-${index.toString().padStart(4, "0")}`,
    kind: "check_run",
    name: `Check ${index}`,
    state: index % 2 === 0 ? "passing" : "pending",
    isRequired: index % 3 === 0,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-07-11T11:02:00.000Z",
  }));
}

function manyComments(count: number): PullRequestConversationItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "issue_comment",
    providerNodeId: `comment-${index.toString().padStart(4, "0")}`,
    author: null,
    body: `Comment body ${index}`,
    createdAt: "2026-07-11T11:04:00.000Z",
    updatedAt: "2026-07-11T11:04:00.000Z",
    url: null,
  }));
}

describe("PullRequestSummary", () => {
  beforeEach(() => {
    virtualizerProbe.options.length = 0;
    virtualizerProbe.measureElement.mockClear();
    usePullRequestMutationStore.setState({ lanes: {}, commentDrafts: {} });
  });

  it("renders the remote description without repeating header metadata", async () => {
    render(
      <PullRequestSummary
        detail={detail()}
        checks={checks()}
        comments={comments()}
      />,
    );

    const summary = screen.getByRole("region", {
      name: "Pull request summary",
    });
    expect(
      within(summary).queryByText("Ready for review"),
    ).not.toBeInTheDocument();
    expect(
      within(summary).queryByLabelText("Base branch main"),
    ).not.toBeInTheDocument();
    expect(within(summary).queryByText("reviewer")).not.toBeInTheDocument();
    expect(
      within(summary).queryByText(/Passing, 4 checks/),
    ).not.toBeInTheDocument();
    expect(within(summary).queryByText("3 comments")).not.toBeInTheDocument();
    expect(
      await within(summary).findByRole(
        "region",
        { name: "Description" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(
      await within(summary).findByText("Remote", {}, { timeout: 5_000 }),
    ).toBeVisible();
  });

  it("keeps local task actions out of the summary content", () => {
    render(<PullRequestSummary detail={detail()} checks={[]} comments={[]} />);

    expect(screen.getByRole("region", { name: "Description" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Description" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review task/i })).toBeNull();
  });

  it("surfaces a bounded remote description", () => {
    render(
      <PullRequestSummary
        detail={detail()}
        checks={[]}
        comments={[]}
        detailBoundedData={{ reason: "byte_limit" }}
      />,
    );

    expect(
      screen.getByText("Description truncated at the remote data limit."),
    ).toHaveAttribute("data-bounded-reason", "byte_limit");
  });

  it("keeps issue and review comments in the app without outbound actions", async () => {
    const linkedComments = comments();
    const issueComment = linkedComments[0];
    if (issueComment?.kind === "issue_comment") {
      issueComment.url =
        "https://github.com/Mzeey-Empire/mcode/pull/42#issuecomment-1";
    }
    const reviewThread = linkedComments[1];
    if (reviewThread?.kind === "review_thread" && reviewThread.comments[0]) {
      reviewThread.comments[0].url =
        "http://github.com/Mzeey-Empire/mcode/pull/42#discussion_r1";
    }
    linkedComments.push({
      kind: "issue_comment",
      providerNodeId: "comment-hostile",
      author: null,
      body: "Hostile comment link",
      createdAt: "2026-07-11T11:07:00.000Z",
      updatedAt: "2026-07-11T11:07:00.000Z",
      url: "javascript:alert(1)",
    });

    render(
      <PullRequestSummary
        detail={detail()}
        checks={[]}
        comments={linkedComments}
        commentsLoaded
        defaultCommentsOpen
      />,
    );

    expect(
      screen.getByRole("article", { name: "Comment from commenter" }),
    ).toContainElement(screen.getByText("Please verify"));
    expect(
      screen.getByRole("article", {
        name: "Review thread on apps/web/src/app/App.tsx:42",
      }),
    ).toContainElement(screen.getByText("aria-posinset"));
    expect(
      screen.queryByRole("link", { name: "Open comment" }),
    ).not.toBeInTheDocument();
  });

  it("opens a compact reply composer and preserves its draft when closed", async () => {
    const user = userEvent.setup();
    const onPromptFix = vi.fn();
    render(
      <PullRequestSummary
        detail={detail()}
        checks={checks()}
        comments={comments()}
        commentCapability={{ allowed: true }}
        onPromptFix={onPromptFix}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Prompt to fix with AI" }),
    );
    expect(onPromptFix).not.toHaveBeenCalled();
    expect(
      screen.getByText("Start a Review task with this comment as context."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(onPromptFix).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "issue_comment",
        providerNodeId: "comment-1",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Reply" }));
    const reply = screen.getByRole("textbox", { name: "Reply to commenter" });
    expect(reply).toHaveValue("@commenter ");
    expect(screen.getByRole("button", { name: "Post reply" })).toBeDisabled();

    await user.type(reply, "Please recheck this.");
    expect(screen.getByRole("button", { name: "Post reply" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(
      screen.queryByRole("textbox", { name: "Reply to commenter" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByRole("textbox", { name: "Reply to commenter" })).toHaveValue(
      "@commenter Please recheck this.",
    );
  });

  it("uses document sections and one conversation card layer", async () => {
    render(
      <PullRequestSummary
        detail={detail()}
        checks={checks()}
        comments={comments()}
      />,
    );

    const checksTrigger = screen.getByRole("button", {
      name: "Checks, 2 loaded of 4",
    });
    const commentsTrigger = screen.getByRole("button", {
      name: "Comments, 2 loaded of 4",
    });
    expect(commentsTrigger.querySelector("svg")).toHaveClass(
      "lucide-message-circle",
    );
    expect(checksTrigger.parentElement).toHaveClass("border-t");
    expect(commentsTrigger.parentElement).toHaveClass("border-t");
    expect(checksTrigger.parentElement).not.toHaveClass(
      "rounded-xl",
      "bg-card/30",
    );
    expect(commentsTrigger.parentElement).not.toHaveClass(
      "rounded-xl",
      "bg-card/30",
    );

    const issueComment = await screen.findByRole("article", {
      name: "Comment from commenter",
    });
    const reviewThread = screen.getByRole("article", {
      name: "Review thread on apps/web/src/app/App.tsx:42",
    });
    expect(issueComment).toHaveClass("rounded-lg", "bg-card/45");
    expect(reviewThread).toHaveClass("rounded-lg", "bg-card/45");
    expect(issueComment).not.toHaveClass("border");
    expect(reviewThread).not.toHaveClass("border");
  });

  it("expands checks and comments with explicit bounded markers", async () => {
    render(
      <PullRequestSummary
        detail={detail()}
        checks={checks()}
        comments={comments()}
        checksHasMore
        commentsHasMore
        checksBoundedData={{ reason: "record_limit" }}
        commentsBoundedData={{ reason: "byte_limit" }}
      />,
    );

    expect(screen.getByText("Web verification")).toBeVisible();
    expect(document.querySelector('svg[data-check-state="passing"]')).toHaveClass(
      "lucide-circle-check",
    );
    expect(document.querySelector('svg[data-check-state="pending"]')).toHaveClass(
      "lucide-loader-circle",
    );
    expect(screen.getByText("Required")).toBeVisible();
    expect(
      screen.getByText(
        "Record limit reached. Additional check records are not shown.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Load more checks" }),
    ).not.toBeInTheDocument();

    expect(await screen.findByText("Please verify")).toBeVisible();
    expect(screen.getByText("apps/web/src/app/App.tsx:42")).toBeVisible();
    expect(screen.getByText("Showing 1 of 3 thread comments.")).toBeVisible();
    expect(
      screen.getByText(
        "Data limit reached. Additional comments are not shown.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Load more comments" }),
    ).not.toBeInTheDocument();
  });

  it("delegates unbounded continuation to the parent", async () => {
    const user = userEvent.setup();
    const onLoadMoreChecks = vi.fn();
    const onLoadMoreComments = vi.fn();
    render(
      <PullRequestSummary
        detail={detail()}
        checks={checks()}
        comments={comments()}
        checksHasMore
        commentsHasMore
        onLoadMoreChecks={onLoadMoreChecks}
        onLoadMoreComments={onLoadMoreComments}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more checks" }));
    await user.click(
      screen.getByRole("button", { name: "Load more comments" }),
    );

    expect(onLoadMoreChecks).toHaveBeenCalledOnce();
    expect(onLoadMoreComments).toHaveBeenCalledOnce();
  });

  it("requests each resource once when its default-open section mounts", async () => {
    const user = userEvent.setup();
    const onChecksFirstOpen = vi.fn();
    const onCommentsFirstOpen = vi.fn();
    const { rerender } = render(
      <PullRequestSummary
        detail={detail()}
        checks={[]}
        comments={[]}
        onChecksFirstOpen={onChecksFirstOpen}
        onCommentsFirstOpen={onCommentsFirstOpen}
      />,
    );

    await waitFor(() => expect(onChecksFirstOpen).toHaveBeenCalledOnce());
    await waitFor(() => expect(onCommentsFirstOpen).toHaveBeenCalledOnce());

    const checksTrigger = screen.getByRole("button", {
      name: "Checks, 0 loaded of 4",
    });
    await user.click(checksTrigger);
    await user.click(checksTrigger);
    expect(onChecksFirstOpen).toHaveBeenCalledOnce();

    const commentsTrigger = screen.getByRole("button", {
      name: "Comments, 0 loaded of 4",
    });
    await user.click(commentsTrigger);
    await user.click(commentsTrigger);
    expect(onCommentsFirstOpen).toHaveBeenCalledOnce();

    rerender(
      <PullRequestSummary
        detail={{ ...detail(), providerNodeId: "next-pull-request-node" }}
        checks={[]}
        comments={[]}
        onChecksFirstOpen={onChecksFirstOpen}
        onCommentsFirstOpen={onCommentsFirstOpen}
      />,
    );
    await waitFor(() => expect(onChecksFirstOpen).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onCommentsFirstOpen).toHaveBeenCalledTimes(2));
  });

  it("reloads an invalidated resource when the head changes while its section stays open", async () => {
    const onChecksFirstOpen = vi.fn();
    const firstDetail = detail();
    const { rerender } = render(
      <PullRequestSummary
        detail={firstDetail}
        checks={[]}
        comments={[]}
        onChecksFirstOpen={onChecksFirstOpen}
      />,
    );
    await waitFor(() => expect(onChecksFirstOpen).toHaveBeenCalledOnce());

    rerender(
      <PullRequestSummary
        detail={{
          ...firstDetail,
          head: { ...firstDetail.head, oid: "c".repeat(40) },
        }}
        checks={[]}
        comments={[]}
        onChecksFirstOpen={onChecksFirstOpen}
      />,
    );

    await waitFor(() => expect(onChecksFirstOpen).toHaveBeenCalledTimes(2));
  });

  it("distinguishes initial loading from a successful empty resource", async () => {
    const currentDetail = detail();
    const view = render(
      <PullRequestSummary
        detail={currentDetail}
        checks={[]}
        comments={[]}
        checksLoading
        commentsLoading
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getByText("Loading checks")).toBeVisible();
    expect(screen.getByText("Loading comments")).toBeVisible();

    view.rerender(
      <PullRequestSummary
        detail={currentDetail}
        checks={[]}
        comments={[]}
        checksLoaded
        commentsLoaded
      />,
    );
    expect(screen.getByText("No checks reported.")).toBeVisible();
    expect(screen.getByText("No comments yet.")).toBeVisible();
  });

  it("does not rerender stable check and comment rows for an unrelated detail refresh", async () => {
    let checkNameReads = 0;
    let commentBodyReads = 0;
    const stableChecks = checks().slice(0, 1);
    const stableComments = comments().slice(0, 1);
    Object.defineProperty(stableChecks[0]!, "name", {
      configurable: true,
      get: () => {
        checkNameReads += 1;
        return "Web verification";
      },
    });
    Object.defineProperty(stableComments[0]!, "body", {
      configurable: true,
      get: () => {
        commentBodyReads += 1;
        return "Stable remote comment";
      },
    });
    const currentDetail = detail();
    const view = render(
      <PullRequestSummary
        detail={currentDetail}
        checks={stableChecks}
        comments={stableComments}
        defaultChecksOpen
        defaultCommentsOpen
      />,
    );
    await screen.findByText("Stable remote comment");
    const checkReadsBefore = checkNameReads;
    const commentReadsBefore = commentBodyReads;

    view.rerender(
      <PullRequestSummary
        detail={{ ...currentDetail, updatedAt: "2026-07-11T12:01:00.000Z" }}
        checks={stableChecks}
        comments={stableComments}
        defaultChecksOpen
        defaultCommentsOpen
      />,
    );

    expect(checkNameReads).toBe(checkReadsBefore);
    expect(commentBodyReads).toBe(commentReadsBefore);
  });

  it("virtualizes one thousand check records with a bounded DOM", async () => {
    render(
      <PullRequestSummary
        detail={{ ...detail(), checkCount: 1_000 }}
        checks={manyChecks(1_000)}
        comments={[]}
      />,
    );

    const list = screen.getByRole("list", { name: "Loaded checks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    expect(
      virtualizerProbe.options.find((option) => option.count === 1_000),
    ).toMatchObject({
      count: 1_000,
      overscan: 4,
    });
    expect(virtualizerProbe.measureElement).toHaveBeenCalled();
    expect(document.querySelectorAll("*").length).toBeLessThan(500);
  });

  it("virtualizes one thousand comments with a bounded DOM", async () => {
    render(
      <PullRequestSummary
        detail={{ ...detail(), commentCount: 1_000, reviewThreadCount: 0 }}
        checks={[]}
        comments={manyComments(1_000)}
      />,
    );

    const list = screen.getByRole("list", { name: "Loaded comments" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    expect(
      virtualizerProbe.options.find((option) => option.count === 1_000),
    ).toMatchObject({
      count: 1_000,
      overscan: 4,
    });
    expect(virtualizerProbe.measureElement).toHaveBeenCalled();
    expect(document.querySelectorAll("*").length).toBeLessThan(500);
  });

  it("lets the Summary page scroll naturally for a normal comment set", () => {
    render(
      <PullRequestSummary
        detail={{ ...detail(), commentCount: 31, reviewThreadCount: 0 }}
        checks={[]}
        comments={manyComments(31)}
      />,
    );

    expect(
      screen.queryByLabelText("Loaded comments viewport"),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Loaded comments" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(31);
  });
});
