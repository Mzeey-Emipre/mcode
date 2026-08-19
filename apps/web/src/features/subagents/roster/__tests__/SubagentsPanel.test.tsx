import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalSubagentRoster, CanonicalSubagentRosterRow } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";

const harness = vi.hoisted(() => ({
  loadCanonicalSubagentRoster: vi.fn(),
  stopCanonicalSubagent: vi.fn(),
  residency: {
    mountDisplayConversation: vi.fn(),
    unmountDisplayConversation: vi.fn(),
  },
}));

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => ({
    loadCanonicalSubagentRoster: harness.loadCanonicalSubagentRoster,
    stopCanonicalSubagent: harness.stopCanonicalSubagent,
  }),
}));

vi.mock("@/features/conversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/conversation")>()),
  getConversationResidency: () => harness.residency,
  MessageList: ({ displayThreadId, showParentAgentProvenance }: { displayThreadId?: string; showParentAgentProvenance?: boolean }) => (
    <div data-testid="shared-message-list" data-display-thread-id={displayThreadId} data-show-parent-provenance={showParentAgentProvenance} />
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
    canStop: false,
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
    harness.stopCanonicalSubagent.mockReset().mockResolvedValue({ childThreadId: "canonical-child", status: "interrupted" });
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

  it("shows only the formatted identity and roster metadata", async () => {
    const child = canonicalRow({
      id: "direct-detail-child",
      identity: "direct_detail_worker",
      task: "Read only README.md and return the full summary",
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([], [child]));

    render(<SubagentsPanel threadId="thread-1" />);

    const row = await screen.findByTestId("subagent-finished-row");
    expect(row).toHaveTextContent("Direct detail worker");
    expect(row).not.toHaveTextContent("direct_detail_worker");
    expect(row).not.toHaveTextContent("Read only README.md and return the full summary");
  });

  it("opens a chat-selected child when the canonical row arrives after the first roster read", async () => {
    const child = canonicalRow({
      id: "canonical-delayed-child",
      sourceItemId: "toolCall:live-agent-call",
      identity: "Delayed child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
    });
    harness.loadCanonicalSubagentRoster
      .mockResolvedValueOnce(canonicalRoster([], []))
      .mockResolvedValue(canonicalRoster([child], [], 2));
    useDiffStore.setState({
      subagentDetailByThread: {
        "thread-1": { id: "live-agent-call", originTab: "active", scrollTop: 0 },
      },
      subagentReviewScopeByThread: {},
    });
    let poll: (() => void) | undefined;
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1_500) poll = () => callback();
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });

    render(<SubagentsPanel threadId="thread-1" />);
    try {
      await screen.findByTestId("subagents-empty");
      expect(useDiffStore.getState().subagentDetailByThread["thread-1"]?.id).toBe("live-agent-call");
      expect(poll).toBeDefined();
      poll!();
      await waitFor(() => expect(harness.loadCanonicalSubagentRoster).toHaveBeenCalledTimes(2));

      expect(await screen.findByTestId("shared-message-list")).toHaveAttribute(
        "data-display-thread-id",
        "canonical-delayed-child",
      );
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
    expect(activeRow[1]).toHaveTextContent("Ancestor child");
    expect(activeRow[1]).not.toHaveTextContent("Parent / Ancestor child");
    expect(screen.getByText("Active descendant")).toBeInTheDocument();
    const completedButton = screen.getByRole("button", { name: /Open Completed child details, Completed/ });
    expect(completedButton.querySelector("time")).toHaveAttribute("dateTime", completed.endedAt);
    expect(screen.getByRole("button", { name: /Open Interrupted child details, Interrupted/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Errored child details, Errored/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Unknown child details, Idle/ })).not.toHaveTextContent("Completed");
  });

  it("shows relative last activity for done children without repeating the active section state", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const active = canonicalRow({
      id: "active-relative-time",
      identity: "Working child",
      activityState: "Active",
      latestTurnStatus: "Running",
      endedAt: null,
      terminalOutcome: null,
    });
    const completed = canonicalRow({
      id: "completed-relative-time",
      identity: "Completed child",
      updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      endedAt: fiveMinutesAgo,
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([active], [completed]));

    render(<SubagentsPanel threadId="thread-1" />);

    const activeRow = await screen.findByRole("button", { name: /Open Working child details, Active/ });
    expect(activeRow).not.toHaveTextContent("Active");
    expect(screen.getByText("5m ago")).toHaveAttribute("dateTime", completed.endedAt);
  });

  it("hides Stop when a child is not active or cannot stop", async () => {
    const activeButUnsupported = canonicalRow({
      id: "active-unsupported",
      identity: "Active unsupported",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: false,
    });
    const doneButEligible = canonicalRow({
      id: "done-eligible",
      identity: "Done eligible",
      canStop: true,
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([activeButUnsupported], [doneButEligible]));

    render(<SubagentsPanel threadId="thread-1" />);

    await screen.findByRole("button", { name: /Open Active unsupported details, Active/ });
    expect(screen.queryByTestId("subagent-stop-control")).not.toBeInTheDocument();
  });

  it("uses the same shared Stop control in the roster and detail", async () => {
    const child = canonicalRow({
      id: "shared-control-child",
      identity: "Shared control child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: true,
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([child], []));

    render(<SubagentsPanel threadId="thread-1" />);

    expect(await screen.findByTestId("subagent-stop-control")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open Shared control child details, Active/ }));
    expect(await screen.findByTestId("subagent-stop-control")).toBeInTheDocument();
  });

  it("keeps lifecycle controls out of the detail header", async () => {
    const child = canonicalRow({
      id: "detail-layout-child",
      identity: "Detail layout child",
      lineage: ["thread-1", "ancestor", "detail-layout-child"],
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: true,
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([child], []));

    render(<SubagentsPanel threadId="thread-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Open Detail layout child details, Active/ }));

    const detail = await screen.findByRole("region", { name: "Detail layout child subagent details" });
    const header = detail.querySelector("header");
    const stop = screen.getByRole("button", { name: "Stop Detail layout child" });
    expect(header).toBeTruthy();
    expect(header).toHaveTextContent("Detail layout child");
    expect(header).toHaveTextContent("ancestor");
    expect(header).not.toHaveTextContent("Parent");
    expect(header).toHaveTextContent("GPT-5.6 Sol · High");
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.queryByText("Canonical ID:")).not.toBeInTheDocument();
    expect(screen.queryByText("Provider identity provenance:")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-detail-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("subagent-detail-actions")).toContainElement(stop);
    expect(screen.getByTestId("shared-message-list")).toHaveAttribute("data-show-parent-provenance", "false");
    expect(header?.contains(stop)).toBe(false);
  });

  it("passes exact parent and child IDs without selecting the child", async () => {
    const child = canonicalRow({
      id: "exact-child",
      parentThreadId: "owner-parent",
      rootThreadId: "owner-parent",
      owningParentThreadId: "owner-parent",
      identity: "Exact child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: true,
    });
    const interrupted = canonicalRow({
      ...child,
      activityState: "Idle",
      latestTurnStatus: "Interrupted",
      terminalOutcome: "Interrupted",
      canStop: false,
    });
    harness.loadCanonicalSubagentRoster
      .mockResolvedValueOnce(canonicalRoster([child], []))
      .mockResolvedValueOnce(canonicalRoster([], [interrupted], 2));
    harness.stopCanonicalSubagent.mockResolvedValue({ childThreadId: "exact-child", status: "interrupted" });

    render(<SubagentsPanel threadId="thread-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop Exact child" }));

    await waitFor(() => expect(harness.stopCanonicalSubagent).toHaveBeenCalledWith("owner-parent", "exact-child"));
    expect(useDiffStore.getState().subagentDetailByThread["thread-1"]).toBeUndefined();
    await waitFor(() => expect(screen.getByRole("button", { name: /Open Exact child details, Interrupted/ })).toBeInTheDocument());
  });

  it("prevents duplicate stop commands while the request is pending", async () => {
    const child = canonicalRow({
      id: "pending-child",
      identity: "Pending child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: true,
    });
    const result = deferred<{ childThreadId: string; status: "interrupted" }>();
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([child], []));
    harness.stopCanonicalSubagent.mockReturnValue(result.promise);

    render(<SubagentsPanel threadId="thread-1" />);
    const stop = await screen.findByRole("button", { name: "Stop Pending child" });
    fireEvent.click(stop);
    fireEvent.click(stop);

    expect(harness.stopCanonicalSubagent).toHaveBeenCalledTimes(1);
    expect(stop).toBeDisabled();
    expect(screen.getByText("Stopping…")).toBeInTheDocument();
    result.resolve({ childThreadId: "pending-child", status: "interrupted" });
    await waitFor(() => expect(stop).toBeEnabled());
  });

  it.each([
    ["failed", "Stop failed: Provider rejected stop"],
    ["unsupported", "Stop unavailable: Child stopping is not supported"],
  ] as const)("keeps a %s result explicit", async (status, message) => {
    const child = canonicalRow({
      id: `${status}-child`,
      identity: `${status} child`,
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: true,
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([child], []));
    harness.stopCanonicalSubagent.mockResolvedValue({ childThreadId: child.id, status, message: message.split(": ")[1] });

    render(<SubagentsPanel threadId="thread-1" />);
    const displayedIdentity = `${status.charAt(0).toUpperCase()}${status.slice(1)} child`;
    fireEvent.click(await screen.findByRole("button", { name: `Stop ${displayedIdentity}` }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(/Stopped successfully/)).not.toBeInTheDocument();
  });

  it("does not render internal details from a rejected stop request", async () => {
    const child = canonicalRow({
      id: "rejected-child",
      identity: "Rejected child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: true,
    });
    const secret = String.raw`provider-token=secret-shaped-value path=C:\private\workspace\token.txt`;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([child], []));
    harness.stopCanonicalSubagent.mockRejectedValue(new Error(secret));

    try {
      render(<SubagentsPanel threadId="thread-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Stop Rejected child" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Stop failed: The child did not stop.");
      expect(alert).not.toHaveTextContent(secret);
      expect(consoleError).toHaveBeenCalledWith("Canonical subagent stop failed");
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(["interrupted", "already-terminal"] as const)("refreshes the roster after %s and preserves selected detail", async (stopStatus) => {
    const child = canonicalRow({
      id: "detail-stop-child",
      identity: "Detail stop child",
      activityState: "Active",
      latestTurnStatus: "Running",
      terminalOutcome: null,
      canStop: true,
    });
    const terminal = canonicalRow({
      ...child,
      activityState: "Idle",
      latestTurnStatus: stopStatus === "already-terminal" ? "Completed" : "Interrupted",
      terminalOutcome: stopStatus === "already-terminal" ? "Completed" : "Interrupted",
      canStop: false,
    });
    harness.loadCanonicalSubagentRoster
      .mockResolvedValueOnce(canonicalRoster([child], []))
      .mockResolvedValueOnce(canonicalRoster([], [terminal], 2));
    harness.stopCanonicalSubagent.mockResolvedValue({ childThreadId: child.id, status: stopStatus });

    render(<SubagentsPanel threadId="thread-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Open Detail stop child details, Active/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop Detail stop child" }));

    await waitFor(() => expect(screen.queryByTestId("subagent-detail-actions")).not.toBeInTheDocument());
    expect(screen.queryByTestId("subagent-detail-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-detail-actions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subagent-stop-control")).not.toBeInTheDocument();
    expect(screen.getByTestId("shared-message-list")).toHaveAttribute("data-display-thread-id", "detail-stop-child");
    expect(useDiffStore.getState().subagentDetailByThread["thread-1"]?.id).toBe("detail-stop-child");
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

  it("resolves a timeline Agent call to its canonical detail after roster load", async () => {
    const child = canonicalRow({
      id: "canonical-timeline-child",
      sourceItemId: "toolCall:raw-agent-call",
      identity: "Timeline child",
      activityState: "Idle",
      latestTurnStatus: "Completed",
      terminalOutcome: "Completed",
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([], [child]));
    useDiffStore.setState({
      subagentDetailByThread: {
        "thread-1": { id: "raw-agent-call", scrollTop: 0 },
      },
      subagentReviewScopeByThread: {},
    });

    render(<SubagentsPanel threadId="thread-1" />);

    expect(await screen.findByTestId("shared-message-list")).toHaveAttribute(
      "data-display-thread-id",
      "canonical-timeline-child",
    );
    expect(screen.getByRole("region", { name: "Timeline child subagent details" })).toBeInTheDocument();
    await waitFor(() => expect(useDiffStore.getState().subagentDetailByThread["thread-1"]).toMatchObject({
      id: "raw-agent-call",
      originTab: "finished",
    }));
  });

  it("resolves a provider-native child thread selection to its canonical detail", async () => {
    const child = canonicalRow({
      id: "canonical-provider-child",
      identity: "Provider child",
      providerIdentities: [{
        providerId: "codex",
        scope: "thread",
        value: "native-provider-child",
        provenance: "native",
      }],
    });
    harness.loadCanonicalSubagentRoster.mockResolvedValue(canonicalRoster([], [child]));
    useDiffStore.setState({
      subagentDetailByThread: {
        "thread-1": { id: "native-provider-child", originTab: "finished", scrollTop: 0 },
      },
      subagentReviewScopeByThread: {},
    });

    render(<SubagentsPanel threadId="thread-1" />);

    expect(await screen.findByTestId("shared-message-list")).toHaveAttribute(
      "data-display-thread-id",
      "canonical-provider-child",
    );
    expect(screen.getByRole("region", { name: "Provider child subagent details" })).toBeInTheDocument();
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
