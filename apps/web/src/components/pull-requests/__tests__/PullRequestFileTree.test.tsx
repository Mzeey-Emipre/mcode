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

function file(
  path: string,
  index: number,
  changeType: PullRequestFile["changeType"] = "modified",
): PullRequestFile {
  return {
    locator: `file_${index}`,
    path,
    previousPath: null,
    changeType,
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

  it("renders full worktree paths without pull request status metadata", async () => {
    const onActivate = vi.fn();
    render(
      <PullRequestFileTree
        filePaths={["apps/web/App.tsx", "packages/contracts/index.ts"]}
        activePath={null}
        ariaLabel="Worktree files"
        onActivate={onActivate}
      />,
    );

    const app = screen.getByRole("treeitem", { name: "apps/web/App.tsx" });
    app.focus();
    await userEvent.keyboard("{Enter}");

    expect(onActivate).toHaveBeenCalledWith("apps/web/App.tsx");
    expect(app.querySelector("[data-change-type]")).not.toBeInTheDocument();
  });

  it("expands and collapses directories with Right and Left", async () => {
    render(
      <PullRequestFileTree
        files={[file("apps/web/App.tsx", 1)]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );
    const apps = await screen.findByRole("treeitem", { name: "apps/web" });
    expect(
      screen.getByRole("treeitem", { name: "Modified apps/web/App.tsx" }),
    ).toBeInTheDocument();
    apps.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(
      screen.queryByRole("treeitem", { name: "Modified apps/web/App.tsx" }),
    ).not.toBeInTheDocument();

    await userEvent.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("treeitem", { name: "Modified apps/web/App.tsx" }),
    ).toBeInTheDocument();
  });

  it("reveals the full directory path when its label overflows", async () => {
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(240);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(80);
    try {
      render(
        <PullRequestFileTree
          files={[
            file(
              "QualtexTrade.IntegrationTests/Systems/WebApi/Services/Test.cs",
              1,
            ),
          ]}
          activePath={null}
          onActivate={vi.fn()}
        />,
      );

      const label = await screen.findByText(
        "QualtexTrade.IntegrationTests/Systems/WebApi/Services",
      );
      await userEvent.hover(label);

      await waitFor(() => expect(label).toHaveAttribute("data-popup-open"));
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it("uses a file icon while retaining the change type indicator", () => {
    render(
      <PullRequestFileTree
        files={[file("App.tsx", 1)]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );

    const row = screen.getByRole("treeitem", { name: "Modified App.tsx" });
    expect(row.querySelector('[data-file-icon="true"]')).toBeInTheDocument();
    expect(
      row.querySelector('[data-change-type="modified"]'),
    ).toHaveTextContent("M");
  });

  it("shows Review rename and binary metadata without line counts", () => {
    render(
      <PullRequestFileTree
        reviewFiles={[{
          path: "src/new.ts",
          previousPath: "src/old.ts",
          changeType: "renamed",
          binary: true,
        }]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );

    const row = screen.getByRole("treeitem", {
      name: "Renamed src/old.ts → src/new.ts, Binary",
    });
    expect(row).toHaveTextContent("src/old.ts → src/new.ts");
    expect(row).toHaveTextContent("Binary");
    expect(row.querySelector('[data-change-type="renamed"]')).toHaveTextContent("R");
    expect(row.querySelector('[aria-label$="additions"]')).not.toBeInTheDocument();
  });

  it("does not apply a persistent background to expanded folders", async () => {
    render(
      <PullRequestFileTree
        files={[file("apps/web/App.tsx", 1)]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );

    const folder = await screen.findByRole("treeitem", { name: "apps/web" });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(folder).toHaveClass("aria-expanded:bg-transparent");
  });

  it("reserves green and red for added and deleted file semantics", () => {
    render(
      <PullRequestFileTree
        files={[file("added.ts", 1, "added"), file("deleted.ts", 2, "deleted")]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );

    const added = screen.getByRole("treeitem", { name: "Added added.ts" });
    const deleted = screen.getByRole("treeitem", {
      name: "Deleted deleted.ts",
    });
    expect(added.querySelector('[data-change-type="added"]')).toHaveClass(
      "text-[var(--diff-add-strong)]",
    );
    expect(added.querySelector('[aria-label="1 additions"]')).toHaveClass(
      "text-[var(--diff-add-strong)]",
    );
    expect(deleted.querySelector('[data-change-type="deleted"]')).toHaveClass(
      "text-[var(--diff-remove-strong)]",
    );
    expect(deleted.querySelector('[aria-label="1 deletions"]')).toHaveClass(
      "text-[var(--diff-remove-strong)]",
    );
  });

  it("expands newly loaded directories without reopening user-collapsed ones", async () => {
    const view = render(
      <PullRequestFileTree
        files={[file("apps/web/App.tsx", 1)]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );
    const apps = await screen.findByRole("treeitem", { name: "apps/web" });
    apps.focus();
    await userEvent.keyboard("{ArrowLeft}");

    view.rerender(
      <PullRequestFileTree
        files={[file("apps/web/App.tsx", 1), file("docs/guide.md", 2)]}
        activePath={null}
        onActivate={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("treeitem", { name: "Modified apps/web/App.tsx" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("treeitem", { name: "Modified docs/guide.md" }),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("treeitem", { name: "Modified file-0.ts" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("treeitem", { name: "Modified file-79.ts" }),
    ).not.toBeInTheDocument();
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

    const tree = screen.getByRole("tree", {
      name: "Pull request changed files",
    });
    expect(tree).toHaveAttribute("tabindex", "0");
    tree.focus();
    await waitFor(() =>
      expect(
        screen.getByRole("treeitem", { name: "Modified file-0.ts" }),
      ).toHaveFocus(),
    );
  });
});
