import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewComparison, TurnSnapshot } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { DiffPanel } from "../DiffPanel";

let measuredWidth = 900;
const transport = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn().mockResolvedValue(["src/App.tsx", "README.md"]),
  watchWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
  listSnapshots: vi.fn().mockResolvedValue([]),
  getSnapshotDiffStats: vi.fn().mockResolvedValue([]),
  getTurnDiffComparison: vi.fn().mockResolvedValue(null),
  getCumulativeDiffStats: vi.fn().mockResolvedValue([]),
  getReviewComparison: vi.fn().mockResolvedValue({ files: [], additions: 0, deletions: 0 }),
}));

vi.mock("@/hooks/useElementWidth", () => ({
  useElementWidth: () => measuredWidth,
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../DiffToolbar", () => ({
  DiffToolbar: ({
    filesVisible,
    onToggleFiles,
  }: {
    filesVisible: boolean;
    onToggleFiles: () => void;
  }) => (
    <button type="button" aria-pressed={filesVisible} onClick={onToggleFiles}>
      Files
    </button>
  ),
}));

vi.mock("../WorktreeFilesPane", () => ({
  WorktreeFilesPane: ({ files }: { files: readonly { path: string }[] }) => (
    <aside data-testid="worktree-files">{files.map((file) => file.path).join(",")}</aside>
  ),
}));

vi.mock("../LastTurnView", () => ({
  LastTurnView: ({ comparison, cacheVersion, refreshing, onRefresh }: {
    comparison: ReviewComparison | null;
    cacheVersion: string | number;
    refreshing: boolean;
    onRefresh: () => void;
  }) => (
    <section data-testid="snapshot-diff" data-snapshot-id={comparison?.turnDiff?.id ?? ""} data-cache-version={cacheVersion}>
      {comparison?.files.map((file) => file.path).join(",")}
      <button type="button" onClick={onRefresh} disabled={refreshing}>Refresh snapshot</button>
      {refreshing ? <span>Refreshing snapshot comparison</span> : null}
    </section>
  ),
}));
vi.mock("../CumulativeView", () => ({
  CumulativeView: ({ comparison, cacheVersion, turnCount, refreshing, onRefresh }: {
    comparison: ReviewComparison | null;
    cacheVersion: string | number;
    turnCount: number;
    refreshing: boolean;
    onRefresh: () => void;
  }) => (
    <section data-testid="cumulative-diff" data-cache-version={cacheVersion} data-turn-count={turnCount}>
      {comparison?.files.map((file) => file.path).join(",")}
      <button type="button" onClick={onRefresh} disabled={refreshing}>Refresh cumulative</button>
      {refreshing ? <span>Refreshing cumulative comparison</span> : null}
    </section>
  ),
}));
vi.mock("../FileList", () => ({
  FileList: ({ files, refreshing, onRefresh }: { files: string[]; refreshing: boolean; onRefresh: () => void }) => (
    <section data-testid="diff-files">
      {files.join(",")}
      <button type="button" onClick={onRefresh}>Refresh</button>
      {refreshing ? <span>Refreshing comparison</span> : null}
    </section>
  ),
}));

describe("DiffPanel worktree files", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
    return { promise, resolve, reject };
  }

  function snapshot(id: string, path: string): TurnSnapshot {
    return {
      id,
      thread_id: "thread-1",
      ref_before: `${id}-before`,
      ref_after: `${id}-after`,
      files_changed: [path],
      created_at: "2026-07-20T12:00:00.000Z",
    } as TurnSnapshot;
  }

  function stats(path: string) {
    return [{ filePath: path, additions: 1, deletions: 0 }];
  }
  function comparison(id: string, path: string): ReviewComparison {
    return { files: [{ path, previousPath: null, changeType: "modified", binary: false }], additions: 1, deletions: 0,
      turnDiff: { id, phase: "settled", source: "native", fidelity: "agent", revision: 1 } };
  }
  beforeEach(() => {
    measuredWidth = 900;
    vi.clearAllMocks();
    transport.listSnapshots.mockReset().mockResolvedValue([]);
    transport.getSnapshotDiffStats.mockReset().mockResolvedValue([]);
    transport.getTurnDiffComparison.mockReset().mockResolvedValue(null);
    transport.getCumulativeDiffStats.mockReset().mockResolvedValue([]);
    transport.getReviewComparison.mockReset().mockResolvedValue({ files: [], additions: 0, deletions: 0 });
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
      activeWorkspaceId: "workspace-1",
    });
    useDiffStore.setState({
      viewMode: "last-turn",
      snapshotsByThread: { "thread-1": [] },
      snapshotsLoadingByThread: {},
      snapshotsPendingByThread: {},
      diffRevisionByScope: {},
      reviewFilesVisibleByScope: {},
    });
  });

  it("starts closed at wide widths and never requests the full worktree", async () => {
    render(<DiffPanel />);

    await screen.findByTestId("snapshot-diff");

    expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it.each([false, true])("finishes the first snapshot load so native Last turn can render, failed=%s", async (failed) => {
    useDiffStore.setState({ snapshotsByThread: {} });
    const firstLoad = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReturnValueOnce(firstLoad.promise);
    transport.getTurnDiffComparison.mockResolvedValue(comparison("native-1", "agent.ts"));
    render(<DiffPanel />);
    expect(useDiffStore.getState().snapshotsLoadingByThread["thread-1"]).toBe(true);
    if (failed) firstLoad.reject(new Error("Snapshot list unavailable"));
    else firstLoad.resolve([]);
    await waitFor(() => expect(useDiffStore.getState().snapshotsLoadingByThread["thread-1"]).toBe(false));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("agent.ts"));
    transport.getTurnDiffComparison.mockResolvedValue(comparison("native-2", "refreshed.ts"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("refreshed.ts"));
  });

  it("hides invalidated Live files until the fresh comparison request settles", async () => {
    const live: ReviewComparison = { ...comparison("live-1", "live.ts"),
      turnDiff: { id: "live-1", phase: "live", source: "native", fidelity: "agent", revision: 1 } };
    const reconnect = deferred<ReviewComparison>();
    transport.getTurnDiffComparison.mockResolvedValueOnce(live).mockReturnValueOnce(reconnect.promise);
    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("live.ts"));
    act(() => { useDiffStore.getState().bumpDiffRevision("thread-1"); });
    expect(screen.queryByText("live.ts")).not.toBeInTheDocument();
    reconnect.resolve(comparison("settled-1", "settled.ts"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("settled.ts"));
    expect(screen.getByTestId("snapshot-diff")).not.toHaveTextContent("live.ts");
  });

  it("starts closed in a compact diff and opens from the same toggle", async () => {
    measuredWidth = 640;
    const user = userEvent.setup();
    render(<DiffPanel />);

    expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Files" }));

    await waitFor(() => expect(screen.getByTestId("worktree-files")).toBeInTheDocument());
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("publishes one matching diff and Files result after a controlled refresh", async () => {
    const first = deferred<{ files: { path: string; previousPath: null; changeType: "modified"; binary: false }[]; additions: number; deletions: number }>();
    const second = deferred<{ files: { path: string; previousPath: null; changeType: "modified"; binary: false }[]; additions: number; deletions: number }>();
    transport.getReviewComparison.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useWorkspaceStore.setState({ activeThreadId: null, activeWorkspaceId: "workspace-1" });
    useDiffStore.setState({ viewMode: "unstaged" });
    const user = userEvent.setup();

    render(<DiffPanel />);
    first.resolve({ files: [{ path: "old.ts", previousPath: null, changeType: "modified", binary: false }], additions: 1, deletions: 0 });
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts"));
    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(transport.getReviewComparison).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("diff-files")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");
    expect(screen.getByText("Refreshing comparison")).toBeInTheDocument();

    second.resolve({ files: [{ path: "new.ts", previousPath: null, changeType: "modified", binary: false }], additions: 2, deletions: 1 });
    await waitFor(() => expect(screen.getByTestId("diff-files")).toHaveTextContent("new.ts"));
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("new.ts");
    expect(transport.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("keeps Last turn identity, diff, and Files atomic through refresh success and comparison failure", async () => {
    const oldSnapshot = snapshot("snapshot-old", "old.ts");
    const nextSnapshot = snapshot("snapshot-next", "next.ts");
    const failedSnapshot = snapshot("snapshot-failed", "failed.ts");
    const initialStats = deferred<ReviewComparison>();
    const nextList = deferred<TurnSnapshot[]>();
    const nextStats = deferred<ReviewComparison>();
    const failedList = deferred<TurnSnapshot[]>();
    const failedStats = deferred<ReviewComparison>();
    transport.getTurnDiffComparison.mockReset()
      .mockReturnValueOnce(initialStats.promise)
      .mockReturnValueOnce(nextStats.promise)
      .mockReturnValueOnce(failedStats.promise);
    transport.listSnapshots.mockReset()
      .mockReturnValueOnce(nextList.promise)
      .mockReturnValueOnce(failedList.promise);
    useDiffStore.setState({
      viewMode: "last-turn",
      snapshotsByThread: { "thread-1": [oldSnapshot] },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);
    initialStats.resolve(comparison("snapshot-old", "old.ts"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveAttribute("data-snapshot-id", "snapshot-old"));
    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    nextList.resolve([nextSnapshot]);
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("snapshot-diff")).toHaveAttribute("data-snapshot-id", "snapshot-old");
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    nextStats.resolve(comparison("snapshot-next", "next.ts"));
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveAttribute("data-snapshot-id", "snapshot-next"));
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("next.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");

    await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    failedList.resolve([failedSnapshot]);
    await waitFor(() => expect(transport.getTurnDiffComparison).toHaveBeenCalledTimes(3));
    failedStats.reject(new Error("stats failed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh snapshot" })).toBeEnabled());
    expect(screen.getByTestId("snapshot-diff")).toHaveAttribute("data-snapshot-id", "snapshot-next");
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("next.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");
  });

  it("keeps All turns cache identity, diff, and Files atomic through refresh success and stats failure", async () => {
    const oldSnapshot = snapshot("snapshot-old", "old.ts");
    const nextSnapshot = snapshot("snapshot-next", "next.ts");
    const failedSnapshot = snapshot("snapshot-failed", "failed.ts");
    const initialStats = deferred<ReturnType<typeof stats>>();
    const nextList = deferred<TurnSnapshot[]>();
    const nextStats = deferred<ReturnType<typeof stats>>();
    const failedList = deferred<TurnSnapshot[]>();
    const failedStats = deferred<ReturnType<typeof stats>>();
    transport.getCumulativeDiffStats.mockReset()
      .mockReturnValueOnce(initialStats.promise)
      .mockReturnValueOnce(nextStats.promise)
      .mockReturnValueOnce(failedStats.promise);
    transport.listSnapshots.mockReset()
      .mockReturnValueOnce(nextList.promise)
      .mockReturnValueOnce(failedList.promise);
    useDiffStore.setState({
      viewMode: "cumulative",
      snapshotsByThread: { "thread-1": [oldSnapshot] },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);
    initialStats.resolve(stats("old.ts"));
    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("old.ts"));
    await user.click(screen.getByRole("button", { name: "Files" }));
    const oldVersion = screen.getByTestId("cumulative-diff").getAttribute("data-cache-version");

    await user.click(screen.getByRole("button", { name: "Refresh cumulative" }));
    nextList.resolve([nextSnapshot]);
    await waitFor(() => expect(transport.getCumulativeDiffStats).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("cumulative-diff")).toHaveAttribute("data-cache-version", oldVersion);
    expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("old.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("old.ts");

    nextStats.resolve(stats("next.ts"));
    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("next.ts"));
    expect(screen.getByTestId("cumulative-diff")).not.toHaveAttribute("data-cache-version", oldVersion);
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");

    await user.click(screen.getByRole("button", { name: "Refresh cumulative" }));
    failedList.resolve([failedSnapshot]);
    await waitFor(() => expect(transport.getCumulativeDiffStats).toHaveBeenCalledTimes(3));
    failedStats.reject(new Error("stats failed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh cumulative" })).toBeEnabled());
    expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("next.ts");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("next.ts");
  });

  it("ignores an unresolved snapshot refresh after the active scope changes", async () => {
    transport.getTurnDiffComparison.mockResolvedValueOnce(comparison("snapshot-old", "old.ts"));
    const oldSnapshot = snapshot("snapshot-old", "old.ts");
    const staleList = deferred<TurnSnapshot[]>();
    transport.listSnapshots.mockReset().mockReturnValueOnce(staleList.promise);
    useDiffStore.setState({
      viewMode: "last-turn",
      snapshotsByThread: { "thread-1": [oldSnapshot] },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("old.ts"));
    await user.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    act(() => {
      useWorkspaceStore.setState({ activeThreadId: "thread-2" });
      useDiffStore.setState({ snapshotsByThread: { "thread-1": [oldSnapshot], "thread-2": [] } });
    });
    staleList.resolve([snapshot("snapshot-stale", "stale.ts")]);

    await waitFor(() => expect(useDiffStore.getState().snapshotsByThread["thread-1"]).toEqual([oldSnapshot]));
    expect(screen.queryByText("stale.ts")).not.toBeInTheDocument();
  });

  it("renders an authoritative subagent scope before aggregate comparison settles", async () => {
    const aggregateStats = deferred<ReturnType<typeof stats>>();
    transport.getCumulativeDiffStats.mockReset().mockReturnValueOnce(aggregateStats.promise);
    useDiffStore.setState({
      viewMode: "cumulative",
      snapshotsByThread: { "thread-1": [] },
      subagentReviewScopeByThread: {
        "thread-1": {
          label: "Explorer",
          paths: ["subagent-proof.txt"],
          additions: 1,
          deletions: 0,
        },
      },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);

    expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("subagent-proof.txt");
    expect(screen.getByText("Refreshing cumulative comparison")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("subagent-proof.txt");
    expect(useDiffStore.getState().reviewDiffStat).toEqual({ additions: 1, deletions: 0 });

    aggregateStats.resolve([]);
    await waitFor(() => expect(screen.queryByText("Refreshing cumulative comparison")).not.toBeInTheDocument());
    expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("subagent-proof.txt");
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("subagent-proof.txt");
  });

  it("replaces a settled scoped comparison without showing stale aggregate membership", async () => {
    const first = snapshot("snapshot-first", "first.ts");
    first.files_changed = ["first.ts", "second.ts"];
    transport.getCumulativeDiffStats.mockResolvedValue([
      { filePath: "first.ts", additions: 2, deletions: 0 },
      { filePath: "second.ts", additions: 3, deletions: 1 },
    ]);
    useDiffStore.setState({
      viewMode: "cumulative",
      snapshotsByThread: { "thread-1": [first] },
      subagentReviewScopeByThread: {
        "thread-1": {
          label: "Explorer",
          paths: ["first.ts"],
          additions: 2,
          deletions: 0,
        },
      },
    });

    render(<DiffPanel />);
    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("first.ts"));

    act(() => {
      useDiffStore.getState().setSubagentReviewScope("thread-1", {
        label: "Reviewer",
        paths: ["review-only.ts"],
        additions: 1,
        deletions: 0,
      });
    });

    expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("review-only.ts");
    expect(screen.getByTestId("cumulative-diff")).not.toHaveTextContent("first.ts");
    expect(screen.getByTestId("cumulative-diff")).not.toHaveTextContent("second.ts");
  });

  it("applies one subagent scope to both cumulative diff and Files navigation", async () => {
    const first = snapshot("snapshot-first", "first.ts");
    const second = snapshot("snapshot-second", "second.ts");
    first.files_changed = ["first.ts", "second.ts"];
    transport.getCumulativeDiffStats.mockResolvedValue([
      { filePath: "first.ts", additions: 2, deletions: 0 },
      { filePath: "second.ts", additions: 3, deletions: 1 },
    ]);
    useDiffStore.setState({
      viewMode: "cumulative",
      snapshotsByThread: { "thread-1": [first, second] },
      subagentReviewScopeByThread: {
        "thread-1": {
          label: "Explorer",
          paths: ["second.ts"],
          additions: 3,
          deletions: 1,
        },
      },
    });
    const user = userEvent.setup();

    render(<DiffPanel />);

    await waitFor(() => expect(screen.getByTestId("cumulative-diff")).toHaveTextContent("second.ts"));
    expect(screen.getByTestId("cumulative-diff")).not.toHaveTextContent("first.ts");
    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("worktree-files")).toHaveTextContent("second.ts");
    expect(screen.getByTestId("worktree-files")).not.toHaveTextContent("first.ts");
    expect(useDiffStore.getState().reviewDiffStat).toEqual({ additions: 3, deletions: 1 });
  });
});
