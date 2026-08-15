import {
  resetThreadStoreForTests,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

/**
 * Regression coverage for issue #583: `/goal` control commands must not
 * participate in turn running-state. A control command never starts a
 * provider turn, so sending one must neither mark an idle thread running
 * nor (on send failure) clear the running-state of a real turn already in
 * flight. Pairing: the server drops the synthetic `Ended` for control forms
 * (see goal-command.test.ts) so the in-flight turn's running-state survives.
 */
describe("issue #583 — /goal control commands and running-state", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests({ runningThreadIds: new Set(), currentThreadId: null });
    vi.clearAllMocks();
  });

  it("does not mark an idle thread running when a /goal control command is sent", async () => {
    const threadId = "thread-1";

    await useThreadStore.getState().sendMessage(threadId, "/goal show");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(false);
  });

  it("still marks the thread running for the /goal SET form (it starts a turn)", async () => {
    const threadId = "thread-1";

    await useThreadStore.getState().sendMessage(threadId, "/goal ship the feature");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
  });

  it("leaves a real in-flight turn running when a control-command send fails", async () => {
    const threadId = "thread-1";
    useThreadStore.setState({ runningThreadIds: new Set([threadId]) });
    (
      mockTransport.sendMessage as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("spawn failed"));

    await useThreadStore.getState().sendMessage(threadId, "/goal clear");

    // The rollback must not clobber the running turn the control command
    // was issued against.
    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
  });
});
