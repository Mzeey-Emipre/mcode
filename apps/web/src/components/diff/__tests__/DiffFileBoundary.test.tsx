import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { FileList } from "../FileList";

vi.mock("@/hooks/useOpenInApps", () => ({
  useOpenInApps: () => [],
}));

vi.mock("@/hooks/useDiffHighlighter", () => ({
  useDiffHighlighter: () => ({ getLineTokens: () => null }),
}));

describe("FileList file cards", () => {
  beforeEach(() => {
    useDiffStore.setState({
      inlineDiffCache: {},
      renderMode: "unified",
      lineWrapByThread: {},
    });
  });

  it("renders each changed file in a spaced card shell", () => {
    render(
      <FileList
        files={["apps/web/src/alpha.ts", "apps/web/src/beta.ts"]}
        source="snapshot"
        id="snap-1"
        threadId="thread-1"
      />,
    );

    expect(screen.getAllByTestId("diff-file-card")).toHaveLength(2);
  });
});
