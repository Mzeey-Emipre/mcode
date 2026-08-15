import { describe, expect, it, vi } from "vitest";
import { createConversationResidency } from "../conversation-residency";

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
    residency.synchronizeConversation("thread-a");
    residency.mergePaginationFileChanges("thread-a", { message: ["src/a.ts"] });
    await residency.prefetch("thread-a");

    expect(invalidateConversation).toHaveBeenCalledOnce();
    expect(retainInactiveConversation).toHaveBeenCalledWith("thread-a");
    expect(synchronizeConversation).toHaveBeenCalledWith("thread-a");
    expect(mergeCachedFileChanges).toHaveBeenCalledWith("thread-a", { message: ["src/a.ts"] });
    expect(prefetchConversation).toHaveBeenCalledWith("thread-a");
  });

  it("owns overlapping page requests independently by complete thread identity", () => {
    const residency = createConversationResidency({
      restoreConversation: vi.fn().mockResolvedValue(undefined),
      deactivateConversation: vi.fn(),
      ...requiredDeps(),
    });
    const requestA = {
      threadId: "thread-a",
      cursor: { version: 1 as const, beforeSequence: 10 },
      direction: "older" as const,
      generation: 2,
      conversationRevision: 4,
    };
    const requestB = {
      threadId: "thread-b",
      cursor: { version: 1 as const, afterSequence: 10 },
      direction: "newer" as const,
      generation: 2,
      conversationRevision: 4,
    };

    const handleA = residency.beginHistoryPageRequest(requestA)!;
    const handleB = residency.beginHistoryPageRequest(requestB)!;

    expect(residency.beginHistoryPageRequest(requestA)).toBeUndefined();
    expect(residency.canCommitHistoryPageRequest(handleA, requestA)).toBe(true);
    expect(residency.canCommitHistoryPageRequest(handleB, requestB)).toBe(true);

    residency.invalidateConversation("thread-a");

    expect(residency.canCommitHistoryPageRequest(handleA, requestA)).toBe(false);
    expect(residency.canCommitHistoryPageRequest(handleB, requestB)).toBe(true);
    expect(residency.canCommitHistoryPageRequest(handleB, requestB, {
      ...requestB,
      threadId: "thread-a",
    })).toBe(false);
  });

  it("cancels another thread's page request when selection changes", async () => {
    const residency = createConversationResidency({
      restoreConversation: vi.fn().mockResolvedValue(undefined),
      deactivateConversation: vi.fn(),
      ...requiredDeps(),
    });
    const request = {
      threadId: "thread-a",
      cursor: { version: 1 as const, beforeSequence: 10 },
      direction: "older" as const,
      generation: 1,
      conversationRevision: 1,
    };
    const handle = residency.beginHistoryPageRequest(request)!;

    await residency.activate("thread-b", [{ id: "thread-a" }, { id: "thread-b" }]);

    expect(residency.canCommitHistoryPageRequest(handle, request)).toBe(false);
  });

  it("reference-counts display leases and coalesces resident refreshes", async () => {
    const hydrateDisplayConversation = vi.fn().mockResolvedValue(undefined);
    const refreshDisplayConversation = vi.fn().mockResolvedValue(undefined);
    const releaseDisplayConversation = vi.fn();
    const residency = createConversationResidency({
      restoreConversation: vi.fn().mockResolvedValue(undefined),
      deactivateConversation: vi.fn(),
      ...requiredDeps(),
      hydrateDisplayConversation,
      refreshDisplayConversation,
      releaseDisplayConversation,
      getSelectedConversationId: () => "parent",
    });

    residency.mountDisplayConversation("child");
    residency.mountDisplayConversation("child");
    expect(residency.isConversationVisible("child")).toBe(true);
    expect(hydrateDisplayConversation).toHaveBeenCalledOnce();

    const first = residency.refreshVisibleConversation("child");
    const second = residency.refreshVisibleConversation("child");
    expect(first).toBe(second);
    await first;
    residency.unmountDisplayConversation("child");
    expect(releaseDisplayConversation).not.toHaveBeenCalled();
    residency.unmountDisplayConversation("child");
    expect(residency.isConversationVisible("child")).toBe(false);
    expect(releaseDisplayConversation).toHaveBeenCalledOnce();
  });

  it("rejects a late lease response after release and accepts a new generation", () => {
    const hydrateDisplayConversation = vi.fn().mockResolvedValue(undefined);
    const residency = createConversationResidency({
      restoreConversation: vi.fn().mockResolvedValue(undefined),
      deactivateConversation: vi.fn(),
      ...requiredDeps(),
      hydrateDisplayConversation,
    });

    residency.mountDisplayConversation("child");
    const firstGeneration = hydrateDisplayConversation.mock.calls[0]?.[1];
    residency.unmountDisplayConversation("child");
    residency.mountDisplayConversation("child");
    const secondGeneration = hydrateDisplayConversation.mock.calls[1]?.[1];

    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    expect(residency.isDisplayLeaseCurrent("child", firstGeneration)).toBe(false);
    expect(residency.isDisplayLeaseCurrent("child", secondGeneration)).toBe(true);
  });
});
