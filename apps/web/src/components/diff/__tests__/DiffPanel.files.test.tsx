import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { DiffPanel } from "../DiffPanel";

let measuredWidth = 900;
const transport = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn().mockResolvedValue(["src/App.tsx", "README.md"]),
  listSnapshots: vi.fn().mockResolvedValue([]),
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
  WorktreeFilesPane: ({ files }: { files: readonly string[] }) => (
    <aside data-testid="worktree-files">{files.join(",")}</aside>
  ),
}));

vi.mock("../LastTurnView", () => ({ LastTurnView: () => <div>Last turn</div> }));
vi.mock("../CumulativeView", () => ({ CumulativeView: () => <div>Cumulative</div> }));
vi.mock("../GitDiffView", () => ({ GitDiffView: () => <div>Git diff</div> }));

describe("DiffPanel worktree files", () => {
  beforeEach(() => {
    measuredWidth = 900;
    vi.clearAllMocks();
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
    });
  });

  it("opens the full worktree navigator by default when the diff has docked room", async () => {
    render(<DiffPanel />);

    await waitFor(() =>
      expect(transport.listWorkspaceFiles).toHaveBeenCalledWith(
        "workspace-1",
        "thread-1",
      ),
    );
    expect(screen.getByTestId("worktree-files")).toHaveTextContent(
      "README.md,src/App.tsx",
    );
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("starts closed in a compact diff and opens from the same toggle", async () => {
    measuredWidth = 640;
    const user = userEvent.setup();
    render(<DiffPanel />);

    expect(screen.queryByTestId("worktree-files")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Files" }));

    await waitFor(() => expect(screen.getByTestId("worktree-files")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
