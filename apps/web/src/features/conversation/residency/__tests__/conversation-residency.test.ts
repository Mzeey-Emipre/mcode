import { describe, expect, it, vi } from "vitest";
import { createConversationResidency } from "../conversation-residency";

function deps() {
  return {
    restoreConversation: vi.fn().mockResolvedValue(undefined),
    refreshConversation: vi.fn().mockResolvedValue(undefined),
    deactivateConversation: vi.fn(),
    retainInactiveConversation: vi.fn(),
    invalidateConversation: vi.fn(),
    synchronizeConversation: vi.fn(),
    mergeCachedFileChanges: vi.fn(),
    takePrefetchedHistoryPage: vi.fn(),
    prefetchConversation: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ConversationResidency adjacent prefetch", () => {
  it("prefetches sorted neighbors only after valid activation", async () => {
    const dependencies = deps();
    const residency = createConversationResidency(dependencies);

    await residency.activate("t2", [
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ]);

    expect(
      dependencies.prefetchConversation.mock.calls.map(([id]) => id),
    ).toEqual(["t1", "t3"]);
  });

  it.each([
    [null, []],
    ["missing", [{ id: "t1" }]],
    ["preparing", [{ id: "preparing", clientPreparing: true }, { id: "t2" }]],
    ["failed", [{ id: "failed", clientError: "failed" }, { id: "t2" }]],
  ])(
    "does not prefetch neighbors for unavailable activation %s",
    async (selected, threads) => {
      const dependencies = deps();
      const residency = createConversationResidency(dependencies);

      await residency.activate(selected, threads);

      expect(dependencies.prefetchConversation).not.toHaveBeenCalled();
    },
  );

  it("does not schedule stale neighbors when a newer activation wins", async () => {
    const dependencies = deps();
    let resolveFirst!: () => void;
    dependencies.restoreConversation
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const residency = createConversationResidency(dependencies);
    const threads = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];

    const firstActivation = residency.activate("t2", threads);
    await residency.activate("t3", threads);
    resolveFirst();
    await firstActivation;

    expect(
      dependencies.prefetchConversation.mock.calls.map(([id]) => id),
    ).toEqual(["t2"]);
  });
});
