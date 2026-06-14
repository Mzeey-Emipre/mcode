import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { GitDiffView } from "../GitDiffView";

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

const transport = vi.hoisted(() => ({
  getGitLog: vi.fn(),
  getCommitFiles: vi.fn(),
  getWorkingTreeFiles: vi.fn(),
  getBranchFiles: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

describe("GitDiffView commit selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      selectedCommitSha: "bbbbbbbb2",
      selectedFile: null,
      diffContent: null,
      diffLoading: false,
      inlineDiffCache: {},
      diffRevisionByScope: {},
      branchComparison: null,
      branchComparisonKey: null,
      renderMode: "unified",
    });
    transport.getCommitFiles.mockResolvedValue(["selected.ts"]);
  });

  it("renders the picked commit's files without resolving the latest commit again", async () => {
    render(<GitDiffView view="commit" workspaceId="ws-1" threadId="thread-1" />);

    await waitFor(() =>
      expect(transport.getCommitFiles).toHaveBeenCalledWith("ws-1", "bbbbbbbb2"),
    );

    expect(screen.getAllByText("selected.ts").length).toBeGreaterThan(0);
    expect(transport.getGitLog).not.toHaveBeenCalled();
  });

  it("does not refetch an immutable commit when the mutable diff revision changes", async () => {
    render(<GitDiffView view="commit" workspaceId="ws-1" threadId="thread-1" />);

    await waitFor(() => expect(transport.getCommitFiles).toHaveBeenCalledTimes(1));

    act(() => {
      useDiffStore.getState().bumpDiffRevision("thread-1");
    });

    expect(transport.getCommitFiles).toHaveBeenCalledTimes(1);
  });

  it("waits for the picker when no commit has been resolved", async () => {
    useDiffStore.setState({ selectedCommitSha: null });

    render(<GitDiffView view="commit" workspaceId="ws-1" threadId="thread-1" />);

    await waitFor(() => expect(screen.getByText("No commit yet")).toBeInTheDocument());

    expect(transport.getCommitFiles).not.toHaveBeenCalled();
    expect(transport.getGitLog).not.toHaveBeenCalled();
  });
});

describe("GitDiffView mutable branch reloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      branchComparison: {
        base: "feat/current",
        target: "origin/main",
        refs: [],
        isUnborn: false,
      },
      branchComparisonKey: "ws-1:thread-1",
      diffRevisionByScope: {},
      inlineDiffCache: {},
      renderMode: "unified",
    });
    transport.getBranchFiles.mockResolvedValue(["changed.ts"]);
  });

  it("refetches the branch file list when the diff scope revision changes", async () => {
    render(<GitDiffView view="branch" workspaceId="ws-1" threadId="thread-1" />);

    await waitFor(() =>
      expect(transport.getBranchFiles).toHaveBeenCalledWith(
        "ws-1",
        "origin/main",
        "feat/current",
        "thread-1",
      ),
    );

    act(() => {
      useDiffStore.getState().bumpDiffRevision("thread-1");
    });

    await waitFor(() => expect(transport.getBranchFiles).toHaveBeenCalledTimes(2));
  });
});
