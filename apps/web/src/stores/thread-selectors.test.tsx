import type { AgentEvent } from "@mcode/contracts";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useActiveThreadRecord } from "./thread-selectors";
import { useThreadStore } from "./threadStore";
import { resetThreadStoreForTests } from "./thread-store-test-utils";

describe("thread selectors", () => {
  beforeEach(() => {
    useThreadStore.setState({
      currentThreadId: "thread-1",
      records: new Map(),
    });
  });

  it("keeps an active selector stable while its record is not hydrated", () => {
    const { result, rerender } = renderHook(() => useActiveThreadRecord((record) => ({
      messages: record.messages,
      narrativeByMessage: record.narrativeByMessage,
    })));
    const initialSelection = result.current;

    expect(initialSelection).toEqual({ messages: [], narrativeByMessage: {} });
    rerender();
    expect(result.current).toBe(initialSelection);
  });

  it("notifies imperative and hook selectors when an agent event updates a record", () => {
    resetThreadStoreForTests({ currentThreadId: "thread-1" });
    const { result } = renderHook(() => useActiveThreadRecord((record) => record.runtimePhase));
    const transitions: Array<{ previous: string; current: string }> = [];
    const unsubscribe = useThreadStore.subscribe((current, previous) => {
      transitions.push({
        previous: previous.records.get("thread-1")?.runtimePhase ?? "idle",
        current: current.records.get("thread-1")?.runtimePhase ?? "idle",
      });
    });

    expect(result.current).toBe("idle");
    act(() => {
      useThreadStore.getState().handleAgentEvent({
        type: "turnStarted",
        threadId: "thread-1",
      } satisfies AgentEvent);
    });
    unsubscribe();

    expect(transitions).toEqual([{ previous: "idle", current: "running" }]);
    expect(result.current).toBe("running");
  });
});
