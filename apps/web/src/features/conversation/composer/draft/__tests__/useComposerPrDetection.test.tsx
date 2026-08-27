import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrDetail } from "@/transport/types";
import { useComposerPrDetection } from "../useComposerPrDetection";

const detectedPullRequest: PrDetail = {
  number: 42,
  title: "Improve Composer structure",
  branch: "refactor/composer",
  author: "octocat",
  url: "https://github.com/octo/repo/pull/42",
  state: "open",
};

describe("useComposerPrDetection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a lookup that resolves after the draft no longer contains its URL", async () => {
    vi.useFakeTimers();
    let resolveLookup: (pullRequest: PrDetail | null) => void = () => undefined;
    const lookup = vi.fn(
      () =>
        new Promise<PrDetail | null>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ input }) => useComposerPrDetection({ input, enabled: true, lookup }),
      { initialProps: { input: detectedPullRequest.url } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lookup).toHaveBeenCalledWith(detectedPullRequest.url);

    rerender({ input: "Review this change" });
    await act(async () => {
      resolveLookup(detectedPullRequest);
      await Promise.resolve();
    });

    expect(result.current.detectedPr).toBeNull();
  });
});
