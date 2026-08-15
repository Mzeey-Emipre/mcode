import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalState } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import {
  resetThreadStoreForTests,
  seedThreadRecord,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import {
  cacheRecord as cacheConversationRecord,
  clearRecordCache,
  getCachedRecord,
  projectConversationCacheState,
} from "@/features/conversation/hydration/record-cache";
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

function cacheRecord(threadId: string, record: ThreadRecord): void {
  cacheConversationRecord(threadId, projectConversationCacheState(record));
}

describe("threadStore.clearThreadGoal", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests();
    vi.clearAllMocks();
  });

  it("applies unsupported authoritative null clear results to resident goal state", async () => {
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
    expect(getCachedRecord(threadId)).not.toHaveProperty("goal");
  });

  it("preserves the resident goal for non-authoritative null clear results", async () => {
    const threadId = "thread-cache";
    useThreadStore.setState({
      records: seedThreadRecord(threadId, { goal }),
    });
    cacheRecord(threadId, { ...createEmptyThreadRecord(), goal });
    (mockTransport.clearThreadGoal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      goal: null,
      authoritative: false,
      source: "codex-cache",
      reason: "missing",
    });

    await useThreadStore.getState().clearThreadGoal(threadId);

    expect(useThreadStore.getState().records.get(threadId)?.goal).toEqual(goal);
    expect(getCachedRecord(threadId)).not.toHaveProperty("goal");
  });
});
