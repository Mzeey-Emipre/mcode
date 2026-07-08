import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { FileList } from "../FileList";

vi.mock("@tanstack/react-virtual", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useVirtualizer: (options: {
      count: number;
      getItemKey?: (index: number) => React.Key;
      estimateSize: () => number;
    }) => {
      const [anchor, setAnchor] = React.useState(0);
      const windowSize = Math.min(options.count, 10);
      const firstIndex = Math.min(anchor, Math.max(0, options.count - windowSize));
      const estimate = options.estimateSize();
      return {
        getTotalSize: () => options.count * estimate,
        getVirtualItems: () =>
          Array.from({ length: windowSize }, (_, offset) => {
            const index = firstIndex + offset;
            return {
              index,
              key: options.getItemKey?.(index) ?? index,
              start: index * estimate,
              size: estimate,
              end: (index + 1) * estimate,
            };
          }),
        measureElement: vi.fn(),
        scrollToIndex: (index: number) => setAnchor(index),
      };
    },
  };
});

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

vi.mock("@/hooks/useDiffHighlighter", () => ({
  useDiffHighlighter: () => ({ getLineTokens: () => null }),
}));

const transport = vi.hoisted(() => ({
  getSnapshotDiff: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => transport,
}));

describe("FileList jump to file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      inlineDiffCache: {},
      renderMode: "unified",
      lineWrapByThread: {},
    });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    class ResizeObserverMock {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    window.ResizeObserver = ResizeObserverMock;
    transport.getSnapshotDiff.mockResolvedValue(
      "diff --git a/apps/web/src/beta.ts b/apps/web/src/beta.ts\n@@ -1 +1 @@\n-old\n+new",
    );
  });

  it("opens autocomplete on demand and jumps without filtering the tree", async () => {
    render(
      <FileList
        files={["apps/web/src/alpha.ts", "apps/web/src/beta.ts"]}
        source="snapshot"
        id="snap-1"
        threadId="thread-1"
      />,
    );

    expect(screen.queryByTestId("review-file-filter")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("review-file-jump-trigger"));
    await userEvent.type(screen.getByTestId("review-file-filter"), "beta");
    await userEvent.click(screen.getByTestId("review-file-jump-item-apps/web/src/beta.ts"));

    expect(screen.getByText("alpha.ts")).toBeInTheDocument();
    expect(screen.getByText("beta.ts")).toBeInTheDocument();
    expect(screen.getAllByTestId("diff-file-card")).toHaveLength(2);
    expect(screen.queryByTestId("review-file-filter")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText("beta.ts").closest("[data-review-file]")).toHaveAttribute(
        "data-jump-highlight",
        "true",
      ),
    );

    await waitFor(() =>
      expect(transport.getSnapshotDiff).toHaveBeenCalledWith(
        "snap-1",
        "apps/web/src/beta.ts",
      ),
    );
  }, 15_000);

  it("mounts a bounded virtual window while jump keeps every file selectable", async () => {
    const files = Array.from(
      { length: 80 },
      (_, index) => `apps/web/src/file-${String(index).padStart(2, "0")}.ts`,
    );

    render(
      <div data-slot="scroll-area-viewport">
        <FileList
          files={files}
          source="snapshot"
          id="snap-1"
          threadId="thread-1"
        />
      </div>,
    );

    expect(screen.getAllByTestId("diff-file-card")).toHaveLength(10);
    expect(screen.getByText("file-00.ts")).toBeInTheDocument();
    expect(screen.queryByText("file-79.ts")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("review-file-jump-trigger"));
    expect(screen.getAllByTestId(/^review-file-jump-item-/)).toHaveLength(80);
    await userEvent.click(screen.getByTestId("review-file-jump-item-apps/web/src/file-79.ts"));

    await waitFor(() => expect(screen.getByText("file-79.ts")).toBeInTheDocument());
    expect(screen.getAllByTestId("diff-file-card")).toHaveLength(10);
    expect(screen.queryByText("file-00.ts")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText("file-79.ts").closest("[data-review-file]")).toHaveAttribute(
        "data-jump-highlight",
        "true",
      ),
    );
  }, 15_000);
});
