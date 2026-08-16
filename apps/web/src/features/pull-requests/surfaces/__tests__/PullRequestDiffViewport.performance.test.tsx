import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PullRequestFile, PullRequestPatchResult } from "@mcode/contracts";
import { buildPullRequestDiffRowModel } from "@/features/pull-requests/lib/pull-request-diff-row-model";
import { PullRequestVirtualDiff } from "../PullRequestVirtualDiff";

const performanceProbe = vi.hoisted(() => ({
  options: null as null | {
    count: number;
    overscan: number;
    getItemKey: (index: number) => unknown;
  },
  measureElement: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    overscan: number;
    getItemKey: (index: number) => unknown;
  }) => {
    performanceProbe.options = options;
    const mountedCount = Math.min(options.count, 18);
    return {
      getVirtualItems: () =>
        Array.from({ length: mountedCount }, (_, index) => ({
          index,
          key: options.getItemKey(index),
          start: index * 26,
        })),
      getTotalSize: () => options.count * 26,
      scrollToIndex: vi.fn(),
      measureElement: performanceProbe.measureElement,
    };
  },
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, viewportRef }: { children: React.ReactNode; viewportRef?: React.Ref<HTMLDivElement> }) => (
    <div ref={viewportRef}>{children}</div>
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

vi.mock("@/hooks/useTheme", () => ({ useShikiTheme: () => "github-dark" }));

function file(index: number): PullRequestFile {
  const path = `src/file-${index}.ts`;
  return {
    locator: `locator_${index}`,
    path,
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    blobOid: index.toString(16).padStart(40, "0"),
    patchStatus: "available",
  };
}

describe("PullRequestDiffViewport performance", () => {
  it("keeps 500 files and 20,000 lines below 500 mounted descendants", () => {
    const patchText = [
      "@@ -0,0 +1,19999 @@",
      ...Array.from({ length: 19_999 }, (_, index) => `+value ${index}`),
    ].join("\n");
    const firstFile = file(0);
    const patch: PullRequestPatchResult = {
      ok: true,
      locator: firstFile.locator,
      path: firstFile.path,
      previousPath: null,
      changeType: "modified",
      blobOid: firstFile.blobOid,
      baseOid: "b".repeat(40),
      headOid: "c".repeat(40),
      status: "available",
      patch: patchText,
      parsedLineCount: 20_000,
      fetchedAt: "2026-07-11T10:00:00.000Z",
      staleAt: "2026-07-11T10:10:00.000Z",
    };
    const model = buildPullRequestDiffRowModel({
      snapshotKey: "snapshot-a",
      headOid: "c".repeat(40),
      files: Array.from({ length: 500 }, (_, index) => ({
        file: index === 0 ? firstFile : file(index),
        expanded: index === 0,
        patchState: "available" as const,
        patchResult: index === 0 ? patch : null,
        threads: [],
        drafts: [],
      })),
    });
    const rows = model.rows;

    const { container } = render(
      <PullRequestVirtualDiff
        rows={rows}
        mode="unified"
        isNarrow={false}
        activePath="src/file-0.ts"
        onToggleFile={vi.fn()}
        onActivePathChange={vi.fn()}
        onCreateDraft={vi.fn()}
        onCreateReply={vi.fn()}
        onUpdateDraft={() => true}
        onRemoveDraft={vi.fn()}
        onTokenBytesChange={() => true}
        onReloadPatch={vi.fn()}
      />,
    );

    expect(performanceProbe.options).toMatchObject({ count: 20_500, overscan: 3 });
    expect(String(performanceProbe.options?.getItemKey(0))).toMatch(/^pr-f:/);
    expect(model.parsedBytesByLocator.get(firstFile.locator)).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    expect(screen.getByRole("grid", { name: "Pull request diff" })).toHaveAttribute(
      "aria-rowcount",
      "20500",
    );
    expect(container.querySelectorAll("*").length).toBeLessThan(500);
    expect(container.querySelectorAll('[role="row"]').length).toBe(18);
  });
});
