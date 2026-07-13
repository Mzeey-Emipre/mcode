import type { PullRequestFile } from "@mcode/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestFileTree } from "../PullRequestFileTree";

const virtualizerSpies = vi.hoisted(() => ({
  estimatedSizes: [] as number[],
  measureElement: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    estimateSize?: (index: number) => number;
    getItemKey?: (index: number) => React.Key;
  }) => {
    virtualizerSpies.estimatedSizes.push(options.estimateSize?.(0) ?? -1);
    return {
      getTotalSize: () => options.count * 32,
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 10) }, (_, index) => ({
          index,
          key: options.getItemKey?.(index) ?? index,
          start: index * 32,
        })),
      measureElement: virtualizerSpies.measureElement,
      scrollToIndex: vi.fn(),
    };
  },
}));

function file(path: string, index: number): PullRequestFile {
  return {
    locator: `file_${index}`,
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

describe("PullRequestFileTree", () => {
  beforeEach(() => {
    virtualizerSpies.estimatedSizes.length = 0;
    virtualizerSpies.measureElement.mockClear();
  });

  it("uses one roving tree focus and Enter activates a file", async () => {
    const onActivate = vi.fn();
    render(
      <PullRequestFileTree
        files={[file("a.ts", 1), file("b.ts", 2)]}
        activePath="a.ts"
        onActivate={onActivate}
      />,
    );
    const first = screen.getByRole("treeitem", { name: "Modified a.ts" });
    const second = screen.getByRole("treeitem", { name: "Modified b.ts" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");

    first.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(second).toHaveFocus();
    expect(onActivate).toHaveBeenCalledWith("b.ts");
  });

  it("expands and collapses directories with Right and Left", async () => {
    render(
      <PullRequestFileTree
        files={[file("apps/web/App.tsx", 1)]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );
    const apps = screen.getByRole("treeitem", { name: "apps/web/" });
    apps.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("treeitem", { name: "Modified apps/web/App.tsx" }),
    ).toBeInTheDocument();

    await userEvent.keyboard("{ArrowLeft}");
    expect(
      screen.queryByRole("treeitem", { name: "Modified apps/web/App.tsx" }),
    ).not.toBeInTheDocument();
  });

  it("mounts a bounded row window for a large flat Change stack", () => {
    const files = Array.from({ length: 80 }, (_, index) =>
      file(`file-${index}.ts`, index + 1),
    );
    render(
      <PullRequestFileTree
        files={files}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("treeitem")).toHaveLength(10);
    expect(screen.getByRole("treeitem", { name: "Modified file-0.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "Modified file-79.ts" })).not.toBeInTheDocument();
    expect(virtualizerSpies.estimatedSizes.at(-1)).toBe(32);
    expect(virtualizerSpies.measureElement).not.toHaveBeenCalled();
  });

  it("keeps the virtual tree reachable when its roving item is offscreen", async () => {
    const files = Array.from({ length: 80 }, (_, index) =>
      file(`file-${index}.ts`, index + 1),
    );
    render(
      <PullRequestFileTree
        files={files}
        activePath="file-79.ts"
        onActivate={vi.fn()}
      />,
    );

    const tree = screen.getByRole("tree", { name: "Pull request changed files" });
    expect(tree).toHaveAttribute("tabindex", "0");
    tree.focus();
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "Modified file-0.ts" })).toHaveFocus(),
    );
  });
});
