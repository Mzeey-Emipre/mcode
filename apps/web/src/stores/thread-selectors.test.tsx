import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useActiveThreadRecord } from "./thread-selectors";
import { useThreadStore } from "./threadStore";

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
});
