import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedDiffLine } from "@/lib/diff-parser";
import { useDiffStore } from "@/stores/diffStore";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { UnifiedDiff } from "../UnifiedDiff";

vi.mock("@/hooks/useDiffHighlighter", () => ({
  useDiffHighlighter: () => ({ getLineTokens: () => null }),
}));

vi.mock("@/hooks/useTheme", () => ({
  useShikiTheme: () => "github-dark",
}));

const lines: ParsedDiffLine[] = [
  { type: "remove", content: "const state = oldState;", oldLineNo: 10, newLineNo: null },
  { type: "add", content: "const state = nextState;", oldLineNo: null, newLineNo: 11 },
];

describe("UnifiedDiff Dev review", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useDiffStore.setState({ lineWrapByThread: {} });
    usePreviewAnnotationStore.setState({
      byThread: {},
      diffByThread: {},
      drafts: {},
    });
  });

  it("uses one PR-style gutter per line", () => {
    render(<UnifiedDiff lines={lines} filePath="src/state.ts" />);

    const gutters = screen.getAllByTestId("dev-diff-gutter");
    expect(gutters).toHaveLength(2);
    expect(gutters[0]).toHaveTextContent("−10");
    expect(gutters[1]).toHaveTextContent("+11");
  });

  it("keeps the add-comment control opaque in dark mode hover", () => {
    render(<UnifiedDiff lines={lines} filePath="src/state.ts" />);

    expect(screen.getByRole("button", { name: "Add comment on line 11" })).toHaveClass(
      "dark:hover:bg-foreground",
      "dark:hover:text-background",
    );
  });

  it("adds a line comment to the thread composer annotation bundle", async () => {
    const user = userEvent.setup();
    render(<UnifiedDiff lines={lines} filePath="src/state.ts" />);

    await user.click(screen.getByRole("button", { name: "Add comment on line 11" }));
    await user.type(screen.getByRole("textbox", { name: "Code comment" }), "Keep this immutable");
    await user.click(screen.getByRole("button", { name: "Add to prompt" }));

    expect(usePreviewAnnotationStore.getState().buildBundle("thread-1")?.annotations).toMatchObject([
      {
        kind: "diff",
        filePath: "src/state.ts",
        side: "right",
        line: 11,
        lineContent: "const state = nextState;",
        note: "Keep this immutable",
      },
    ]);
    expect(screen.getByRole("button", { name: "Edit comment on line 11" })).toBeInTheDocument();
  });
});
