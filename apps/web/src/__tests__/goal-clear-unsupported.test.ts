import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalState } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import {
  resetThreadStoreForTests,
  seedThreadRecord,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import {
  cacheRecord,
  clearRecordCache,
  getCachedRecord,
} from "@/lib/thread-hydrator/record-cache";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const goal: GoalState = {
  threadId: "thread-unsupported",
  objective: "Clear stale unsupported goal",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
  providerId: "copilot",
  source: "mcode",
  controls: { canInspect: true, canClear: true },
};

describe("threadStore.clearThreadGoal", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests();
    vi.clearAllMocks();
  });

  it("applies unsupported authoritative null clear results to live and cached goal state", async () => {
    const threadId = "thread-unsupported";
    useThreadStore.setState({
      records: seedThreadRecord(threadId, { goal }),
    });
    cacheRecord(threadId, { ...createEmptyThreadRecord(), goal });
    (mockTransport.clearThreadGoal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      goal: null,
      authoritative: true,
      source: "unsupported",
      reason: "unsupported-provider",
    });

    await useThreadStore.getState().clearThreadGoal(threadId);

    expect(useThreadStore.getState().records.get(threadId)?.goal).toBeNull();
    expect(getCachedRecord(threadId)?.goal).toBeNull();
  });
});
