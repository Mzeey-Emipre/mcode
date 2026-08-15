import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { createEmptyThreadRecord, getThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { SubagentsPanel } from "./SubagentsPanel";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => ({
    loadCanonicalSubagentRoster: vi.fn().mockResolvedValue({
      owningParentThreadId: "thread-1",
      rosterRevision: 1,
      active: [],
      done: [],
    }),
  }),
}));

describe("SubagentsPanel real thread store path", () => {
  beforeEach(() => {
    useDiffStore.setState({ subagentDetailByThread: {}, subagentReviewScopeByThread: {} });
    useThreadStore.setState({
      currentThreadId: "thread-1",
      records: new Map(),
    });
  });

  it("renders the canonical empty state while the thread record is not hydrated", async () => {
    expect(() => render(<SubagentsPanel threadId="thread-1" />)).not.toThrow();
    await waitFor(() => expect(screen.getByTestId("subagents-empty")).toBeInTheDocument());
  });

  it("survives a transient record missing hydrated narrative data", async () => {
    const record = createEmptyThreadRecord();
    const partialRecord = { ...record, narrativeByMessage: undefined } as unknown as typeof record;
    useThreadStore.setState({
      currentThreadId: "thread-1",
      records: new Map([["thread-1", partialRecord as typeof record]]),
    });

    expect(() => render(<SubagentsPanel threadId="thread-1" />)).not.toThrow();
    await waitFor(() => expect(screen.getByTestId("subagents-empty")).toBeInTheDocument());
  });

  it("normalizes null narrative data and pending persistence ids", () => {
    const record = createEmptyThreadRecord();
    const partialRecord = {
      ...record,
      narrativeByMessage: null,
      pendingTurnPersistMessageIds: null,
    } as unknown as typeof record;
    useThreadStore.setState({
      currentThreadId: "thread-1",
      records: new Map([["thread-1", partialRecord]]),
    });

    expect(() => render(<SubagentsPanel threadId="thread-1" />)).not.toThrow();
    const normalized = getThreadRecord(useThreadStore.getState().records, "thread-1");
    expect(normalized.narrativeByMessage).toEqual({});
    expect(normalized.pendingTurnPersistMessageIds).toEqual([]);
  });

  it("normalizes missing pending persistence ids when narrative data exists", () => {
    const record = createEmptyThreadRecord();
    const partialRecord = {
      ...record,
      pendingTurnPersistMessageIds: undefined,
    } as unknown as typeof record;
    useThreadStore.setState({
      currentThreadId: "thread-1",
      records: new Map([["thread-1", partialRecord]]),
    });

    expect(() => render(<SubagentsPanel threadId="thread-1" />)).not.toThrow();
    expect(
      getThreadRecord(useThreadStore.getState().records, "thread-1").pendingTurnPersistMessageIds,
    ).toEqual([]);
  });
});
