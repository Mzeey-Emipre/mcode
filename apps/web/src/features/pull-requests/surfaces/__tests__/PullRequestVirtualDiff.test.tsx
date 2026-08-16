import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PullRequestDiffFileRow,
  PullRequestDiffLineRow,
  PullRequestDiffRow,
} from "@/features/pull-requests/lib/pull-request-diff-row-model";
import { PullRequestVirtualDiff } from "../PullRequestVirtualDiff";

const virtualizerProbe = vi.hoisted(() => ({
  options: null as null | {
    count: number;
    overscan: number;
    getItemKey: (index: number) => unknown;
    estimateSize: (index: number) => number;
  },
  scrollToIndex: vi.fn(),
  measureElement: vi.fn(),
  visibleIndexes: null as number[] | null,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    overscan: number;
    getItemKey: (index: number) => unknown;
    estimateSize: (index: number) => number;
  }) => {
    virtualizerProbe.options = options;
    return {
      getVirtualItems: () =>
        (virtualizerProbe.visibleIndexes ?? Array.from({ length: options.count }, (_, index) => index)).map((index) => ({
          index,
          key: options.getItemKey(index),
          start: index * 30,
        })),
      getTotalSize: () => options.count * 30,
      scrollToIndex: virtualizerProbe.scrollToIndex,
      measureElement: virtualizerProbe.measureElement,
    };
  },
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    viewportRef,
    className,
    viewportProps,
  }: {
    children: React.ReactNode;
    viewportRef?: React.Ref<HTMLDivElement>;
    className?: string;
    viewportProps?: React.HTMLAttributes<HTMLDivElement>;
  }) => (
    <div
      ref={viewportRef}
      className={className}
      data-testid="diff-viewport"
      {...viewportProps}
    >
      {children}
    </div>
  ),
}));

vi.mock("@/features/pull-requests/hooks/usePullRequestDiffHighlighter", () => ({
  usePullRequestDiffHighlighter: () => ({
    getLineTokens: () => null,
    tokenBytes: 0,
    truncatedLineKeys: new Set(),
    pending: false,
  }),
}));

vi.mock("@/hooks/useTheme", () => ({
  useShikiTheme: () => "github-dark",
}));

const fileRow: PullRequestDiffFileRow = {
  kind: "file",
  key: "file-a",
  snapshotKey: "snapshot-a",
  file: {
    locator: "locator_a",
    path: "src/a.ts",
    previousPath: null,
    changeType: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    blobOid: "a".repeat(40),
    patchStatus: "available",
  },
  expanded: true,
  patchState: "available",
  threadCount: 0,
  draftCount: 0,
};

function line(index: number, hunkIndex: number): PullRequestDiffLineRow {
  return {
    kind: "line",
    key: `pr-l:test:${hunkIndex}:${index}`,
    path: "src/a.ts",
    hunkIndex,
    leftType: "remove",
    leftContent: `old ${index}`,
    leftLineNumber: index,
    rightType: "add",
    rightContent: `new ${index}`,
    rightLineNumber: index,
  };
}

const rows: PullRequestDiffRow[] = [
  fileRow,
  {
    kind: "hunk",
    key: "hunk-0",
    snapshotKey: "snapshot-a",
    path: "src/a.ts",
    hunkIndex: 0,
    label: "@@ -1 +1 @@",
    hiddenLineCount: 0,
  },
  line(1, 0),
  {
    kind: "hunk",
    key: "hunk-1",
    snapshotKey: "snapshot-a",
    path: "src/a.ts",
    hunkIndex: 1,
    label: "@@ -20 +20 @@",
    hiddenLineCount: 18,
  },
  line(20, 1),
];

function renderDiff(overrides: Partial<React.ComponentProps<typeof PullRequestVirtualDiff>> = {}) {
  const props: React.ComponentProps<typeof PullRequestVirtualDiff> = {
    rows,
    mode: "unified",
    isNarrow: false,
    activePath: "src/a.ts",
    onToggleFile: vi.fn(),
    onActivePathChange: vi.fn(),
    onCreateDraft: vi.fn(),
    onCreateReply: vi.fn(),
    onUpdateDraft: () => true,
    onRemoveDraft: vi.fn(),
    onTokenBytesChange: () => true,
    onReloadPatch: vi.fn(),
    ...overrides,
  };
  return { ...render(<PullRequestVirtualDiff {...props} />), props };
}

describe("PullRequestVirtualDiff", () => {
  beforeEach(() => {
    virtualizerProbe.options = null;
    virtualizerProbe.scrollToIndex.mockClear();
    virtualizerProbe.measureElement.mockClear();
    virtualizerProbe.visibleIndexes = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  it("exposes measured grid semantics and one tabbable active line", () => {
    renderDiff();

    const grid = screen.getByRole("grid", { name: "Pull request diff" });
    expect(grid).toHaveAttribute("aria-rowcount", "5");
    expect(grid).toHaveAttribute("aria-colcount", "1");
    expect(screen.getAllByRole("row").map((row) => row.getAttribute("aria-rowindex"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(document.querySelectorAll('[data-line-key][tabindex="0"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-diff-focus-key][tabindex="0"]')).toHaveLength(1);
    expect(screen.getByText("src/a.ts").closest("button")).toHaveAttribute("tabindex", "-1");
    expect(virtualizerProbe.options).toMatchObject({ count: 5, overscan: 3 });
    expect(virtualizerProbe.measureElement).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Removed Original line 1: old 1")).toBeVisible();
    expect(screen.getByLabelText("Added Current line 1: new 1")).toBeVisible();
    expect(screen.getAllByTestId("pull-request-diff-gutter")).toSatisfy(
      (gutters: HTMLElement[]) => gutters.every((gutter) => gutter.classList.contains("w-10")),
    );
    expect(screen.queryByText("@@ -1 +1 @@")).not.toBeInTheDocument();
    expect(screen.queryByText("@@ -20 +20 @@")).not.toBeInTheDocument();
    expect(screen.getByText("18 unchanged lines")).toBeVisible();
  });

  it("uses the fixed stacked height for unified replacement rows", () => {
    renderDiff();
    expect(virtualizerProbe.options?.estimateSize(1)).toBe(0);
    expect(virtualizerProbe.options?.estimateSize(2)).toBe(56);
    expect(virtualizerProbe.options?.estimateSize(3)).toBe(28);

    renderDiff({ mode: "split" });
    expect(virtualizerProbe.options?.estimateSize(2)).toBe(28);
  });

  it("omits zero-value change statistics from file rows", () => {
    renderDiff({
      rows: [
        {
          ...fileRow,
          file: {
            ...fileRow.file,
            additions: 0,
            deletions: 0,
            changes: 0,
          },
        },
      ],
    });

    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("−0")).not.toBeInTheDocument();
  });

  it("measures only variable-height rows", () => {
    renderDiff({
      rows: [
        {
          kind: "notice",
          key: "notice-a",
          snapshotKey: "snapshot-a",
          path: "src/a.ts",
          state: "loading",
          message: "Loading patch",
        },
      ],
    });

    expect(virtualizerProbe.measureElement).toHaveBeenCalledOnce();
  });

  it("moves between hunks with J and keeps the active line as the only tab stop", () => {
    renderDiff();
    const first = document.querySelector<HTMLElement>(
      '[data-line-key="pr-c:test:0:1:left:remove"]',
    );
    expect(first).not.toBeNull();
    first?.focus();
    fireEvent.keyDown(first!, { key: "j" });

    expect(document.activeElement).toHaveAttribute(
      "data-line-key",
      "pr-c:test:1:20:left:remove",
    );
    expect(virtualizerProbe.scrollToIndex).toHaveBeenCalledWith(4, { align: "auto" });
    expect(document.querySelectorAll('[data-line-key][tabindex="0"]')).toHaveLength(1);
  });

  it("uses one roving tab stop across file headers and diff lines", () => {
    renderDiff();
    const first = document.querySelector<HTMLElement>(
      '[data-line-key="pr-c:test:0:1:left:remove"]',
    );
    first?.focus();
    fireEvent.keyDown(first!, { key: "ArrowUp" });

    expect(document.activeElement).toBe(screen.getByText("src/a.ts").closest("button"));
    expect(document.querySelectorAll('[data-diff-focus-key][tabindex="0"]')).toHaveLength(1);
  });

  it("keeps a viewport tab stop when the active roving item is unmounted", async () => {
    virtualizerProbe.visibleIndexes = [0];
    renderDiff();

    const viewport = screen.getByTestId("diff-viewport");
    await waitFor(() => expect(viewport).toHaveAttribute("tabindex", "0"));
    viewport.focus();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText("src/a.ts").closest("button")),
    );
  });

  it("derives the fallback from mounted rows without scanning the full diff", () => {
    const largeRows: PullRequestDiffFileRow[] = Array.from(
      { length: 2_000 },
      (_, index) => ({
        ...fileRow,
        key: `file-${index}`,
        file: {
          ...fileRow.file,
          locator: `locator_${index}`,
          path: `src/file-${index}.ts`,
          blobOid: (index + 1).toString(16).padStart(40, "0"),
        },
      }),
    );
    virtualizerProbe.visibleIndexes = [largeRows.length - 1];
    const setHas = vi.spyOn(Set.prototype, "has");

    renderDiff({ rows: largeRows, activePath: largeRows[0]?.file.path ?? null });

    const setLookupCount = setHas.mock.calls.length;
    setHas.mockRestore();
    expect(setLookupCount).toBeLessThan(500);
  });

  it("creates a local draft through the active line keyboard path", () => {
    const onCreateDraft = vi.fn();
    renderDiff({ onCreateDraft });
    const first = document.querySelector<HTMLElement>(
      '[data-line-key="pr-c:test:0:1:left:remove"]',
    );
    first?.focus();
    fireEvent.keyDown(first!, { key: "c" });

    expect(onCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ key: "pr-l:test:0:1" }),
      expect.objectContaining({ key: "pr-c:test:0:1:left:remove" }),
    );
  });

  it("shows a large white add button on hover and on the active line", () => {
    const onCreateDraft = vi.fn();
    renderDiff({ onCreateDraft });
    const first = document.querySelector<HTMLElement>(
      '[data-line-key="pr-c:test:0:1:left:remove"]',
    );
    expect(first).not.toBeNull();

    const addComment = screen.getByRole("button", {
      name: "Draft comment on original line 1",
    });
    expect(addComment).toHaveClass(
      "absolute",
      "left-0.5",
      "top-0.5",
      "size-6",
      "rounded-md",
      "bg-foreground",
      "hover:bg-foreground",
      "dark:hover:bg-foreground",
      "text-background",
      "group-hover/cell:opacity-100",
      "pointer-events-auto",
      "opacity-100",
    );
    expect(addComment.querySelector("svg")).toHaveClass("lucide-plus");
    expect(first).toHaveClass("min-h-7");

    const hoverComment = screen.getByRole("button", {
      name: "Draft comment on current line 1",
    });
    expect(hoverComment).toHaveClass(
      "opacity-0",
      "group-hover/cell:pointer-events-auto",
      "group-hover/cell:opacity-100",
    );

    fireEvent.click(addComment);
    expect(onCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ key: "pr-l:test:0:1" }),
      expect.objectContaining({ key: "pr-c:test:0:1:left:remove" }),
    );
  });

  it("toggles a collapsed file without changing active path during focus", () => {
    const onToggleFile = vi.fn();
    const onActivePathChange = vi.fn();
    renderDiff({
      rows: [{ ...fileRow, expanded: false }],
      activePath: "src/other.ts",
      onToggleFile,
      onActivePathChange,
    });

    const fileButton = screen.getByText("src/a.ts").closest("button");
    expect(fileButton).not.toBeNull();
    fireEvent.focus(fileButton!);
    fireEvent.click(fileButton!);

    expect(onActivePathChange).not.toHaveBeenCalled();
    expect(onToggleFile).toHaveBeenCalledOnce();
  });

  it("falls back from split to unified in a narrow pane", () => {
    renderDiff({ mode: "split", isNarrow: true });

    expect(screen.getByText("Split view needs a wider pane. Showing unified diff.")).toBeVisible();
    expect(screen.getByRole("grid", { name: "Pull request diff" })).toHaveAttribute(
      "aria-colcount",
      "1",
    );
    expect(screen.getByTestId("diff-viewport").parentElement).toHaveAttribute(
      "data-view-mode",
      "unified",
    );
  });

  it("offers an explicit reload for a patch evicted by the memory budget", () => {
    const onReloadPatch = vi.fn();
    renderDiff({
      rows: [
        {
          kind: "notice",
          key: "notice-evicted",
          snapshotKey: "snapshot-a",
          path: "src/a.ts",
          state: "evicted",
          message: "Patch unloaded to stay within the review memory limit.",
        },
      ],
      onReloadPatch,
    });

    fireEvent.click(screen.getByRole("button", { name: "Load patch again" }));
    expect(onReloadPatch).toHaveBeenCalledWith("src/a.ts");
  });

  it("offers an explicit retry for an independently failed patch", () => {
    const onReloadPatch = vi.fn();
    renderDiff({
      rows: [
        {
          kind: "notice",
          key: "notice-error",
          snapshotKey: "snapshot-a",
          path: "src/a.ts",
          state: "error",
          message: "Patch unavailable",
        },
      ],
      onReloadPatch,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry patch" }));
    expect(onReloadPatch).toHaveBeenCalledWith("src/a.ts");
  });
});
