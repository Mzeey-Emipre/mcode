import { describe, expect, it, vi } from "vitest";
import { createConversationResidency } from "@/stores/conversation-residency";

describe("ConversationResidency", () => {
  const requiredDeps = () => ({
    refreshConversation: vi.fn().mockResolvedValue(undefined),
    retainInactiveConversation: vi.fn(),
    invalidateConversation: vi.fn(),
    synchronizeConversation: vi.fn(),
    mergeCachedFileChanges: vi.fn(),
    takePrefetchedHistoryPage: vi.fn(),
    prefetchConversation: vi.fn().mockResolvedValue(undefined),
  });

  it("activates only persisted selected threads through its restoration dependency", async () => {
    const restoreConversation = vi.fn().mockResolvedValue(undefined);
    const deactivateConversation = vi.fn();
    const residency = createConversationResidency({ restoreConversation, deactivateConversation, ...requiredDeps() });

    await residency.activate("thread-a", [{ id: "thread-a" }]);

    expect(restoreConversation).toHaveBeenCalledWith("thread-a");
    expect(deactivateConversation).not.toHaveBeenCalled();
  });

  it.each([
    [null, []],
    ["missing-thread", []],
    ["preparing-thread", [{ id: "preparing-thread", clientPreparing: true }]],
    ["failed-thread", [{ id: "failed-thread", clientError: "Creation failed" }]],
  ])("deactivates without restoring unavailable selection %s", async (threadId, threads) => {
    const restoreConversation = vi.fn().mockResolvedValue(undefined);
    const deactivateConversation = vi.fn();
    const residency = createConversationResidency({ restoreConversation, deactivateConversation, ...requiredDeps() });

    await residency.activate(threadId, threads);

    expect(restoreConversation).not.toHaveBeenCalled();
    expect(deactivateConversation).toHaveBeenCalledOnce();
  });

  it("routes forced selected-conversation revalidation through its refresh dependency", async () => {
    const restoreConversation = vi.fn().mockResolvedValue(undefined);
    const refreshConversation = vi.fn().mockResolvedValue(undefined);
    const residency = createConversationResidency({
      restoreConversation,
      deactivateConversation: vi.fn(),
      ...requiredDeps(),
      refreshConversation,
    });

    await residency.refresh("thread-a", [{ id: "thread-a" }]);

    expect(refreshConversation).toHaveBeenCalledWith("thread-a");
    expect(restoreConversation).not.toHaveBeenCalled();
  });

  it("routes event retention, persisted invalidation, pagination, and prefetch through one boundary", async () => {
    const restoreConversation = vi.fn().mockResolvedValue(undefined);
    const deactivateConversation = vi.fn();
    const retainInactiveConversation = vi.fn();
    const invalidateConversation = vi.fn();
    const synchronizeConversation = vi.fn();
    const mergeCachedFileChanges = vi.fn();
    const prefetchConversation = vi.fn().mockResolvedValue(undefined);
    const residency = createConversationResidency({
      restoreConversation,
      deactivateConversation,
      retainInactiveConversation,
      invalidateConversation,
      synchronizeConversation,
      mergeCachedFileChanges,
      prefetchConversation,
      refreshConversation: vi.fn().mockResolvedValue(undefined),
      takePrefetchedHistoryPage: vi.fn(),
    });
    residency.invalidateConversation("thread-a");
    residency.retainInactiveConversation("thread-a");
    residency.commitPagination("thread-a");
    residency.mergePaginationFileChanges("thread-a", { message: ["src/a.ts"] });
    await residency.prefetch("thread-a");

    expect(invalidateConversation).toHaveBeenCalledOnce();
    expect(retainInactiveConversation).toHaveBeenCalledWith("thread-a");
    expect(synchronizeConversation).toHaveBeenCalledWith("thread-a");
    expect(mergeCachedFileChanges).toHaveBeenCalledWith("thread-a", { message: ["src/a.ts"] });
    expect(prefetchConversation).toHaveBeenCalledWith("thread-a");
  });
});
