import type {
  PullRequestCapabilities,
  PullRequestCapabilitiesResult,
  PullRequestListRequest,
  PullRequestListResult,
  PullRequestRelationship,
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestTransport } from "@/transport/pull-requests";
import { PullRequestInbox } from "../PullRequestInbox";
import { selectPullRequestByKey } from "@/features/pull-requests/state/pull-request-selectors";
import { usePullRequestStore } from "@/features/pull-requests/state/pullRequestStore";

const virtualizerSpies = vi.hoisted(() => ({
  measureElement: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 12) }, (_, index) => ({
        index,
        key: index,
        start: index * 72,
        size: 72,
        end: (index + 1) * 72,
        lane: 0,
      })),
    getTotalSize: () => count * 72,
    measureElement: virtualizerSpies.measureElement,
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
    viewportRef,
    viewportProps,
  }: {
    children: React.ReactNode;
    className?: string;
    viewportRef?: React.Ref<HTMLDivElement>;
    viewportProps?: React.HTMLAttributes<HTMLDivElement>;
  }) => (
    <div ref={viewportRef} className={className} {...viewportProps}>
      {children}
    </div>
  ),
}));

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
    deletions: 1,
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
}

const allowedCapabilities: PullRequestCapabilities = {
  read: { allowed: true },
  teamRequests: { allowed: true },
  comment: { allowed: true },
  review: { allowed: true },
  readiness: { allowed: true },
  close: { allowed: true },
  merge: { allowed: true },
  reviewWorktree: { allowed: true },
};

function okCapabilities(): PullRequestCapabilitiesResult {
  return {
    ok: true,
    viewer: {
      providerNodeId: "viewer-node",
      login: "viewer",
      avatarUrl: null,
      profileUrl: null,
    },
    capabilities: allowedCapabilities,
    fetchedAt: "2026-07-11T12:00:00.000Z",
    staleAt: "2099-07-11T12:00:30.000Z",
  };
}

function okList(items: PullRequestSummary[] = []): PullRequestListResult {
  return {
    ok: true,
    items,
    nextCursor: null,
    snapshotVersion: "snapshot-1",
    fetchedAt: "2026-07-11T12:00:00.000Z",
    staleAt: "2099-07-11T12:00:30.000Z",
    limitations: [],
  };
}

function fakeTransport(): PullRequestTransport {
  return {
    getCapabilities: vi.fn().mockResolvedValue(okCapabilities()),
    list: vi.fn().mockResolvedValue(okList()),
    get: vi.fn().mockResolvedValue({ ok: false }),
    timeline: vi.fn().mockResolvedValue({ ok: false }),
    files: vi.fn().mockResolvedValue({ ok: false }),
    patch: vi.fn().mockResolvedValue({ ok: false }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: false }),
  };
}

function seedItems(items: PullRequestSummary[]): void {
  const entities = Object.fromEntries(
    items.map((item) => [
      `github:${item.identity.repositoryNodeId}:${item.identity.number}`,
      item,
    ]),
  );
  const orderedKeys = Object.keys(entities);
  usePullRequestStore.setState({
    entities,
    orderedKeys,
    selectedKey: orderedKeys[0] ?? null,
    status: "ready",
    capabilities: allowedCapabilities,
  });
}

function seedRows(count: number): void {
  seedItems(Array.from({ length: count }, (_, index) => summary(index + 1)));
}

describe("PullRequestInbox", () => {
  beforeEach(() => {
    virtualizerSpies.measureElement.mockClear();
    usePullRequestStore.getState().reset();
  });

  it("mounts only the viewport and overscan for 1,000 rows", () => {
    seedRows(1_000);

    render(<PullRequestInbox autoLoad={false} />);

    const options = screen.getAllByRole("option");
    expect(screen.getAllByTestId("pull-request-row")).toHaveLength(11);
    expect(options).toHaveLength(11);
    expect(options[0]).toHaveAttribute("aria-setsize", "1000");
    expect(options[0]).toHaveAttribute("aria-posinset", "1");
    expect(options[10]).toHaveAttribute("aria-posinset", "11");
    expect(
      screen.getByRole("listbox", { name: "Pull requests" }),
    ).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect(virtualizerSpies.measureElement).not.toHaveBeenCalled();
  });

  it("loads through the named transport before showing a terminal empty state", async () => {
    const transport = fakeTransport();
    vi.mocked(transport.list).mockResolvedValue(okList([summary(1)]));

    render(<PullRequestInbox transport={transport} />);

    expect(screen.getByLabelText("Loading pull requests")).toBeVisible();
    expect(
      screen.queryByText("No pull requests", { exact: true }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Pull request 1,/ }),
      ).toBeVisible();
    });
    expect(transport.getCapabilities).toHaveBeenCalledOnce();
    expect(transport.list).toHaveBeenCalledOnce();
  });

  it("names the connected GitHub viewer in the inbox introduction", () => {
    seedRows(1);
    usePullRequestStore.setState({
      viewer: {
        providerNodeId: "viewer-node",
        login: "mcode-reviewer",
        avatarUrl: null,
        profileUrl: null,
      },
    });

    render(<PullRequestInbox autoLoad={false} />);

    expect(
      screen.getByText("Review and track work across mcode-reviewer."),
    ).toBeVisible();
  });

  it("centers the inbox chrome on the same column as the pull request list", () => {
    seedRows(1);

    render(<PullRequestInbox autoLoad={false} />);

    expect(
      screen.getByTestId("pull-request-inbox-heading-column"),
    ).toHaveClass("mx-auto", "max-w-[720px]");
    expect(
      screen.getByTestId("pull-request-inbox-filter-column"),
    ).toHaveClass("mx-auto", "max-w-[720px]");
    expect(
      screen.getByRole("tablist", { name: "Pull request relationships" }),
    ).toHaveClass("mx-auto", "max-w-[720px]");
    expect(screen.getByTestId("pull-request-list-content")).toHaveClass(
      "mx-auto",
      "max-w-[720px]",
    );
  });

  it("shows only non-zero change counts", () => {
    seedItems([
      { ...summary(1), additions: 1, deletions: 0 },
      { ...summary(2), additions: 0, deletions: 2 },
    ]);

    render(<PullRequestInbox autoLoad={false} />);

    expect(screen.getByText("+1")).toBeVisible();
    expect(screen.getByText("−2")).toBeVisible();
    expect(screen.queryByText("+0")).toBeNull();
    expect(screen.queryByText("−0")).toBeNull();
  });

  it("shows the pull request number in each row", () => {
    seedItems([{ ...summary(1_339), title: "Target change" }]);

    render(<PullRequestInbox autoLoad={false} />);

    expect(screen.getByText("#1339")).toBeVisible();
    expect(
      screen.getByRole("option", { name: /pull request #1339/ }),
    ).toBeVisible();
    expect(document.querySelector("time")).toHaveClass(
      "justify-self-end",
      "text-right",
    );
  });

  it("moves selection with arrow keys", () => {
    seedRows(2);
    const onActivate = vi.fn();
    render(<PullRequestInbox autoLoad={false} onActivate={onActivate} />);

    const listbox = screen.getByRole("listbox", { name: "Pull requests" });
    const first = screen.getByRole("option", { name: /Pull request 1,/ });
    const second = screen.getByRole("option", { name: /Pull request 2,/ });
    expect(first).toHaveAttribute("tabindex", "-1");
    expect(second).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });

    expect(second).toHaveAttribute("aria-selected", "true");
    expect(listbox).toHaveAttribute("aria-activedescendant", second.id);
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith("github:repo-node:2");
    fireEvent.click(first);
    expect(onActivate).toHaveBeenLastCalledWith("github:repo-node:1");
    expect(listbox).toHaveFocus();
  });

  it("uses arrow-key activation and complete semantics for relationship tabs", async () => {
    seedRows(1);
    const transport = fakeTransport();
    render(<PullRequestInbox autoLoad={false} transport={transport} />);

    const all = screen.getByRole("tab", { name: "all" });
    const reviewing = screen.getByRole("tab", { name: "reviewing" });
    const authored = screen.getByRole("tab", { name: "authored" });
    expect(all).toHaveAttribute("tabindex", "0");
    expect(reviewing).toHaveAttribute("tabindex", "-1");
    expect(all).toHaveAttribute(
      "aria-controls",
      "pull-request-relationship-panel",
    );
    expect(screen.getByRole("tabpanel", { name: "all" })).toHaveAttribute(
      "id",
      "pull-request-relationship-panel",
    );

    all.focus();
    fireEvent.keyDown(all, { key: "ArrowRight" });

    expect(reviewing).toHaveFocus();
    expect(reviewing).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transport.list).mock.calls[0]?.[0].relationships).toEqual([
      "direct_review_requested",
      "team_review_requested",
      "reviewed",
    ]);

    fireEvent.keyDown(reviewing, { key: "End" });
    expect(authored).toHaveFocus();
    expect(authored).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(authored, { key: "ArrowRight" });
    expect(all).toHaveFocus();
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3));
    fireEvent.keyDown(all, { key: "ArrowLeft" });
    expect(authored).toHaveFocus();
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3));
    fireEvent.keyDown(authored, { key: "Home" });
    expect(all).toHaveFocus();
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3));
  });

  it("queries only authored relationships from the Authored tab", async () => {
    seedRows(1);
    const transport = fakeTransport();
    render(<PullRequestInbox autoLoad={false} transport={transport} />);

    fireEvent.click(screen.getByRole("tab", { name: "authored" }));

    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(1));
    const request = vi.mocked(transport.list).mock
      .calls[0]?.[0] as PullRequestListRequest;
    expect(request.relationships).toEqual(["authored"]);
  });

  it("flattens Reviewing into deterministic request and reviewed groups", () => {
    seedItems([
      summary(1, ["direct_review_requested"]),
      summary(2, ["reviewed"]),
      summary(3, ["direct_review_requested", "reviewed"]),
    ]);
    usePullRequestStore.setState({ relationship: "reviewing" });

    render(<PullRequestInbox autoLoad={false} />);

    expect(
      screen
        .getAllByTestId("pull-request-group-header")
        .map((header) => header.textContent),
    ).toEqual(["Review requested", "Previously reviewed"]);
    expect(screen.getAllByText("Review requested")).toHaveLength(1);
    expect(screen.getAllByText("Previously reviewed")).toHaveLength(1);
    const sequence = Array.from(
      screen.getByTestId("pull-request-list-content").children,
    ).map((child) => {
      const header = child.querySelector<HTMLElement>("[data-group]");
      if (header) return header.dataset.group;
      return child
        .querySelector<HTMLElement>('[role="option"]')
        ?.getAttribute("aria-label")
        ?.split(",")[0];
    });
    expect(sequence).toEqual([
      "Review requested",
      "Pull request 1",
      "Pull request 3",
      "Previously reviewed",
      "Pull request 2",
    ]);
    const requested = screen.getByRole("option", { name: /Pull request 1,/ });
    const reviewed = screen.getByRole("option", { name: /Pull request 2,/ });
    expect(requested).toHaveAttribute(
      "aria-describedby",
      "pull-request-group-review-requested",
    );
    expect(reviewed).toHaveAttribute(
      "aria-describedby",
      "pull-request-group-previously-reviewed",
    );
    const listbox = screen.getByRole("listbox", { name: "Pull requests" });
    fireEvent.keyDown(listbox, { key: "End" });
    expect(reviewed).toHaveAttribute("aria-selected", "true");
    expect(
      document.getElementById(listbox.getAttribute("aria-activedescendant")!),
    ).toBe(reviewed);
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(requested).toHaveAttribute("aria-selected", "true");
  });

  it("groups All into review-requested, previously-reviewed, and authored sections", () => {
    seedItems([
      summary(1, ["direct_review_requested"]),
      summary(2, ["reviewed"]),
      summary(3, ["authored"]),
    ]);

    render(<PullRequestInbox autoLoad={false} />);

    expect(
      screen
        .getAllByTestId("pull-request-group-header")
        .map((header) => header.textContent),
    ).toEqual(["Review requested", "Previously reviewed", "Authored"]);
    const sequence = Array.from(
      screen.getByTestId("pull-request-list-content").children,
    ).map((child) => {
      const header = child.querySelector<HTMLElement>("[data-group]");
      if (header) return header.dataset.group;
      return child
        .querySelector<HTMLElement>('[role="option"]')
        ?.getAttribute("aria-label")
        ?.split(",")[0];
    });
    expect(sequence).toEqual([
      "Review requested",
      "Pull request 1",
      "Previously reviewed",
      "Pull request 2",
      "Authored",
      "Pull request 3",
    ]);
  });

  it("reuses a fresh All snapshot when switching relationship tabs", () => {
    seedItems([
      summary(1, ["direct_review_requested"]),
      summary(2, ["authored"]),
    ]);
    usePullRequestStore.setState({
      loadedRelationship: "all",
      staleAt: Date.now() + 60_000,
    });
    const transport = fakeTransport();
    render(<PullRequestInbox autoLoad={false} transport={transport} />);

    fireEvent.click(screen.getByRole("tab", { name: "authored" }));

    expect(transport.list).not.toHaveBeenCalled();
    expect(
      screen.getByRole("option", { name: /Pull request 2,/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Pull request 1,/ }),
    ).toBeNull();
  });

  it("filters the cached result immediately while search state settles locally", async () => {
    const cached = { ...summary(1), title: "Cache this result" };
    const other = { ...summary(2), title: "Unrelated change" };
    const transport = fakeTransport();
    vi.mocked(transport.list).mockResolvedValue(okList([cached, other]));
    render(<PullRequestInbox transport={transport} />);
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Cache this result,/ }),
      ).toBeVisible(),
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search pull requests" }),
      {
        target: { value: "cache" },
      },
    );

    expect(
      screen.getByRole("option", { name: /Cache this result,/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Unrelated change,/ }),
    ).toBeNull();
    await waitFor(() =>
      expect(usePullRequestStore.getState().search).toBe("cache"),
    );
    expect(transport.list).toHaveBeenCalledTimes(1);
  });

  it("keeps a settled local search out of later list requests", async () => {
    const first = { ...summary(1), title: "First cached result" };
    const second = { ...summary(2), title: "Second cached result" };
    let capturedRequest: PullRequestListRequest | null = null;
    let resolveList!: (result: PullRequestListResult) => void;
    const transport = fakeTransport();
    vi.mocked(transport.list).mockImplementation(
      (request) =>
        new Promise<PullRequestListResult>((resolve) => {
          capturedRequest = request;
          resolveList = resolve;
        }),
    );
    seedItems([first, second]);
    render(<PullRequestInbox autoLoad={false} transport={transport} />);
    const search = screen.getByRole("textbox", {
      name: "Search pull requests",
    });

    fireEvent.change(search, { target: { value: "first" } });
    await waitFor(() =>
      expect(usePullRequestStore.getState().search).toBe("first"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh pull requests" }),
    );
    await waitFor(() => expect(transport.list).toHaveBeenCalledOnce());

    fireEvent.change(search, { target: { value: "second" } });
    expect(
      screen.getByRole("option", { name: /Second cached result,/ }),
    ).toBeVisible();
    await act(async () => {
      resolveList(
        okList(capturedRequest?.search ? [first] : [first, second]),
      );
    });

    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Second cached result,/ }),
      ).toBeVisible(),
    );
  });

  it("uses the shared spinner while refreshing cached pull requests", async () => {
    seedRows(1);
    let resolveList!: (result: PullRequestListResult) => void;
    const transport = fakeTransport();
    vi.mocked(transport.list).mockImplementation(
      () =>
        new Promise<PullRequestListResult>((resolve) => {
          resolveList = resolve;
        }),
    );
    render(<PullRequestInbox autoLoad={false} transport={transport} />);
    const refreshButton = screen.getByRole("button", {
      name: "Refresh pull requests",
    });

    fireEvent.click(refreshButton);

    await waitFor(() => expect(transport.list).toHaveBeenCalledOnce());
    expect(refreshButton.querySelector("svg")).toBeNull();
    expect(refreshButton.querySelector(".spinner-tail-fade")).not.toBeNull();

    await act(async () => {
      resolveList(okList([summary(1)]));
    });
    expect(refreshButton.querySelector("svg")).not.toBeNull();
    expect(refreshButton.querySelector(".spinner-tail-fade")).toBeNull();
  });

  it("matches loaded pull requests by hash-prefixed or bare number", () => {
    seedItems([
      { ...summary(1_339), title: "Target change" },
      { ...summary(887), title: "Other change" },
    ]);
    render(<PullRequestInbox autoLoad={false} />);
    const search = screen.getByRole("textbox", {
      name: "Search pull requests",
    });

    for (const query of ["#1339", "1339"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(
        screen.getByRole("option", { name: /Target change,/ }),
      ).toBeVisible();
      expect(
        screen.queryByRole("option", { name: /Other change,/ }),
      ).toBeNull();
    }
  });

  it("cancels a pending capability read without launching a list after unmount", async () => {
    let resolveCapabilities!: (result: PullRequestCapabilitiesResult) => void;
    const transport = fakeTransport();
    vi.mocked(transport.getCapabilities).mockImplementation(
      () =>
        new Promise<PullRequestCapabilitiesResult>((resolve) => {
          resolveCapabilities = resolve;
        }),
    );
    const { unmount } = render(<PullRequestInbox transport={transport} />);
    await waitFor(() =>
      expect(transport.getCapabilities).toHaveBeenCalledOnce(),
    );
    const request = vi.mocked(transport.getCapabilities).mock.calls[0]?.[0];

    unmount();
    await waitFor(() =>
      expect(transport.cancel).toHaveBeenCalledWith({
        operationId: request?.operationId,
      }),
    );
    await act(async () => {
      resolveCapabilities(okCapabilities());
      await Promise.resolve();
    });

    expect(transport.list).not.toHaveBeenCalled();
    expect(usePullRequestStore.getState()).toMatchObject({
      capabilities: null,
      viewer: null,
      error: null,
      status: "idle",
    });
  });

  it("refreshes stale data only while the document is visible and focused", async () => {
    const transport = fakeTransport();
    vi.mocked(transport.list).mockResolvedValue(okList([summary(1)]));
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      render(<PullRequestInbox transport={transport} />);
      await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(1));
      usePullRequestStore.setState({ staleAt: 0 });

      act(() => window.dispatchEvent(new Event("focus")));
      await Promise.resolve();
      expect(transport.list).toHaveBeenCalledTimes(1);

      focus.mockReturnValue(true);
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await Promise.resolve();
      expect(transport.list).toHaveBeenCalledTimes(2);
    } finally {
      focus.mockRestore();
      visibility.mockRestore();
    }
  });

  it("shows a team-scope capability notice without hiding rows", () => {
    seedRows(1);
    usePullRequestStore.setState({
      capabilities: {
        ...allowedCapabilities,
        teamRequests: { allowed: false, reason: "missing_scope" },
      },
    });

    render(<PullRequestInbox autoLoad={false} />);

    expect(
      screen.getByText(
        /Team review requests are unavailable because the GitHub scope is missing/,
      ),
    ).toBeVisible();
    expect(screen.getAllByTestId("pull-request-row")).toHaveLength(1);
  });

  it("opens the focused Status and Repository filter menus", async () => {
    seedRows(2);
    const user = userEvent.setup();
    render(<PullRequestInbox autoLoad={false} />);

    const filterButton = screen.getByRole("button", {
      name: "Filter pull requests",
    });
    expect(filterButton.querySelector(".lucide-list-filter")).toBeVisible();
    await user.click(filterButton);

    const status = await screen.findByText("Status");
    expect(status).toBeVisible();
    const repository = screen.getByText("Repository");
    expect(repository).toBeVisible();
    expect(status.closest('[role="menuitem"]')).toHaveClass("cursor-pointer");
    expect(repository.closest('[role="menuitem"]')).toHaveClass(
      "cursor-pointer",
    );
    expect(screen.queryByText("Author")).not.toBeInTheDocument();
    expect(screen.queryByText("Review status")).not.toBeInTheDocument();
    expect(screen.queryByText("Checks")).not.toBeInTheDocument();

    await user.click(status);
    expect(
      await screen.findByRole("menuitemcheckbox", { name: "Open" }),
    ).toBeVisible();
    await user.keyboard("{ArrowLeft}");

    await user.click(repository);

    expect(
      await screen.findByRole("menuitemcheckbox", {
        name: "All repositories",
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("exposes open, closed, and merged as direct state filters", async () => {
    seedRows(1);
    const transport = fakeTransport();
    render(<PullRequestInbox autoLoad={false} transport={transport} />);

    const open = screen.getByRole("button", { name: /^open$/i });
    const closed = screen.getByRole("button", { name: /^closed$/i });
    const merged = screen.getByRole("button", { name: /^merged$/i });
    expect(open).toHaveAttribute("aria-pressed", "true");
    expect(closed).toHaveAttribute("aria-pressed", "false");
    expect(merged).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(closed);

    await waitFor(() => expect(transport.list).toHaveBeenCalledOnce());
    expect(vi.mocked(transport.list).mock.calls[0]?.[0].states).toEqual([
      "closed",
    ]);
    expect(closed).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("tablist", { name: "Pull request relationships" }),
    ).toHaveClass("items-center");
    expect(
      screen.getByRole("button", { name: "Refresh pull requests" }),
    ).not.toHaveClass("mb-1");
  });

  it("uses distinct icon shapes and tones for pull request states", () => {
    seedItems([
      summary(1),
      { ...summary(2), readiness: "draft" },
      { ...summary(3), state: "closed" },
      { ...summary(4), state: "merged" },
    ]);

    render(<PullRequestInbox autoLoad={false} />);

    const open = document.querySelector('[data-pull-request-state="open"]');
    const draft = document.querySelector('[data-pull-request-state="draft"]');
    const closed = document.querySelector('[data-pull-request-state="closed"]');
    const merged = document.querySelector('[data-pull-request-state="merged"]');

    expect(open).toHaveClass("text-[var(--diff-add-strong)]");
    expect(open?.querySelector(".lucide-git-pull-request")).toBeTruthy();
    expect(draft).toHaveClass("text-muted-foreground/75");
    expect(draft?.querySelector(".lucide-git-pull-request-draft")).toBeTruthy();
    expect(closed).toHaveClass("text-destructive/85");
    expect(
      closed?.querySelector(".lucide-git-pull-request-closed"),
    ).toBeTruthy();
    expect(merged).toHaveClass("text-violet-400");
    expect(merged?.querySelector(".lucide-git-merge")).toBeTruthy();
  });

  it("keeps unrelated row renders isolated", () => {
    seedRows(2);
    const firstKey = usePullRequestStore.getState().orderedKeys[0]!;
    const secondKey = usePullRequestStore.getState().orderedKeys[1]!;
    const renders = { first: 0, second: 0 };

    function Probe({
      identityKey,
      name,
    }: {
      identityKey: string;
      name: keyof typeof renders;
    }) {
      usePullRequestStore(selectPullRequestByKey(identityKey));
      renders[name] += 1;
      return <span>{name}</span>;
    }

    render(
      <>
        <Probe identityKey={firstKey} name="first" />
        <Probe identityKey={secondKey} name="second" />
      </>,
    );

    act(() => {
      usePullRequestStore.setState((state) => ({
        entities: {
          ...state.entities,
          [firstKey]: { ...state.entities[firstKey]!, title: "Updated title" },
        },
      }));
    });

    expect(renders.first).toBe(2);
    expect(renders.second).toBe(1);
  });
});
