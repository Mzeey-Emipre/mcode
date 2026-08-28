import { describe, expect, it, vi } from "vitest";
import {
  AgentEventType,
  type AgentEvent,
  type ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import { ParentNarrativeRecoveryCoordinator } from "../parent-narrative-recovery-coordinator.js";
import type { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import type { ParentTurnDurability } from "../parent-turn-durability.js";

const EXECUTION_ID = "execution-1";
const THREAD_ID = "thread-1";
const recoveryItems = [
  {
    kind: "narrationSegment",
    record: {
      id: "thought-1",
      message_id: "message-1",
      text: "Reasoning before the answer.",
      started_at: "2026-08-28T12:00:00.000Z",
      ended_at: null,
      sort_order: 1,
    },
  },
] satisfies ParentNarrativeRecoveryItem[];

describe("ParentNarrativeRecoveryCoordinator", () => {
  it("retries an uncommitted parent recovery snapshot before deduplicating it", () => {
    const recordParentNarrativeRecovery = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const durability = {
      loadTurnByExecution: vi.fn(() => ({ id: "turn-1" })),
      recordParentNarrativeRecovery,
    } as unknown as ParentTurnDurability;
    const narrativeStore = {
      recoverySnapshot: vi.fn(() => recoveryItems),
    } as unknown as NarrativeStore;
    const coordinator = new ParentNarrativeRecoveryCoordinator(durability, narrativeStore);
    const event: AgentEvent = {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID,
      delta: "Reasoning before the answer.",
    };
    const expectedCommit = {
      executionId: EXECUTION_ID,
      items: recoveryItems,
      discardedItemIds: [],
    };

    expect(() => coordinator.checkpoint(event)).toThrow(
      `Canonical parent turn was not found: ${EXECUTION_ID}`,
    );

    coordinator.checkpoint(event);
    coordinator.checkpoint(event);

    expect(recordParentNarrativeRecovery).toHaveBeenCalledTimes(2);
    expect(recordParentNarrativeRecovery).toHaveBeenNthCalledWith(1, expectedCommit);
    expect(recordParentNarrativeRecovery).toHaveBeenNthCalledWith(2, expectedCommit);
  });
});
