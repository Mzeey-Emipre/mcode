import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { FileList } from "../FileList";

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
  });
});
