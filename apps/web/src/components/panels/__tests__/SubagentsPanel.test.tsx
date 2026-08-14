import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalSubagentRoster, CanonicalSubagentRosterRow } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";

const harness = vi.hoisted(() => ({
  loadCanonicalSubagentRoster: vi.fn(),
  residency: {
    mountDisplayConversation: vi.fn(),
    unmountDisplayConversation: vi.fn(),
  },
}));

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => ({
    loadCanonicalSubagentRoster: harness.loadCanonicalSubagentRoster,
  }),
}));

vi.mock("@/stores/conversation-residency", async () => ({
  ...(await vi.importActual("@/stores/conversation-residency")),
  getConversationResidency: () => harness.residency,
}));

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: ({ displayThreadId }: { displayThreadId?: string }) => (
    <div data-testid="shared-message-list" data-display-thread-id={displayThreadId} />
  ),
}));

import { SubagentsPanel } from "../SubagentsPanel";

function canonicalRow(
  overrides: Partial<CanonicalSubagentRosterRow> = {},
): CanonicalSubagentRosterRow {
  return {
    id: "canonical-child",
    parentThreadId: "thread-1",
    rootThreadId: "thread-1",
    owningParentThreadId: "thread-1",
    lineage: ["thread-1", "canonical-child"],
    activityState: "Idle",
    latestTurnStatus: "Completed",
    startedAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:01:00.000Z",
    endedAt: "2026-08-14T10:01:00.000Z",
    terminalOutcome: "Completed",
    task: "Canonical task",
    identity: "Canonical worker",
    model: "gpt-5.6-sol",
    reasoning: "high",
    providerIdentities: [],
    sourceProviderIdentities: [],
    hasActiveDescendant: false,
    ...overrides,
  };
}

function canonicalRoster(
  active: CanonicalSubagentRosterRow[] = [],
  done: CanonicalSubagentRosterRow[] = active,
  rosterRevision = 1,
): CanonicalSubagentRoster {
  return {
    owningParentThreadId: "thread-1",
    rosterRevision,
    active,
    done,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SubagentsPanel", () => {
  beforeEach(() => {
    harness.loadCanonicalSubagentRoster.mockReset().mockRejectedValue(new Error("transport unavailable"));
    harness.residency.mountDisplayConversation.mockReset();
    harness.residency.unmountDisplayConversation.mockReset();
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useThreadStore.setState({ currentThreadId: "thread-1", records: new Map() });
    useDiffStore.setState({ subagentDetailByThread: {}, subagentReviewScopeByThread: {} });
  });

  it("does not render narrative-derived rows while the canonical roster is loading", () => {
    harness.loadCanonicalSubagentRoster.mockReturnValue(new Promise(() => undefined));

    render(<SubagentsPanel threadId="thread-1" />);

    expect(screen.getByTestId("subagents-loading")).toBeInTheDocument();
    expect(screen.queryByText("Legacy narrative task")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-roster-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-finished-row")).not.toBeInTheDocument();
  });

  it("uses a successful empty canonical roster instead of legacy rows", async () => {
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([], []));

    render(<SubagentsPanel threadId="thread-1" />);

    await waitFor(() => expect(screen.getByTestId("subagents-empty")).toBeInTheDocument());
    expect(screen.queryByText("Legacy narrative task")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-finished-row")).not.toBeInTheDocument();
  });

  it("shows an unavailable state instead of legacy rows when the canonical RPC fails", async () => {
    render(<SubagentsPanel threadId="thread-1" />);

    await waitFor(() => expect(screen.getByTestId("subagents-error")).toBeInTheDocument());
    expect(screen.getByText("Could not load subagents")).toBeInTheDocument();
    expect(screen.queryByText("Legacy narrative task")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-roster-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-finished-row")).not.toBeInTheDocument();
  });

  it("keeps canonical roster polling live after an empty response", async () => {
    const child = canonicalRow({
      id: "canonical-active",
      identity: "Active canonical",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
    });
    harness.loadCanonicalSubagentRoster
      .mockResolvedValueOnce(canonicalRoster([], []))
      .mockResolvedValue(canonicalRoster([child], []));
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      queueMicrotask(() => callback());
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });

    render(<SubagentsPanel threadId="thread-1" />);
    try {
      await waitFor(() => {
        expect(harness.loadCanonicalSubagentRoster).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId("subagent-roster-row")).toHaveTextContent("Active canonical");
      });
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("retains the last good roster and child lease after a polling failure", async () => {
    const child = canonicalRow({
      id: "canonical-refresh-failure",
      identity: "Refresh failure child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
    });
    harness.loadCanonicalSubagentRoster
      .mockResolvedValueOnce(canonicalRoster([child], []))
      .mockRejectedValueOnce(new Error("temporary transport failure"));
    let poll: (() => void) | undefined;
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      poll = () => callback();
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });

    render(<SubagentsPanel threadId="thread-1" />);
    try {
      const row = await screen.findByRole("button", { name: /Open Refresh failure child details, Active/ });
      fireEvent.click(row);
      expect(await screen.findByTestId("shared-message-list")).toHaveAttribute(
        "data-display-thread-id",
        "canonical-refresh-failure",
      );
      poll?.();
      await waitFor(() => expect(screen.getByTestId("shared-message-list")).toBeInTheDocument());
      expect(screen.queryByTestId("subagents-error")).not.toBeInTheDocument();
      expect(harness.residency.unmountDisplayConversation).not.toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("rejects an older overlapping roster response after a newer response wins", async () => {
    const staleChild = canonicalRow({ id: "stale-child", identity: "Stale child" });
    const newerChild = canonicalRow({ id: "newer-child", identity: "Newer child" });
    const first = deferred<CanonicalSubagentRoster>();
    const second = deferred<CanonicalSubagentRoster>();
    harness.loadCanonicalSubagentRoster
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    let poll: (() => void) | undefined;
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      poll = () => callback();
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });

    render(<SubagentsPanel threadId="thread-1" />);
    try {
      poll?.();
      second.resolve(canonicalRoster([newerChild], [], 2));
      await screen.findByRole("button", { name: /Open Newer child details, Completed/ });
      first.resolve(canonicalRoster([staleChild], [], 1));
      await waitFor(() => expect(screen.getByRole("button", { name: /Open Newer child details, Completed/ })).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: /Open Stale child details/ })).not.toBeInTheDocument();
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("renders canonical rows in server order with lineage and exact outcomes", async () => {
    const active = canonicalRow({
      id: "active-child",
      identity: "Active child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
    });
    const completed = canonicalRow({ id: "completed-child", identity: "Completed child" });
    const interrupted = canonicalRow({
      id: "interrupted-child",
      identity: "Interrupted child",
      latestTurnStatus: "Interrupted",
      terminalOutcome: "Interrupted",
    });
    const errored = canonicalRow({
      id: "errored-child",
      identity: "Errored child",
      latestTurnStatus: "Errored",
      terminalOutcome: "Errored",
    });
    const unknown = canonicalRow({
      id: "unknown-child",
      identity: "Unknown child",
      latestTurnStatus: null,
      terminalOutcome: null,
    });
    const ancestor = canonicalRow({
      id: "ancestor-child",
      identity: "Ancestor child",
      lineage: ["thread-1", "ancestor-child"],
      activityState: "Idle",
      terminalOutcome: "Completed",
      hasActiveDescendant: true,
    });
    const nested = canonicalRow({
      id: "nested-child",
      identity: "Nested child",
      lineage: ["thread-1", "ancestor-child", "nested-child"],
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(
      canonicalRoster([active, nested], [completed, interrupted, errored, unknown, ancestor]),
    );

    render(<SubagentsPanel threadId="thread-1" />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open Active child details, Active/ })).toBeInTheDocument());
    const activeRow = screen.getAllByTestId("subagent-roster-row");
    expect(activeRow[0]).toHaveTextContent("Active child");
    expect(activeRow[1]).toHaveTextContent("Parent / Ancestor child");
    expect(screen.getByText("Active descendant")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Completed child details, Completed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Interrupted child details, Interrupted/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Errored child details, Errored/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Unknown child details, Idle/ })).not.toHaveTextContent("Completed");
  });

  it("opens canonical detail through the shared MessageList without changing the parent", async () => {
    const child = canonicalRow({
      id: "canonical-detail",
      identity: "Detail child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([child], []));

    render(<SubagentsPanel threadId="thread-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Open Detail child details, Active/ }));

    expect(await screen.findByTestId("shared-message-list")).toHaveAttribute(
      "data-display-thread-id",
      "canonical-detail",
    );
    expect(harness.residency.mountDisplayConversation).toHaveBeenCalledWith("canonical-detail");
    expect(useThreadStore.getState().currentThreadId).toBe("thread-1");
    expect(useWorkspaceStore.getState().activeThreadId).toBe("thread-1");
  });

  it("restores canonical roster focus and scroll position on Back", async () => {
    const child = canonicalRow({
      id: "canonical-back",
      identity: "Back child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([child], []));

    render(<SubagentsPanel threadId="thread-1" />);
    const row = await screen.findByRole("button", { name: /Open Back child details, Active/ });
    const viewport = screen.getByRole("region", { name: "Subagents" }).querySelector("[data-slot='scroll-area-viewport']") as HTMLDivElement;
    expect(viewport).toBeTruthy();
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 88 });
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: "Back to subagents" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Open Back child details, Active/ })).toHaveFocus());
    expect(viewport.scrollTop).toBe(88);
    expect(harness.residency.unmountDisplayConversation).toHaveBeenCalledWith("canonical-back");
  });
});
