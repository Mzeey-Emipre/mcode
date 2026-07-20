import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitDiffView } from "../GitDiffView";

vi.mock("../FileList", () => ({
  FileList: ({ files, refreshable, refreshing }: { files: string[]; refreshable: boolean; refreshing: boolean }) => (
    <div data-testid="file-list" data-refreshable={refreshable} data-refreshing={refreshing}>{files.join(",")}</div>
  ),
}));

const resolved = {
  comparison: {
    files: [{ path: "selected.ts", previousPath: null, changeType: "modified" as const, binary: false }],
    additions: 1,
    deletions: 0,
  },
  source: "commit" as const,
  id: "bbbbbbbb2",
  cacheVersion: 0,
};

describe("GitDiffView", () => {
  it("renders one settled comparison and hides refresh for immutable commits", () => {
    render(<GitDiffView resolved={resolved} threadId="thread-1" loading={false} immutable onRefresh={vi.fn()} emptyLabel="No commit yet" />);

    expect(screen.getByTestId("file-list")).toHaveTextContent("selected.ts");
    expect(screen.getByTestId("file-list")).toHaveAttribute("data-refreshable", "false");
  });

  it("keeps the settled comparison visible while its replacement loads", () => {
    render(<GitDiffView resolved={resolved} threadId="thread-1" loading immutable={false} onRefresh={vi.fn()} emptyLabel="No changes" />);

    expect(screen.getByTestId("file-list")).toHaveTextContent("selected.ts");
    expect(screen.getByTestId("file-list")).toHaveAttribute("data-refreshing", "true");
  });
});
